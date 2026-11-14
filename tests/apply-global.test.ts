import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { applyGlobalSources } from "../scripts/apply-global.mjs";
import { recycleFixture } from "./lib/sandbox/fixtures";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await recycleFixture(root); });
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-apply-global-")); roots.push(root);
	const source = path.join(root, "source"), out = path.join(root, "installed");
	for (const directory of [source, out]) { fs.mkdirSync(path.join(directory, "src"), { recursive: true }); fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "1.0.0" })); }
	fs.writeFileSync(path.join(source, "src", "changed.ts"), "candidate"); fs.writeFileSync(path.join(source, "src", "added.ts"), "added");
	fs.writeFileSync(path.join(out, "src", "changed.ts"), "previous");
	return { source, out };
}
it("preserves every installed source byte when staging verification fails", () => {
	const f = fixture(); const build = vi.fn(() => "failed" as const);
	expect(() => applyGlobalSources({ ...f, build, log: vi.fn() })).toThrow(/源码与完整构建已保留/);
	expect(build).toHaveBeenCalledWith(f.out, { force: true, sourceRoot: f.source });
	expect(fs.readFileSync(path.join(f.out, "src", "changed.ts"), "utf8")).toBe("previous");
	expect(fs.readdirSync(path.join(f.out, "src"))).toEqual(["changed.ts"]);
});
it("only reports proposed changes in dry mode and refuses a mismatched version", () => {
	const f = fixture(); const build = vi.fn(() => "built" as const);
	expect(applyGlobalSources({ ...f, dry: true, build, log: vi.fn() })).toBe("skipped");
	expect(build).not.toHaveBeenCalled();
	fs.writeFileSync(path.join(f.out, "package.json"), JSON.stringify({ version: "2.0.0" }));
	expect(() => applyGlobalSources({ ...f, build })).toThrow(/版本不一致/);
	expect(build).not.toHaveBeenCalled();
});
