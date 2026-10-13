/** Real-browser verification with deterministic API fixtures; no model calls or user sessions. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const baseUrl = process.argv[2] || "http://127.0.0.1:3217";
const debugPort = process.argv[3] || "9337";
const artifactDir = process.argv[4] || "docs/assets";
const fixtureRun = randomUUID();
function localJson(url) {
	return new Promise((resolve, reject) => {
		http.get(url, { agent: false }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
		}).on("error", reject);
	});
}
const targets = await localJson(`http://127.0.0.1:${debugPort}/json/list`);
const target = targets.find((item) => item.type === "page");
assert(target, "start headless Chrome with a debugging port first");
const socket = new WebSocket(target.webSocketDebuggerUrl, { agent: false });
await once(socket, "open");
let sequence = 0;
const pending = new Map();
const handlers = new Map();
const errors = [];
function command(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});
}
socket.on("message", (raw) => {
	const message = JSON.parse(String(raw));
	if (message.id) {
		const task = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) task?.reject(new Error(message.error.message));
		else task?.resolve(message.result);
	} else {
		const handler = handlers.get(message.method);
		if (handler) Promise.resolve(handler(message.params)).catch((error) => errors.push(String(error)));
	}
});
const evaluate = async (expression) => {
	const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + result.exceptionDetails.exception?.description);
	return result.result.value;
};
async function until(expression, timeout = 15_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await evaluate(expression)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`browser condition timed out: ${expression}`);
}

const sourcePath = "/demo/project/main-session.jsonl";
const sessionId = Buffer.from(sourcePath).toString("base64url");
const content = [
	"# PiWeb 的复用机制\n\n可以一边阅读这份说明，一边在右侧追问。",
	...Array.from({ length: 45 }, (_, index) => `## ${index + 1}. ${index === 18 ? "复用 Session 存储" : "实现说明"}\n\nWeb 与 CLI 读取同一份会话记录，消息按顺序写入 JSONL。会话管理器根据当前分支还原上下文；切换界面不会复制一份新的主会话。\n\n这里还有下一段内容：Model、Skill 与 Plugin 同样沿用 Pi 的配置。阅读过程中可以不断提问，旁聊回答只出现在右侧，主会话保留当前位置。\n\n\`SessionManager\` 保存会话条目，模型运行时提供模型和认证。`),
].join("\n\n");
const model = { provider: "demo", id: "demo-model", name: "示例模型", reasoning: false, thinkingLevels: ["off"], contextWindow: 128000 };
const quickModel = { provider: "demo", id: "demo-quick", name: "旁聊快问模型", reasoning: false, thinkingLevels: ["off"], contextWindow: 64000 };
const messages = [{ id: "main-question", role: "user", content: [{ type: "text", text: "介绍 PiWeb 的复用机制" }], timestamp: 1 }, { id: "main-answer", role: "assistant", content: [{ type: "text", text: content }], stopReason: "stop", timestamp: 2 }];
const snapshot = {
	seq: 1, sessionPath: sourcePath, cwd: "/demo/project", name: "PiWeb 阅读示例", messages, model, thinkingLevel: "off", thinkingLevels: ["off"],
	contextFiles: [], contextResources: [], skills: [], promptTemplates: [], extensionCommands: [], resourceDiagnostics: [],
	projectTrust: { required: false, trusted: true, source: "not-required" }, toolPreset: "standard", customActiveTools: null,
	tools: { active: [], all: [] }, stats: null, contextUsage: null, queue: { steering: [], followUp: [] }, trajectory: [],
	userTurns: [{ id: "main-question", ts: 1 }], growthError: null, growthConsent: null, extensionUiRequests: [], isStreaming: false,
};
const jobs = new Map();
const prompts = [];
const mainCommands = [];
handlers.set("Fetch.requestPaused", async ({ requestId, request }) => {
	const url = new URL(request.url);
	let data = {};
	let contentType = "application/json";
	let body;
	if (url.pathname === "/api/sessions") data = { sessions: [{ path: sourcePath, cwd: "/demo/project", name: snapshot.name, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 2, firstMessage: "介绍 PiWeb 的复用机制" }], active: {}, workspaceRegistry: { workspaces: ["/demo/project"], removedWorkspaces: [], aliases: {}, archivedSessions: [] } };
	else if (url.pathname === "/api/models") data = { models: [model, quickModel], providers: [{ id: "demo", name: "Demo", authReady: true }] };
	else if (url.pathname === "/api/workspaces") data = { workspaces: ["/demo/project"], removedWorkspaces: [], aliases: {}, archivedSessions: [] };
	else if (url.pathname.endsWith("/events")) { contentType = "text/event-stream"; body = `id: fixture.1\ndata: ${JSON.stringify({ type: "snapshot", snapshot })}\n\n`; }
	else if (url.pathname.endsWith("/side-chat")) {
		if (request.method === "POST") {
			const input = JSON.parse(request.postData);
			prompts.push(input);
			jobs.set(input.requestId, input);
			data = { requestId: input.requestId, revision: 0, text: "", done: false, aborted: false };
		} else if (request.method === "GET") {
			const id = url.searchParams.get("requestId");
			const input = jobs.get(id);
			assert(input, "unknown side-chat request");
			await new Promise((resolve) => setTimeout(resolve, 150));
			data = { requestId: id, revision: 1, text: input.model ? `这是 ${input.model.id} 的回答。\n\n旁聊可以单独选模型，主会话仍留在原处。` : input.text.includes("Model") ? "Model 由 Pi 的模型运行时加载，沿用现有配置与认证。\n\n你可以接着问其他实现细节，主会话仍留在原处。" : "**复用 Session 存储**，就是 Web 与 CLI 使用同一份会话记录。\n\n1. 消息保存在 JSONL 文件中。\n2. 会话管理器根据当前分支读取消息。\n3. 旁聊单独保留自己的问答，主会话内容保持原样。", done: true, aborted: false, textOffset: 0 };
		}
	} else if (url.pathname.startsWith("/api/agent/")) { if (request.postData) mainCommands.push(JSON.parse(request.postData)); }
	else if (url.pathname === "/api/growth") data = { rounds: [], changes: [], root: "/demo/project", totalRounds: 0 };
	else if (url.pathname === "/api/update") data = { piweb: { version: "0.3.22", latest: "0.3.22" }, pi: { version: "1.1.0", latest: "1.1.0" } };
	else if (url.pathname === "/api/version") data = { version: "0.3.22", piVersion: "1.1.0" };
	else if (url.pathname === "/api/models/defaults") data = { defaultThinkingLevel: "off", modelThinkingLevels: {} };
	body ??= JSON.stringify({ success: true, data });
	await command("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: contentType }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(body).toString("base64") });
});
handlers.set("Runtime.exceptionThrown", (event) => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
await command("Page.enable");
await command("Runtime.enable");
await command("Fetch.enable", { patterns: [{ urlPattern: `${baseUrl}/api/*` }] });
await command("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await command("Page.addScriptToEvaluateOnNewDocument", { source: `if (localStorage.getItem('sidechat.fixture') !== ${JSON.stringify(fixtureRun)}) { localStorage.clear(); localStorage.setItem('sidechat.fixture',${JSON.stringify(fixtureRun)}); localStorage.setItem('piweb.currentSession',${JSON.stringify(sourcePath)}); localStorage.setItem('piweb.theme','dark'); localStorage.setItem('piweb.lang','zh'); }` });
await command("Page.navigate", { url: baseUrl });
await until("!!document.querySelector('[data-testid=side-chat-toggle]') && document.querySelectorAll('.pi-main [data-role=assistant] p').length > 40");
await evaluate("document.fonts.ready.then(() => true)");
await new Promise((resolve) => setTimeout(resolve, 500));
await evaluate(`(() => {
	const log = document.querySelector('.pi-main [role=log]');
	const paragraph = log.querySelectorAll('[data-role=assistant] p')[45];
	window.sidechatReadingTarget = paragraph;
	log.scrollTop += paragraph.getBoundingClientRect().top - log.getBoundingClientRect().top;
	log.dispatchEvent(new Event('scroll'));
	window.sidechatReadingTop = paragraph.getBoundingClientRect().top - log.getBoundingClientRect().top;
})()`);
const readingTop = () => evaluate("window.sidechatReadingTarget.getBoundingClientRect().top - document.querySelector('.pi-main [role=log]').getBoundingClientRect().top");
const initialTop = await readingTop();
await evaluate("document.querySelector('[data-testid=side-chat-toggle]').click()");
await until("!!document.querySelector('[data-testid=side-chat-panel] textarea')");
await new Promise((resolve) => setTimeout(resolve, 250));
const openedTop = await readingTop();
assert(Math.abs(openedTop - initialTop) < 5, `opening the side panel lost the reading position (${initialTop} → ${openedTop})`);
async function ask(text) {
	await evaluate(`(() => {
		const input = document.querySelector('[data-testid=side-chat-panel] textarea');
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
		input.dispatchEvent(new Event('input', {bubbles:true}));
	})()`);
	await until("!document.querySelector('[data-testid=side-chat-panel] button[type=submit]').disabled");
	await evaluate("document.querySelector('[data-testid=side-chat-panel] form').requestSubmit()");
	await until("!document.querySelector('[data-testid=side-chat-panel] [role=status]') && !!document.querySelector('[data-testid=side-chat-panel] .md')");
}
await ask("复用 Session 存储的详细逻辑是什么?");
await ask("Model 又是怎么复用的?");
await until("document.querySelector('[data-testid=side-chat-panel]').textContent.includes('Model 由 Pi')");
assert(Math.abs((await readingTop()) - initialTop) < 5, "side questions moved the main pane");
assert.equal(prompts.length, 2);
assert.equal(prompts[1].history.length, 2);
assert.equal(prompts[0].model, undefined, "default side-chat request must follow the main model");
assert(!mainCommands.some((item) => ["prompt", "abort", "compact"].includes(item.cmd)), "side chat sent a command to the main agent");
assert.equal(await evaluate("document.querySelectorAll('.pi-main [data-role=user]').length"), 1);
assert(!(await evaluate("document.querySelector('[data-testid=side-chat-panel]').textContent")).match(/缓存命中|工具调用|首 token|tok\/s/), "side panel displayed session statistics");
// 旁聊模型：默认跟随主会话，换成旁聊专属模型后后续问题带显式模型
await evaluate(`(() => {
	const chip = [...document.querySelectorAll('[data-testid=side-chat-panel] .chip')].find(node => node.textContent.includes('示例模型'));
	if (!chip) throw new Error('side-chat model chip not found');
	chip.click();
})()`);
await until("[...document.querySelectorAll('[data-testid=side-chat-panel] [role=menuitemradio]')].some(node => node.textContent.includes('旁聊快问模型'))");
assert.equal(await evaluate("[...document.querySelectorAll('[data-testid=side-chat-panel] [role=menuitemradio]')].some(node => node.textContent.includes('跟随主会话'))"), true, "following the main model must stay an option");
await evaluate(`(() => {
	const option = [...document.querySelectorAll('[data-testid=side-chat-panel] [role=menuitemradio]')].find(node => node.textContent.includes('旁聊快问模型'));
	option.click();
})()`);
await until("document.querySelector('[data-testid=side-chat-panel] .chip').textContent.includes('旁聊快问模型')");
await ask("换个模型再问一次");
await until("document.querySelector('[data-testid=side-chat-panel]').textContent.includes('这是 demo-quick 的回答')");
assert.deepEqual(prompts.at(-1).model, { provider: "demo", id: "demo-quick" }, "picked side-chat model was not sent with the question");
await evaluate(`(() => {
	const handle = [...document.querySelectorAll('.cursor-col-resize')].find(node => node.getBoundingClientRect().left > window.innerWidth / 2);
	const x = handle.getBoundingClientRect().left + 4;
	handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, clientX:x, pointerId:1 }));
	window.dispatchEvent(new PointerEvent('pointermove', { clientX:x-96, pointerId:1 }));
	setTimeout(() => window.dispatchEvent(new PointerEvent('pointerup', { clientX:x-96, pointerId:1 })), 50);
})()`);
await new Promise((resolve) => setTimeout(resolve, 250));
assert(Math.abs((await readingTop()) - initialTop) < 5, "dragging the panel lost the reading position");
await fs.mkdir(artifactDir, { recursive: true });
async function screenshot(name) {
	const image = await command("Page.captureScreenshot", { format: "png" });
	await fs.writeFile(path.join(artifactDir, name), Buffer.from(image.data, "base64"));
}
await screenshot("side-chat-desktop.png");
await evaluate("document.querySelector('[data-testid=side-chat-panel] button[aria-label=关闭]').click()");
await new Promise((resolve) => setTimeout(resolve, 250));
assert(Math.abs((await readingTop()) - initialTop) < 5, "closing the panel lost the reading position");
await evaluate("document.querySelector('[data-testid=side-chat-toggle]').click()");
await until("document.querySelector('[data-testid=side-chat-panel]')?.textContent.includes('Model 由 Pi')");
await evaluate("document.querySelector('[data-testid=side-chat-panel] button[aria-label=新旁聊]').click()");
await until("!!document.querySelector('[data-testid=side-chat-panel] select')");
assert.equal(await evaluate("document.querySelectorAll('[data-testid=side-chat-panel] [data-role=user]').length"), 0);
await evaluate("(() => { const select = document.querySelector('[data-testid=side-chat-panel] select'); select.value=select.options[1].value; select.dispatchEvent(new Event('change',{bubbles:true})); })()");
await until("document.querySelector('[data-testid=side-chat-panel]')?.textContent.includes('Model 由 Pi')");
await command("Page.reload");
await until("document.querySelector('[data-testid=side-chat-panel]')?.textContent.includes('Model 由 Pi')");
await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "mobile page overflowed horizontally");
assert.equal(await evaluate("document.querySelector('[data-testid=side-chat-panel] textarea').getBoundingClientRect().bottom <= window.innerHeight"), true, "mobile input was outside the screen");
await screenshot("side-chat-mobile.png");
assert.deepEqual(errors, [], "browser threw exceptions");
console.log(JSON.stringify({ passed: true, checks: ["open preserves reading position", "multi-turn isolated requests", "default follows the main model", "picking a side-chat model sends it", "simple panel without statistics", "drag preserves reading position", "close and reopen", "new chat keeps old history", "reload restores history", "mobile input fits"], screenshots: [path.join(artifactDir, "side-chat-desktop.png"), path.join(artifactDir, "side-chat-mobile.png")] }, null, 2));
socket.close();
