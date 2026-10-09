#!/usr/bin/env node
/**
 * 最小假 ACP Agent（M0b 冒烟自测用，也是 M0c 的种子）。
 * 手写换行分隔 JSON-RPC、零依赖：回答 initialize + session/new，并连一次传入的 stdio MCP 服务器验 tools/list。
 * 环境变量：FAKE_ACP_NO_MCP=1 跳过 MCP 连接；FAKE_ACP_DELAY_MS=<毫秒> 给每个回应加延迟。
 */
import { spawn } from "node:child_process";

const delayMs = Number(process.env.FAKE_ACP_DELAY_MS ?? 0) || 0;
const log = (message) => process.stderr.write(`[fake-acp-agent] ${message}\n`);

async function send(message) {
	if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

const mcpChildren = new Set();
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		void handle(message);
	}
});
process.stdin.on("end", () => {
	for (const child of mcpChildren) child.kill();
	process.exit(0);
});

async function handle(message) {
	const { id, method, params } = message;
	if (id === undefined) return; // 客户端通知
	if (method === "initialize") {
		await send({ jsonrpc: "2.0", id, result: {
			protocolVersion: params?.protocolVersion ?? 1,
			agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
			authMethods: [{ id: "fake-login", name: "Fake login", description: "探测用的假登录方式" }],
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true },
				mcpCapabilities: { http: false, sse: false },
			},
		} });
		return;
	}
	if (method === "session/new") {
		await send({ jsonrpc: "2.0", id, result: {
			sessionId: "fake-session-1",
			modes: {
				currentModeId: "default",
				availableModes: [
					{ id: "default", name: "Default" },
					{ id: "plan", name: "Plan" },
					{ id: "yolo", name: "YOLO" },
				],
			},
			configOptions: [{
				id: "model",
				name: "Model",
				type: "select",
				currentValue: "fake-model",
				options: [
					{ value: "fake-model", name: "Fake Model" },
					{ value: "fake-model-2", name: "Fake Model 2" },
				],
			}],
		} });
		if (process.env.FAKE_ACP_NO_MCP !== "1") await probeMcp(params?.mcpServers);
		return;
	}
	await send({ jsonrpc: "2.0", id, error: { code: -32601, message: `fake-acp-agent 未实现 ${method}` } });
}

/** 假装是 ACP 里的 MCP 客户端：连第一台 stdio 服务器，走 initialize → initialized → tools/list。 */
async function probeMcp(servers) {
	const server = Array.isArray(servers) ? servers[0] : null;
	if (!server?.command) return;
	const env = { ...process.env };
	for (const pair of server.env ?? []) if (pair?.name) env[pair.name] = pair.value ?? "";
	const child = spawn(server.command, server.args ?? [], { stdio: ["pipe", "pipe", "ignore"], env, windowsHide: true });
	mcpChildren.add(child);
	child.once("exit", () => mcpChildren.delete(child));
	child.once("error", (error) => log(`mcp 启动失败：${error.message}`));
	let mcpBuffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		mcpBuffer += chunk;
		let index;
		while ((index = mcpBuffer.indexOf("\n")) !== -1) {
			const line = mcpBuffer.slice(0, index).trim();
			mcpBuffer = mcpBuffer.slice(index + 1);
			if (!line) continue;
			let reply;
			try { reply = JSON.parse(line); } catch { continue; }
			if (reply.id === 1) {
				log(`mcp initialize 回应：${reply.result?.serverInfo?.name ?? "?"}`);
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
			}
			if (reply.id === 2) {
				const names = (reply.result?.tools ?? []).map((tool) => tool.name).join(", ");
				log(`mcp tools/list：${names || "空"}`);
			}
		}
	});
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp-agent", version: "0.0.1" } } })}\n`);
}
