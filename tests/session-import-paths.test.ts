import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeRoot, codexRoot, dshRoot, grokRoot, opencodeDb, zcodeDb } from "../src/lib/session-import/paths";

afterEach(() => vi.restoreAllMocks());
describe("real source path discovery", () => {
	it("resolves every source beneath the operating-system home even when the path contains spaces", () => {
		const home = path.resolve("isolated home", "用户");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		expect([claudeRoot(), codexRoot(), grokRoot(), dshRoot(), zcodeDb(), opencodeDb()]).toEqual([
			path.join(home, ".claude", "projects"), path.join(home, ".codex", "sessions"), path.join(home, ".grok", "sessions"),
			path.join(home, ".dsh", "sessions"), path.join(home, ".zcode", "cli", "db", "db.sqlite"), path.join(home, ".local", "share", "opencode", "opencode.db"),
		]);
	});
});
