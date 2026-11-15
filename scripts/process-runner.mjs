import { spawn } from "node:child_process";
import { lockChildEnvironment } from "./lock-child-env.mjs";
import { npmCommand } from "./npm-command.mjs";

const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 10_000;

/** 优雅停机预算（毫秒）：env `PIWEB_GRACEFUL_STOP_TIMEOUT_MS`，默认 10s。 */
export function gracefulStopTimeoutMs() {
	const raw = Number(process.env.PIWEB_GRACEFUL_STOP_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_GRACEFUL_STOP_TIMEOUT_MS;
}

function alreadyExited(child) {
	return (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode != null;
}

/** 等子进程退出；到点返回 false（不抛错）。 */
function waitForChildExit(child, timeoutMs) {
	if (alreadyExited(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let timer;
		const done = (exited) => { clearTimeout(timer); child.off("exit", onExit); child.off("close", onExit); resolve(exited); };
		const onExit = () => done(true);
		child.once("exit", onExit);
		child.once("close", onExit);
		timer = setTimeout(() => done(false), Math.max(1, timeoutMs));
		timer.unref?.();
	});
}

/**
 * Windows 上没有可捕获的进程信号：控制台 Ctrl+C 是发给整个控制台的，子进程已同时收到。
 * 这里再尽力发一次 taskkill `/T`（不带 `/F`）让带窗口的进程收 WM_CLOSE；失败就当没做。
 */
function requestWindowsClose(pid, timeoutMs) {
	return new Promise((resolve) => {
		let finished = false;
		const killer = spawn("taskkill", ["/PID", String(pid), "/T"], { stdio: "ignore", windowsHide: true });
		const done = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
		const timer = setTimeout(() => { killer.kill(); done(); }, Math.max(1, Math.min(3_000, timeoutMs)));
		timer.unref?.();
		killer.once("error", done);
		killer.once("close", done);
	});
}

/**
 * 优雅停机：先请求子进程自己收尾并等它退出，超时才回退到强杀整棵进程树。
 *
 * - POSIX：向子进程的进程组发 SIGTERM（可捕获，服务端 instrumentation 会先跑停机钩子），
 *   等待 `timeoutMs`；仍不退出才 SIGKILL 进程树。
 * - Windows：不向子进程发不可捕获的终止信号；先尽力请求正常关闭，等待同一预算，
 *   仍不退出才 taskkill /T /F（行为与原来的强制回收一致，只是多给了一个收尾窗口）。
 *
 * 只用于「因为要退出而停止我们自己的子进程」；命令超时/取消仍走 {@link terminateProcessTree}。
 */
export async function terminateProcessTreeGracefully(child, { timeoutMs = gracefulStopTimeoutMs(), signal = "SIGTERM" } = {}) {
	if (alreadyExited(child)) return;
	if (!child.pid) { child.kill(); return; }
	const startedAt = Date.now();
	if (process.platform === "win32") {
		await requestWindowsClose(child.pid, timeoutMs);
	} else {
		try { process.kill(-child.pid, signal); }
		catch { try { child.kill(signal); } catch { /* already gone */ } }
	}
	const remaining = timeoutMs - (Date.now() - startedAt);
	if (await waitForChildExit(child, remaining)) return;
	await terminateProcessTree(child);
}

/** Kill only the command tree that this helper started, never the serving app. */
export async function terminateProcessTree(child) {
	if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return;
	if (!child.pid) { child.kill(); return; }
	if (process.platform !== "win32") {
		try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		return;
	}
	await new Promise((resolve, reject) => {
		const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		let finished = false;
		const done = (error) => { if (finished) return; finished = true; clearTimeout(timer); if (error) { child.kill(); reject(error); } else resolve(); };
		const timer = setTimeout(() => { killer.kill(); done(new Error("Timed out terminating the command process tree; some descendants may still be running")); }, 10_000);
		killer.once("error", (error) => done(new Error("Could not terminate the command process tree", { cause: error })));
		killer.once("close", (code) => {
			if (code === 0) done();
			else done(new Error(`taskkill failed (${code}); the command process tree could not be confirmed stopped`));
		});
	});
}

/**
 * Fixed argument arrays, bounded output and whole-tree timeouts for update/build commands.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string, env?: Record<string, string | undefined>, timeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<string>}
 */
export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 600_000, signal, onStart }) {
	env = lockChildEnvironment(env);
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error("release cancelled")); return; }
		const invocation = command === "npm" ? npmCommand(args, env) : { command, args };
		const child = spawn(invocation.command, invocation.args, {
			cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		if (child.pid) {
			try { onStart?.(child.pid); }
			catch (error) { void terminateProcessTree(child).then(() => reject(error), reject); return; }
		}
		let errorOutput = "";
		let stopping = false;
		let settled = false;
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
		const fail = (error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
		const stop = (message) => {
			if (settled || stopping) return;
			stopping = true;
			void terminateProcessTree(child).then(() => fail(new Error(message)), fail);
		};
		const abort = () => stop("release cancelled; command process tree terminated");
		const timer = setTimeout(() => stop(`timeout after ${Math.round(timeoutMs / 1000)}s: ${command} ${args.join(" ")}`), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-256 * 1024); });
		child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-256 * 1024); });
		child.once("error", (error) => { if (!stopping) fail(error); });
		child.once("close", (code) => {
			if (stopping || settled) return;
			if (code !== 0) {
				const tail = (errorOutput || output || `exit code ${code}`).trim().slice(-1000);
				const error = new Error(tail);
				// 完整（最多 256KB）输出附在 error.output 上，调用方（如 build.mjs）可选择性打印，
				// 默认错误文案保持为原来的最后 1000 字符。
				error.output = errorOutput || output;
				error.exitCode = code;
				fail(error);
				return;
			}
			settled = true;
			cleanup();
			resolve(output);
		});
	});
}
