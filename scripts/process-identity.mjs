import fs from "node:fs";
import path from "node:path";
import { runtimeRequire } from "./runtime-require.mjs";
import { spawnSync } from "node:child_process";

let windowsApi;
function windowsPowerShell(command) {
	const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 5000, encoding: "utf8" });
	const value = result.stdout?.trim();
	return result.status === 0 && /^\d+$/.test(value) ? value : null;
}

function nativeWindowsBirth(pid) {
	if (windowsApi === undefined) {
		try {
			const koffi = runtimeRequire(import.meta.url)("koffi");
			const kernel = koffi.load("kernel32.dll");
			windowsApi = {
				open: kernel.func("void *OpenProcess(uint32 access, bool inherit, uint32 pid)"),
				times: kernel.func("bool GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)"),
				close: kernel.func("bool CloseHandle(void *handle)"),
			};
		} catch { windowsApi = null; }
	}
	if (!windowsApi) return null;
	const handle = windowsApi.open(0x1000, false, pid);
	if (!handle) return null;
	try {
		const times = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
		return windowsApi.times(handle, ...times) ? times[0].readBigUInt64LE().toString() : null;
	} finally { windowsApi.close(handle); }
}

/** PID plus operating-system creation identity; inaccessible processes fail closed. */
export function processIdentity(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: undefined, birth: null };
	try { process.kill(pid, 0); }
	catch (error) { return { alive: error.code === "ESRCH" ? false : true, birth: null }; }
	try {
		if (process.platform === "win32") {
			const birth = nativeWindowsBirth(pid) ?? windowsPowerShell(`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`);
			return { alive: true, birth: birth ? `win:${birth}` : null };
		}
		if (process.platform === "linux") {
			const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
			const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			return { alive: true, birth: /^\d+$/.test(fields[19]) ? `linux:${boot}:${fields[19]}` : null };
		}
		const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000 });
		return { alive: true, birth: result.status === 0 && result.stdout.trim() ? `${process.platform}:${result.stdout.trim()}` : null };
	} catch { return { alive: true, birth: null }; }
}

/** An unknown identity cannot prove that a live owner disappeared. */
export function processIdentityAlive(pid, birth) {
	const current = processIdentity(pid);
	if (!current.alive || typeof birth !== "string") return current.alive;
	if (current.birth !== null) return current.birth === birth;
	if (process.platform === "win32" && /^win:\d+$/.test(birth)) {
		// A recycled PID can now belong to a service we cannot open directly.
		// The system inventory is less precise than GetProcessTimes, so only a
		// clearly later creation time proves the recorded process is gone.
		const comparison = windowsPowerShell(`$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($process.CreationDate) { $process.CreationDate.ToUniversalTime().ToFileTimeUtc() }`);
		if (comparison && BigInt(comparison) > BigInt(birth.slice(4)) + 10_000_000n) return false;
	}
	return current.alive;
}
