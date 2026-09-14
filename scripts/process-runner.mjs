import { spawn } from "node:child_process";

/** Kill only the command tree that this helper started, never the serving app. */
async function terminateProcessTree(child) {
	if (!child.pid) { child.kill(); return; }
	if (process.platform !== "win32") {
		try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		return;
	}
	await new Promise((resolve) => {
		const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		const timer = setTimeout(() => { child.kill(); killer.kill(); resolve(); }, 10_000);
		const done = () => { clearTimeout(timer); resolve(); };
		killer.once("error", () => { child.kill(); done(); });
		killer.once("close", done);
	});
}

/**
 * Fixed argument arrays, bounded output and whole-tree timeouts for update/build commands.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string, env?: Record<string, string | undefined>, timeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<string>}
 */
export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 600_000, signal }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error("release cancelled")); return; }
		// Only npm needs cmd.exe to resolve npm.cmd. Never enable a general shell.
		const npmShell = process.platform === "win32" && command === "npm";
		const child = spawn(npmShell ? env.ComSpec || "cmd.exe" : command, npmShell ? ["/d", "/c", "npm", ...args] : args, {
			cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
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
