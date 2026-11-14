import { spawn } from "node:child_process";
import { lockChildEnvironment } from "./lock-child-env.mjs";
import { npmCommand } from "./npm-command.mjs";

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
			if (code !== 0) { fail(new Error((errorOutput || output || `exit code ${code}`).trim().slice(-1000))); return; }
			settled = true;
			cleanup();
			resolve(output);
		});
	});
}
