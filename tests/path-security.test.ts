import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeSessionId } from "../src/lib/pi";
import { BoundaryError, isPathInside, resolveSessionPath } from "../src/lib/path-security";

describe("filesystem boundaries", () => {
	it("distinguishes descendants from similarly prefixed siblings", () => {
		const root = path.resolve("test-root");
		expect(isPathInside(root, path.join(root, "child", "file.jsonl"))).toBe(true);
		expect(isPathInside(root, path.resolve(`${root}-other`, "file.jsonl"))).toBe(false);
	});

	it("does not treat an arbitrary encoded file as a Pi session", async () => {
		const id = encodeSessionId(path.resolve("package.json"));
		await expect(resolveSessionPath(id)).rejects.toBeInstanceOf(BoundaryError);
	});

	it("rejects existing and pending sessions through a directory link outside the store", async () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-session-boundary-"));
		try {
			const agentDir = path.join(root, "agent");
			const sessionsDir = path.join(agentDir, "sessions");
			const outside = path.join(root, "outside");
			await fs.mkdir(sessionsDir, { recursive: true });
			await fs.mkdir(outside);
			await fs.writeFile(path.join(outside, "existing.jsonl"), "{}");
			await fs.symlink(outside, path.join(sessionsDir, "linked"), process.platform === "win32" ? "junction" : "dir");
			process.env.PI_CODING_AGENT_DIR = agentDir;

			await expect(resolveSessionPath(encodeSessionId(path.join(sessionsDir, "linked", "existing.jsonl")))).rejects.toBeInstanceOf(BoundaryError);
			await expect(resolveSessionPath(encodeSessionId(path.join(sessionsDir, "linked", "pending.jsonl")), { allowPending: true })).rejects.toBeInstanceOf(BoundaryError);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
