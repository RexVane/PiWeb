#!/usr/bin/env node
/**
 * ACP 探路脚本（M0b）：把一条命令当作 ACP Agent 启动，只发 initialize（可选再试一次 session/new），
 * 打印协议代数、agentInfo、authMethods、能力（loadSession / 图片 / MCP / 模式 / 配置项）和原始 JSON。
 * 结果贴回对话，用来决定各家走 ACP 还是官方 SDK（见 docs/planning/plan-2026-10-07-multi-agent.md 的 M0b）。
 *
 * 用法：node scripts/acp-probe.mjs [选项] <命令> [参数...]
 * 例子：
 *   node scripts/acp-probe.mjs npx -y @agentclientprotocol/claude-agent-acp
 *   node scripts/acp-probe.mjs grok agent stdio
 *   node scripts/acp-probe.mjs --env CODEX_PATH=C:\tools\codex.exe npx -y @agentclientprotocol/codex-acp
 *   node scripts/acp-probe.mjs --try-session opencode acp
 *
 * 说明：
 * - 只做 initialize 时不会建会话、不触发登录；--try-session 才会建会话（并带一个 stdio MCP 回声服务器）。
 * - 探测不读取、不保存任何凭据；命令由你给，用的就是你自己已安装、已登录的 CLI / 官方适配器。
 * - 首次 `npx` 下载可能较慢，必要时加大 --timeout。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./entrypoint.mjs";
import { terminateProcessTree } from "./process-runner.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MCP_WAIT_MS = 5_000;
const VERSION = (() => {
	try {
		return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

export const PROBE_CLIENT_INFO = { name: "piweb-acp-probe", version: VERSION };

export function probeUsage() {
	return [
		"用法：node scripts/acp-probe.mjs [选项] <命令> [参数...]",
		"",
		"选项（都放在命令之前）：",
		"  --try-session      额外试一次 session/new（会建会话；带一个 stdio MCP 回声服务器）",
		"  --cwd <目录>        session/new 的工作目录（默认当前目录）",
		"  --protocol <n>      请求的协议版本（默认 1；试 v2 用 --protocol 2）",
		"  --timeout <秒>      initialize / session/new 的超时（默认 30）",
		"  --env KEY=VALUE     给 Agent 进程追加环境变量（可重复）",
		"  --json              只打印 JSON 报告（便于整段贴回对话）",
		"  -h, --help          显示本帮助",
		"",
		"例子：",
		"  node scripts/acp-probe.mjs npx -y @agentclientprotocol/claude-agent-acp",
		"  node scripts/acp-probe.mjs grok agent stdio",
		"  node scripts/acp-probe.mjs --try-session opencode acp",
		"",
	].join("\n");
}

function takeValue(argv, index, name) {
	const value = argv[index + 1];
	if (value === undefined) throw new Error(`${name} 需要一个值`);
	return value;
}

function positiveInt(raw, name) {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 需要正整数，收到 ${raw}`);
	return value;
}

/** @returns {{help: boolean, json: boolean, trySession: boolean, cwd: string, protocol: number, timeoutMs: number, env: Record<string, string>, command: string | null, args: string[]}} */
export function parseProbeArgs(argv) {
	const options = {
		help: false,
		json: false,
		trySession: false,
		cwd: process.cwd(),
		protocol: 1,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		env: {},
		command: null,
		args: [],
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") { options.help = true; continue; }
		if (arg === "--json") { options.json = true; continue; }
		if (arg === "--try-session") { options.trySession = true; continue; }
		if (arg === "--cwd") { options.cwd = path.resolve(takeValue(argv, index, "--cwd")); index += 1; continue; }
		if (arg === "--protocol") { options.protocol = positiveInt(takeValue(argv, index, "--protocol"), "--protocol"); index += 1; continue; }
		if (arg === "--timeout") { options.timeoutMs = positiveInt(takeValue(argv, index, "--timeout"), "--timeout") * 1000; index += 1; continue; }
		if (arg === "--env") {
			const pair = takeValue(argv, index, "--env");
			const split = pair.indexOf("=");
			if (split <= 0) throw new Error(`--env 需要 KEY=VALUE 形式，收到 ${pair}`);
			options.env[pair.slice(0, split)] = pair.slice(split + 1);
			index += 1;
			continue;
		}
		// 第一个非选项参数就是命令，其后全部是它的参数。
		options.command = arg;
		options.args = argv.slice(index + 1);
		break;
	}
	return options;
}

/**
 * Windows 上把 `.cmd` / `.bat` 走 cmd.exe；其余直接 spawn（与 scripts/launcher.mjs 同样的克制策略）。
 * 查 PATH 固定用 `path.win32`，测试在 Linux 上模拟 win32 时也按 Windows 规则拆分与拼接。
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: Record<string, string | undefined>, platform?: NodeJS.Platform, exists?: (candidate: string) => boolean}} [options]
 */
