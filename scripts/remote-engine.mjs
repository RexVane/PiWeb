/** A private IPC watchdog owns the engine even if the Next parent is force-killed. */
import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process-runner.mjs";
import { isolatedCommandEnv } from "./update-environment.mjs";
import { isMainModule } from "./entrypoint.mjs";
if (isMainModule(import.meta.url)) {
	const [binary, ...args] = process.argv.slice(2);
	if (!binary || !process.connected) throw new Error("remote engine must be started by the PiWeb supervisor");
	const scripted = /\.(?:cjs|mjs|js)$/i.test(binary);
	const env = { ...isolatedCommandEnv(process.env), PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	const engine = spawn(scripted ? process.execPath : binary, scripted ? [binary, ...args] : args, {
		env, stdio: "inherit", windowsHide: true,
	});
	let stopping = false;
	const stop = async () => {
		if (stopping) return; stopping = true;
		if (process.platform !== "win32") {
			// Reap the direct child before killing the whole process group so callers
			// waiting on watchdog exit do not observe an unreaped reparented zombie.
			if (engine.exitCode === null && engine.signalCode === null && engine.pid) {
				await new Promise((resolve) => {
					let done = false;
					const finish = () => { if (!done) { done = true; clearTimeout(timer); engine.off("exit", finish); resolve(); } };
					const timer = setTimeout(finish, 1500);
					engine.once("exit", finish);
					try { engine.kill("SIGKILL"); } catch { finish(); }
				});
			}
			// The supervisor creates this watchdog's own process group; its engine
			// and descendants inherit it, so no unrelated process can be targeted.
			try { process.kill(-process.pid, "SIGKILL"); return; } catch { /* Fall back for a test harness without a process group. */ }
		}
		try { await terminateProcessTree(engine); }
		catch (error) { console.error(`[piweb] ${error.message}`); process.exitCode = 1; return; }
		process.exit(0);
	};
	process.once("disconnect", () => { void stop(); });
	process.once("SIGINT", () => { void stop(); });
	process.once("SIGTERM", () => { void stop(); });
	engine.once("error", (error) => {
		const message = { type: "engine-error", code: error.code, message: error.message };
		if (process.connected) process.send(message, () => process.exit(127)); else void stop();
	});
	engine.once("exit", (code) => { if (!stopping) process.exit(code ?? 1); });
}
