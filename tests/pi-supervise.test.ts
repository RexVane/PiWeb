import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ terminate: vi.fn(async () => {}) }));
vi.mock("../scripts/process-runner.mjs", () => ({ terminateProcessTreeGracefully: mocks.terminate }));
import { supervise } from "../bin/pi.js";
const previousExitCode = process.exitCode;
afterEach(() => { process.exitCode = previousExitCode; vi.restoreAllMocks(); mocks.terminate.mockClear(); });
it("handles a spawn error without waiting for an exit event and removes its signal listeners", () => {
	const child = new EventEmitter(); const before = process.listenerCount("SIGTERM");
	vi.spyOn(console, "error").mockImplementation(() => {});
	supervise(child); expect(process.listenerCount("SIGTERM")).toBe(before + 1);
	child.emit("error", new Error("ENOENT fixture"));
	expect(process.exitCode).toBe(1); expect(process.listenerCount("SIGTERM")).toBe(before);
});
it("asks the owned process tree to stop gracefully on every supported platform", async () => {
	const child = new EventEmitter(); const before = new Set(process.listeners("SIGTERM"));
	supervise(child);
	const handler = process.listeners("SIGTERM").find((listener) => !before.has(listener))!;
	handler("SIGTERM"); await Promise.resolve();
	expect(mocks.terminate).toHaveBeenCalledWith(child);
	child.emit("exit", 0);
});