export function resolveLaunch(command, args, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
	if (platform !== "win32") return { file: command, args };
	let file = command;
	if (!command.includes("/") && !command.includes("\\")) {
		const extensions = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean);
		const directories = String(env.PATH ?? env.Path ?? "").split(path.win32.delimiter).filter(Boolean);
		// 无扩展名时只按 PATHEXT 找后缀——同名无扩展名文件在 Windows 上通常是给 sh 用的脚本，spawn 不了。
		const suffixes = /\.[a-z0-9]+$/i.test(command) ? [""] : extensions;
		let found = null;
		for (const directory of directories) {
			for (const suffix of suffixes) {
				const candidate = path.win32.join(directory, command + suffix);
				if (exists(candidate)) { found = candidate; break; }
			}
			if (found) break;
		}
		if (!found) throw new Error(`在 PATH 中找不到命令：${command}`);
		file = found;
	}
	if (/\.(cmd|bat)$/i.test(file)) {
		const line = [file, ...args].map(quoteForCmd).join(" ");
		return { file: env.ComSpec ?? process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", line] };
	}
	return { file, args };
}

function quoteForCmd(token) {
	if (token === "") return '""';
	if (token.includes('"')) throw new Error(`暂不支持带引号的参数：${token}`);
	return /[\s&|<>^()]/.test(token) ? `"${token}"` : token;
}

/** ACP 用换行分隔的 JSON-RPC 2.0（stdio）。 */
class AcpWire {
	constructor(child, { onRequest, onNotification, onProtocolError } = {}) {
		this.child = child;
		this.onRequest = onRequest;
		this.onNotification = onNotification;
		this.onProtocolError = onProtocolError;
		this.pending = new Map();
		this.nextId = 1;
		this.buffer = "";
		if (child.stdout) {
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => this.feed(chunk));
		}
	}

	feed(chunk) {
		this.buffer += chunk;
		let index;
		while ((index = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			let message;
			try { message = JSON.parse(line); } catch { this.onProtocolError?.(line); continue; }
			this.dispatch(message);
		}
	}

	dispatch(message) {
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			pending.resolve(message);
			return;
		}
		if (message.id !== undefined && message.method) { this.onRequest?.(message); return; }
		if (message.method) this.onNotification?.(message);
	}

	failAll(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	request(method, params, timeoutMs) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} 超时（${timeoutMs}ms）`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, timer });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	respondError(id, code, message) {
		this.send({ jsonrpc: "2.0", id, error: { code, message } });
	}

	send(message) {
		if (!this.child.stdin || this.child.stdin.destroyed) return;
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	closeStdin() {
		try { this.child.stdin?.end(); } catch { /* 进程可能已退出 */ }
	}
}

/** 探测用的 MCP 回声服务器：支持 initialize / tools/list / tools/call / ping，并把收到的消息写进日志文件。 */
const MCP_ECHO_SOURCE = `#!/usr/bin/env node
// PiWeb ACP 探测用的 MCP 回声服务器（stdio，换行分隔 JSON-RPC）。
import fs from "node:fs";

const logPath = process.env.PIWEB_PROBE_MCP_LOG ?? "";
const log = (direction, message) => {
	if (!logPath) return;
	try { fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), direction, message }) + "\\n"); } catch { /* 日志尽力而为 */ }
};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		log("in", message);
		const { id, method, params } = message;
		if (method === "initialize") {
			send({ jsonrpc: "2.0", id, result: {
				protocolVersion: params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "piweb-probe-echo", version: "1.0.0" },
			} });
		} else if (method === "notifications/initialized") {
			// 通知，无回应
		} else if (method === "tools/list") {
			send({ jsonrpc: "2.0", id, result: { tools: [{
				name: "piweb_probe_echo",
				description: "Echo text back (PiWeb ACP probe).",
				inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			}] } });
		} else if (method === "tools/call") {
			send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo: " + String(params?.arguments?.text ?? "") }] } });
		} else if (method === "ping") {
			send({ jsonrpc: "2.0", id, result: {} });
		} else if (id !== undefined) {
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: "not found" } });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
`;

function readMcpLog(logPath, limit = 30) {
	if (!fs.existsSync(logPath)) return [];
	const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(-limit);
	const entries = [];
	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			entries.push({
				direction: entry.direction,
				method: entry.message?.method ?? (entry.message?.id !== undefined ? `response#${entry.message.id}` : "?"),
				preview: JSON.stringify(entry.message).slice(0, 400),
			});
		} catch { /* 忽略半行 */ }
	}
	return entries;
}

