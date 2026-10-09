import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserAvailable, getBrowserTab, shutdownBrowser, type BrowserTab } from "../../../src/lib/browser/manager";
import { captureForPicking, NoBrowserPageError, pickElementAt } from "../../../src/lib/browser/pick";
import { BoundaryError } from "../../../src/lib/security/path-security";

/** JPEG 的 SOF 段里读宽高（只为断言裁剪图尺寸，不解码像素） */
function jpegSize(base64: string): { width: number; height: number } {
	const buf = Buffer.from(base64, "base64");
	expect(buf.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
	for (let i = 2; i < buf.length - 9;) {
		if (buf[i] !== 0xff) { i += 1; continue; }
		const marker = buf[i + 1];
		if (marker >= 0xc0 && marker <= 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
		i += 2 + buf.readUInt16BE(i + 2);
	}
	throw new Error("no SOF marker");
}

function page(workspace: string): string {
	// 用脚本模拟各框架开发构建留在 DOM 上的元数据（真实项目里由 React / Vue / Svelte 的 dev 构建写入）
	return `<!doctype html><meta charset="utf-8"><title>点选测试</title>
<style>body{margin:0;font:16px sans-serif} .cell{position:absolute;width:200px;height:60px} #huge{position:absolute;left:0;top:400px;width:3000px;height:3000px;background:#eef}</style>
<button id="attr" class="cell" style="left:10px;top:10px" data-source="src/App.tsx:12:5">保存</button>
<div id="react" class="cell" style="left:250px;top:10px">React 卡片</div>
<div id="vue" class="cell" style="left:490px;top:10px"><span id="vue-inner">Vue 问候语</span></div>
<div id="vue-missing" class="cell" style="left:730px;top:10px">页面上才有的字</div>
<div id="svelte4" class="cell" style="left:10px;top:100px">Svelte 四</div>
<div id="svelte5" class="cell" style="left:250px;top:100px">Svelte 五</div>
<p id="plain" class="cell" style="left:490px;top:100px;margin:0">纯文本命中</p>
<my-widget id="host" class="cell" style="left:730px;top:100px;display:block"></my-widget>
<div id="huge"></div>
<div id="red" style="position:absolute;left:10px;top:1200px;width:200px;height:60px;background:#f00"></div>
<script>
	const ws = ${JSON.stringify(workspace)};
	document.getElementById("react")["__reactFiber$test1"] = {
		type: "div",
		_debugSource: { fileName: ws + "/src/Card.tsx", lineNumber: 3, columnNumber: 7 },
		return: { type: function Card() {}, return: null },
	};
	const vueComponent = { type: { __file: ws + "/src/components/Hello.vue", __name: "Hello" }, parent: null };
	document.getElementById("vue").__vueParentComponent = vueComponent;
	document.getElementById("vue-inner").__vueParentComponent = vueComponent;
	document.getElementById("vue-missing").__vueParentComponent = vueComponent;
	document.getElementById("svelte4").__svelte_meta = { loc: { file: "src/routes/Page.svelte", line: 4, column: 2, char: 50 } };
	document.getElementById("svelte5").__svelte_meta = { parent: null, loc: { file: "src/routes/Other.svelte", line: 7, column: 0 } };
	const root = document.getElementById("host").attachShadow({ mode: "open" });
	root.innerHTML = '<span id="shadow" style="display:block;width:200px;height:60px">影子里的字</span>';
</script>`;
}

async function listen(server: http.Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return (server.address() as AddressInfo).port;
}

async function centerOf(tab: BrowserTab, selector: string): Promise<{ x: number; y: number }> {
	return tab.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}

const lines = (n: number, at: Record<number, string>) => Array.from({ length: n }, (_, i) => at[i + 1] ?? `// line ${i + 1}`).join("\n");

// 本机（或 CI runner）没有 Chrome / Edge / Chromium 时整组跳过
describe.skipIf(!browserAvailable())("picking elements on pi's screenshot (real headless browser)", () => {
	let server: http.Server;
	let workspace = "";
	let tab: BrowserTab;
	const key = "pick-test-session";

	beforeAll(async () => {
		workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-pick-")));
		const files: Record<string, string> = {
			"src/App.tsx": lines(14, { 12: "<button>保存</button>" }),
			"src/Card.tsx": lines(5, { 3: "return <div>React 卡片</div>;" }),
			"src/components/Hello.vue": lines(6, { 4: "<span>Vue 问候语</span>" }),
			"src/other.ts": lines(3, { 2: "const label = 'Vue 问候语';" }),
			"src/routes/Page.svelte": lines(8, { 5: "<div>Svelte 四</div>" }),
			"src/routes/Other.svelte": lines(9, { 7: "<div>Svelte 五</div>" }),
			"src/plain.tsx": lines(3, { 2: "<p>纯文本命中</p>" }),
		};
		for (const [rel, content] of Object.entries(files)) {
			await fs.mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
			await fs.writeFile(path.join(workspace, rel), content);
		}
		server = http.createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(page(workspace));
		});
		const base = `http://127.0.0.1:${await listen(server)}`;
		tab = await getBrowserTab(key);
		await tab.navigate(`${base}/`);
	}, 60_000);

	afterAll(async () => {
		await shutdownBrowser();
		server.close();
		await fs.rm(workspace, { recursive: true, force: true });
	});

	it("captures a fresh viewport screenshot of the open page", async () => {
		const shot = await captureForPicking(key);
		expect([shot.width, shot.height, shot.device]).toEqual([1280, 800, "desktop"]);
		expect(jpegSize(shot.image.data)).toEqual({ width: 1280, height: 800 });
		expect(shot.title).toBe("点选测试");
	});

	it("locates a build-time source attribute and returns an element crop", async () => {
		const p = await centerOf(tab, "#attr");
		const r = await pickElementAt(key, workspace, p.x, p.y);
		expect(r.element).toMatchObject({ tag: "button", id: "attr", text: "保存", label: "<button#attr> “保存”" });
		expect(r.locations[0]).toMatchObject({ path: "src/App.tsx", line: 12, kind: "source-attr" });
		expect(r.crop).not.toBeNull();
		const size = jpegSize(r.crop!.data);
		expect(size.width).toBeGreaterThanOrEqual(200);
		expect(size.width).toBeLessThanOrEqual(220);
		expect(size.height).toBeGreaterThanOrEqual(60);
		expect(size.height).toBeLessThanOrEqual(80);
	});

	it("reads React ≤18 fiber debug sources with the component name", async () => {
		const p = await centerOf(tab, "#react");
		const r = await pickElementAt(key, workspace, p.x, p.y);
		expect(r.element.hints).toEqual([expect.objectContaining({ framework: "react", line: 3, column: 7, component: "Card" })]);
		expect(r.locations[0]).toMatchObject({ path: "src/Card.tsx", line: 3, lineText: "return <div>React 卡片</div>;" });
	});

	it("ranks text hits inside the Vue component file first, and falls back to the component file", async () => {
		const p = await centerOf(tab, "#vue-inner");
		const r = await pickElementAt(key, workspace, p.x, p.y);
		expect(r.element.hints[0]).toMatchObject({ framework: "vue", component: "Hello" });
		expect(r.locations.map((l) => `${l.path}:${l.line}`)).toEqual(["src/components/Hello.vue:4", "src/other.ts:2"]);

		const q = await centerOf(tab, "#vue-missing");
		const fallback = await pickElementAt(key, workspace, q.x, q.y);
		expect(fallback.locations).toEqual([expect.objectContaining({ path: "src/components/Hello.vue", line: 1, kind: "source-attr" })]);
	});

	it("converts Svelte 4 zero-based lines and keeps Svelte 5 one-based lines", async () => {
		const p4 = await centerOf(tab, "#svelte4");
		const r4 = await pickElementAt(key, workspace, p4.x, p4.y);
		expect(r4.locations[0]).toMatchObject({ path: "src/routes/Page.svelte", line: 5, lineText: "<div>Svelte 四</div>" });

		const p5 = await centerOf(tab, "#svelte5");
		const r5 = await pickElementAt(key, workspace, p5.x, p5.y);
		expect(r5.locations[0]).toMatchObject({ path: "src/routes/Other.svelte", line: 7, lineText: "<div>Svelte 五</div>" });
	});

	it("falls back to text search and descends into open shadow roots", async () => {
		const p = await centerOf(tab, "#plain");
		const r = await pickElementAt(key, workspace, p.x, p.y);
		expect(r.element.hints).toEqual([]);
		expect(r.locations[0]).toMatchObject({ path: "src/plain.tsx", line: 2, kind: "text" });

		const s = await centerOf(tab, "#host");
		const shadow = await pickElementAt(key, workspace, s.x, s.y);
		expect(shadow.element).toMatchObject({ tag: "span", id: "shadow", text: "影子里的字" });
		expect(shadow.locations).toEqual([]);
	});

	it("clamps the crop of an element larger than the viewport", async () => {
		const r = await pickElementAt(key, workspace, 640, 700);
		expect(r.element.id).toBe("huge");
		const size = jpegSize(r.crop!.data);
		expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(640);
		expect(size.width).toBeGreaterThan(size.height);
	});

	it("crops the picked element itself when the page is scrolled", async () => {
		await tab.evaluate("window.scrollTo(0, 1000)");
		try {
			const p = await centerOf(tab, "#red");
			expect(p.y).toBeGreaterThan(0);
			expect(p.y).toBeLessThan(800);
			const r = await pickElementAt(key, workspace, p.x, p.y);
			expect(r.element.id).toBe("red");
			expect(r.element.scroll.y).toBe(1000);
			// 在同一个浏览器里解码裁剪图，取中心像素：必须是这个红块，而不是滚动前同一视口位置的内容
			const pixel = await tab.evaluate<number[]>(`new Promise((resolve, reject) => {
				const img = new Image();
				img.onload = () => {
					const canvas = document.createElement("canvas");
					canvas.width = img.width; canvas.height = img.height;
					const ctx = canvas.getContext("2d");
					ctx.drawImage(img, 0, 0);
					resolve(Array.from(ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data));
				};
				img.onerror = () => reject(new Error("crop does not decode"));
				img.src = "data:image/jpeg;base64,${r.crop!.data}";
			})`);
			expect(pixel[0]).toBeGreaterThan(200);
			expect(pixel[1]).toBeLessThan(60);
			expect(pixel[2]).toBeLessThan(60);
		} finally {
			await tab.evaluate("window.scrollTo(0, 0)");
		}
	});

	it("rejects points outside the viewport and sessions without a page", async () => {
		await expect(pickElementAt(key, workspace, 1281, 10)).rejects.toBeInstanceOf(BoundaryError);
		await expect(pickElementAt(key, workspace, Number.NaN, 10)).rejects.toBeInstanceOf(BoundaryError);
		await expect(captureForPicking("session-without-browser")).rejects.toBeInstanceOf(NoBrowserPageError);
	});
});
