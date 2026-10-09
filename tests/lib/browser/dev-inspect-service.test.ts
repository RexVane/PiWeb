import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSearchableFiles, locateSource, normalizeInspectText } from "../../../src/lib/browser/dev-inspect-service";

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

	it("parses code-inspector-plugin data-insp-path values (file:line:col:tagName)", async () => {
		await fs.mkdir(path.join(work, "src"), { recursive: true });
		const file = path.join(work, "src", "App.vue");
		await fs.writeFile(file, "<template>\n  <div>hi</div>\n  <button>go</button>\n</template>\n");
		const relative = await locateSource(work, { attrs: { "data-insp-path": "src/App.vue:2:3:div" } });
		expect(relative.results).toEqual([{ path: "src/App.vue", line: 2, lineText: "<div>hi</div>", kind: "source-attr" }]);
		const absolute = await locateSource(work, { attrs: { "data-insp-path": `${file}:3:3:el-button` } });
		expect(absolute.results).toEqual([{ path: "src/App.vue", line: 3, lineText: "<button>go</button>", kind: "source-attr" }]);
	});

	it("recovers monorepo-relative source paths by suffix inside the workspace", async () => {
		await fs.mkdir(path.join(work, "apps", "web", "src"), { recursive: true });
		await fs.mkdir(path.join(work, "apps", "admin", "src"), { recursive: true });
		await fs.writeFile(path.join(work, "apps", "web", "src", "App.tsx"), "a\nweb line\n");
		await fs.writeFile(path.join(work, "apps", "admin", "src", "Other.tsx"), "x\n");
		const result = await locateSource(work, { attrs: { "data-source": "src/App.tsx:2:1" } });
		expect(result.results).toEqual([{ path: "apps/web/src/App.tsx", line: 2, lineText: "web line", kind: "source-attr" }]);
		// 含 .. 的相对路径不做后缀找回（只能落到文本搜索）
		const escape = await locateSource(work, { attrs: { "data-source": "../web/src/App.tsx:2:1" }, text: "web line" });
		expect(escape.results.every((r) => r.kind === "text")).toBe(true);
	});

	it("walks source directories first and hidden directories last", async () => {
		for (const dir of ["zzz", ".storybook", "src", "docs"]) {
			await fs.mkdir(path.join(work, dir), { recursive: true });
			await fs.writeFile(path.join(work, dir, "a.ts"), "x\n");
		}
		const { files, truncated } = await listSearchableFiles(work);
		expect(files.map((f) => f.rel)).toEqual(["src/a.ts", "docs/a.ts", "zzz/a.ts", ".storybook/a.ts"]);
		expect(truncated).toBe(false);
		const capped = await listSearchableFiles(work, 1);
		expect(capped.files.map((f) => f.rel)).toEqual(["src/a.ts"]);
		expect(capped.truncated).toBe(true);
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

	it("resolves framework source hints read from the page (React / Svelte lines, Vue component files)", async () => {
		const real = await fs.realpath(work);
		await fs.mkdir(path.join(work, "apps", "web", "src", "components"), { recursive: true });
		await fs.writeFile(path.join(work, "apps", "web", "src", "Card.tsx"), "a\nb\nreturn <div>卡片</div>;\n");
		await fs.writeFile(path.join(work, "apps", "web", "src", "components", "Hello.vue"), "<template>\n  <h1>标题</h1>\n  <p>问候语</p>\n</template>\n");
		await fs.writeFile(path.join(work, "apps", "web", "src", "other.ts"), "export const s = '问候语';\n");

		// React：绝对路径 + 行号，精确命中，不再做文本搜索
		const react = await locateSource(work, { text: "随便", attrs: { "react-source": `${real}/apps/web/src/Card.tsx:3:8` } });
		expect(react.results).toEqual([expect.objectContaining({ path: "apps/web/src/Card.tsx", line: 3, kind: "source-attr" })]);
		// Svelte：相对 dev server 根的路径，按后缀在 monorepo 里找回
		const svelte = await locateSource(work, { attrs: { "svelte-source": "src/Card.tsx:2" } });
		expect(svelte.results[0]).toMatchObject({ path: "apps/web/src/Card.tsx", line: 2 });
		// Vue：只到组件文件——组件里的文本命中排最前，其他文件的同名文本排后
		const vue = await locateSource(work, { text: "问候语", attrs: { "vue-file": "/somewhere/else/src/components/Hello.vue?vue&type=template" } });
		expect(vue.results.map((r) => `${r.path}:${r.line}`)).toEqual(["apps/web/src/components/Hello.vue:3", "apps/web/src/other.ts:1"]);
		// 文本不够长或搜不到时退回组件文件本身
		const vueOnly = await locateSource(work, { text: "x", attrs: { "vue-file": `${real}/apps/web/src/components/Hello.vue` } });
		expect(vueOnly.results).toEqual([expect.objectContaining({ path: "apps/web/src/components/Hello.vue", line: 1, lineText: "<template>" })]);
		// 线索指向工作区外的文件：忽略，回到文本搜索
		const outside = await locateSource(work, { text: "卡片", attrs: { "react-source": "/etc/passwd:1" } });
		expect(outside.results[0]).toMatchObject({ path: "apps/web/src/Card.tsx", kind: "text" });
	});
});