async function waitForMcpActivity(logPath, waitMs) {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const entries = readMcpLog(logPath);
		const called = entries.some((entry) => entry.direction === "in" && (entry.method === "tools/list" || entry.method === "tools/call"));
		if (called || Date.now() >= deadline) return entries;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

async function waitForExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise((resolve) => {
		const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
		const timer = setTimeout(finish, timeoutMs);
		child.once("exit", finish);
	});
}

/**
 * @param {ReturnType<typeof parseProbeArgs>} options
 * @param {{spawnImpl?: typeof spawn}} [deps]
 */
export async function runProbe(options, { spawnImpl = spawn } = {}) {
	const report = {
		command: options.command,
		args: options.args,
		protocolRequested: options.protocol,
		trySession: options.trySession,
		cwd: options.cwd,
		ok: false,
		spawnError: null,
		agentRequests: [],
		notifications: [],
		protocolErrors: [],
		initialize: null,
		sessionNew: null,
		mcpEcho: null,
		stderrTail: "",
	};
	const env = { ...process.env, ...options.env };
	const launch = resolveLaunch(options.command, options.args, { env });
	const child = spawnImpl(launch.file, launch.args, {
		cwd: process.cwd(),
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	let stderr = "";
	if (child.stderr) {
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
	}
	const wire = new AcpWire(child, {
		onRequest: (message) => {
			report.agentRequests.push({ method: message.method });
			wire.respondError(message.id, -32601, `piweb acp probe does not implement ${message.method}`);
		},
		onNotification: (message) => {
			if (report.notifications.length < 20) report.notifications.push({ method: message.method });
		},
		onProtocolError: (line) => {
			if (report.protocolErrors.length < 10) report.protocolErrors.push(line.slice(0, 200));
		},
	});
	const spawnFailure = new Promise((_, reject) => {
		child.once("error", (error) => {
			report.spawnError = error.message;
			reject(error);
		});
	});
	child.once("exit", (code, signal) => {
		wire.failAll(new Error(`Agent 进程提前退出（code=${code ?? "null"} signal=${signal ?? "null"}）`));
	});
	let tempDirectory = null;
	try {
		const initializeRequest = wire.request("initialize", {
			protocolVersion: options.protocol,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: PROBE_CLIENT_INFO,
		}, options.timeoutMs);
		// race 落败（或 spawn 失败）后这个 promise 仍可能超时拒绝，先挂一个处理器避免未处理拒绝。
		void initializeRequest.catch(() => {});
		const response = await Promise.race([initializeRequest, spawnFailure])
			.catch((error) => ({ error: { code: -1, message: error.message } }));
		report.initialize = { ok: response.error === undefined, result: response.result, error: response.error };
		if (report.initialize.ok && options.trySession) {
			tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-acp-probe-"));
			const echoPath = path.join(tempDirectory, "mcp-echo.mjs");
			const logPath = path.join(tempDirectory, "mcp-echo.log");
			fs.writeFileSync(echoPath, MCP_ECHO_SOURCE);
			const sessionResponse = await wire.request("session/new", {
				cwd: options.cwd,
				mcpServers: [{
					name: "piweb-probe-echo",
					command: process.execPath,
					args: [echoPath],
					env: [{ name: "PIWEB_PROBE_MCP_LOG", value: logPath }],
				}],
			}, options.timeoutMs).catch((error) => ({ error: { code: -1, message: error.message } }));
			report.sessionNew = { ok: sessionResponse.error === undefined, result: sessionResponse.result, error: sessionResponse.error };
			const entries = report.sessionNew.ok ? await waitForMcpActivity(logPath, MCP_WAIT_MS) : [];
			report.mcpEcho = { used: entries.some((entry) => entry.direction === "in"), entries };
		}
		report.ok = report.initialize.ok === true;
	} finally {
		wire.closeStdin();
		await waitForExit(child, 1_500);
		await terminateProcessTree(child);
		if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
		report.stderrTail = stderr.trim().split("\n").slice(-12).join("\n");
	}
	return report;
}

function summarizeCapabilities(result) {
	const lines = [];
	const capabilities = result.agentCapabilities ?? {};
	const prompt = capabilities.promptCapabilities ?? {};
	const mcp = capabilities.mcpCapabilities ?? {};
	lines.push("能力：");
	lines.push(`  · 载入历史（loadSession）：${capabilities.loadSession === true ? "支持" : "不支持 / 未报告"}`);
	lines.push(`  · 图片输入：${prompt.image === true ? "支持" : "否"}；音频：${prompt.audio === true ? "支持" : "否"}；嵌入上下文：${prompt.embeddedContext === true ? "支持" : "否"}`);
	lines.push(`  · MCP：stdio 经 session/new 的 mcpServers 传入；HTTP ${mcp.http === true ? "支持" : "否"}；SSE ${mcp.sse === true ? "支持" : "否"}`);
	const known = new Set(["loadSession", "promptCapabilities", "mcpCapabilities"]);
	const extra = Object.keys(capabilities).filter((key) => !known.has(key));
	if (extra.length) lines.push(`  · 其他能力键：${extra.join("、")}（看下面的原始 JSON）`);
	const methods = Array.isArray(result.authMethods) ? result.authMethods : [];
	if (methods.length) {
		lines.push("登录方式（authMethods）：");
		for (const method of methods) lines.push(`  · ${method.id ?? "?"}${method.name ? ` — ${method.name}` : ""}${method.description ? `（${method.description}）` : ""}`);
	} else {
		lines.push("登录方式（authMethods）：未报告（可能不需要登录，或登录走 Agent 自己的流程）");
	}
	return lines;
}

function summarizeSession(session) {
	const lines = ["会话（session/new）："];
	if (!session.ok) {
		lines.push(`  · 失败：${session.error?.message ?? "未知错误"}`);
		return lines;
	}
	const data = session.result ?? {};
	lines.push(`  · sessionId：${data.sessionId ?? "（未报告）"}`);
	const modes = data.modes;
	if (modes) {
		const available = Array.isArray(modes.availableModes) ? modes.availableModes : [];
		const list = available.map((mode) => `${mode.id}${mode.id === modes.currentModeId ? "（默认）" : ""}`).join("、");
		lines.push(`  · 模式：${list || "（未报告）"}`);
	}
	const configOptions = Array.isArray(data.configOptions) ? data.configOptions : [];
	for (const option of configOptions) {
		const choices = Array.isArray(option.options)
			? option.options.map((choice) => (typeof choice === "string" ? choice : choice.value ?? choice.id ?? "?")).join("、")
			: "";
		lines.push(`  · 配置项 ${option.id ?? option.name ?? "?"} = ${option.currentValue ?? "?"}${choices ? `（可选：${choices}）` : ""}`);
	}
	const known = new Set(["sessionId", "modes", "configOptions"]);
	const extra = Object.keys(data).filter((key) => !known.has(key));
	if (extra.length) lines.push(`  · 其他字段：${extra.join("、")}（看下面的原始 JSON）`);
	return lines;
}

export function formatProbeReport(report) {
	const lines = ["—— ACP 探测结果 ——"];
	lines.push(`命令：${[report.command, ...report.args].join(" ")}`);
	if (report.spawnError) lines.push(`启动失败：${report.spawnError}`);
	const initialize = report.initialize ?? {};
	const result = initialize.result ?? {};
	lines.push(`协议版本：请求 v${report.protocolRequested} → 返回 ${result.protocolVersion !== undefined ? `v${result.protocolVersion}` : "（未报告）"}`);
	if (result.agentInfo) lines.push(`Agent：${`${result.agentInfo.name ?? "?"} ${result.agentInfo.version ?? ""}`.trim()}`);
	if (!initialize.ok) {
		lines.push(`initialize 失败：${initialize.error?.message ?? "未知错误"}`);
	} else {
		lines.push(...summarizeCapabilities(result));
	}
	if (report.agentRequests.length) lines.push(`Agent 反向请求：${report.agentRequests.map((entry) => entry.method).join("、")}（探测脚本一律回错误，不代劳）`);
	if (report.notifications.length) lines.push(`Agent 通知：${[...new Set(report.notifications.map((entry) => entry.method))].join("、")}`);
	if (report.protocolErrors.length) lines.push(`无法解析的输出：${report.protocolErrors.length} 行（可能不是 ACP）`);
	if (report.sessionNew) lines.push(...summarizeSession(report.sessionNew));
	else if (report.ok && !report.trySession) lines.push("会话（session/new）：未测试（加 --try-session 再跑一次）");
	if (report.mcpEcho) lines.push(`MCP 回声服务器：Agent ${report.mcpEcho.used ? "已调用" : "未调用"}（收到 ${report.mcpEcho.entries.length} 条消息）`);
	if (report.stderrTail) {
		lines.push("Agent stderr 末尾：");
		for (const line of report.stderrTail.split("\n")) lines.push(`  ${line}`);
	}
	lines.push("");
	lines.push("原始 JSON（可整段贴回对话）：");
	lines.push(JSON.stringify(report, null, 2));
	return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
	try {
		const options = parseProbeArgs(process.argv.slice(2));
		if (options.help || !options.command) {
			process.stdout.write(probeUsage());
			process.exitCode = options.help ? 0 : 1;
		} else {
			const report = await runProbe(options);
			process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatProbeReport(report)}\n`);
			process.exitCode = report.ok ? 0 : 2;
		}
	} catch (error) {
		process.stderr.write(`[acp-probe] ${error instanceof Error ? error.message : error}\n`);
		process.stderr.write("用 --help 查看用法。\n");
		process.exitCode = 1;
	}
}
