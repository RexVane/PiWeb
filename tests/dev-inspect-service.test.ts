import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateSource, normalizeInspectText } from "../src/lib/dev-inspect-service";

describe("dev-inspect-service", () => {
	let work = "";

	beforeEach(async () => {
		work = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-dev-inspect-"));
	});

	afterEach(async () => {
		await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
	});

	it("finds literal text in a component file", async () => {
		await fs.mkdir(path.join(work, "src"), { recursive: true });
		await fs.writeFile(path.join(work, "src", "App.tsx"), "export function App() {\n\treturn <button>保存设置</button>;\n}\n");
		const result = await locateSource(work, { text: "保存设置" });
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({ path: "src/App.tsx", line: 2, kind: "text" });
		expect(result.results[0].lineText).toContain("保存设置");
	});

	it("follows i18n dictionary hits to key usages (two-hop)", async () => {
		await fs.mkdir(path.join(work, "src", "locales"), { recursive: true });
		await fs.mkdir(path.join(work, "src", "components"), { recursive: true });
		await fs.writeFile(path.join(work, "src", "locales", "zh.json"), JSON.stringify({ saveSettings: "保存设置" }, null, 2));
		await fs.writeFile(path.join(work, "src", "components", "Settings.tsx"), "export function Settings() {\n\treturn <button>{t(\"saveSettings\")}</button>;\n}\n");
		const result = await locateSource(work, { text: "保存设置" });
		expect(result.results.length).toBeGreaterThanOrEqual(2);
		// 使用处（i18n-usage）排在字典命中（text）之前
		expect(result.results[0]).toMatchObject({ path: "src/components/Settings.tsx", line: 2, kind: "i18n-usage" });
		expect(result.results.some((r) => r.path === "src/locales/zh.json" && r.kind === "text")).toBe(true);
	});

	it("does not two-hop on plain object literals outside dictionary paths", async () => {
		await fs.mkdir(path.join(work, "src"), { recursive: true });
		await fs.writeFile(path.join(work, "src", "config.ts"), "export const config = {\n\ttitle: \"保存设置\",\n};\n");
		const result = await locateSource(work, { text: "保存设置" });
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({ path: "src/config.ts", kind: "text" });
	});

	it("resolves data-source attributes inside the workspace and rejects escapes", async () => {
		await fs.mkdir(path.join(work, "src"), { recursive: true });
		await fs.writeFile(path.join(work, "src", "App.tsx"), "line1\nline2\nline3\n");
		const inside = await locateSource(work, { attrs: { "data-source": "src/App.tsx:3:5" } });
		expect(inside.results).toEqual([{ path: "src/App.tsx", line: 3, lineText: "line3", kind: "source-attr" }]);
		const escape = await locateSource(work, { attrs: { "data-source": "../escape.ts:1:1" }, text: "保存设置" });
		expect(escape.results.every((r) => r.kind !== "source-attr")).toBe(true);
	});

	it("skips excluded directories and binary files", async () => {
		await fs.mkdir(path.join(work, "node_modules", "pkg"), { recursive: true });
		await fs.writeFile(path.join(work, "node_modules", "pkg", "index.js"), "const x = \"隐藏文本\";\n");
		await fs.writeFile(path.join(work, "blob.ts"), Buffer.from(`const a = "隐藏文本";\0binary\n`, "utf8"));
		const result = await locateSource(work, { text: "隐藏文本" });
		expect(result.results).toEqual([]);
	});

	it("rejects missing text and attributes", async () => {
		await expect(locateSource(work, {})).rejects.toThrow(/missing usable text/);
		await expect(locateSource(work, { text: "x" })).rejects.toThrow(/missing usable text/);
	});

	it("normalizes DOM text (whitespace collapse, length cap)", () => {
		expect(normalizeInspectText("  保存\n\n  设置  ")).toBe("保存 设置");
		expect(normalizeInspectText("a".repeat(500))).toHaveLength(200);
		expect(normalizeInspectText(42)).toBe("");
	});

	it("is case-sensitive on purpose", async () => {
		await fs.writeFile(path.join(work, "a.ts"), "const s = \"Hello World\";\n");
		expect((await locateSource(work, { text: "Hello World" })).results).toHaveLength(1);
		expect((await locateSource(work, { text: "hello world" })).results).toEqual([]);
	});
});
