/**
 * End-to-end HTML export redaction test through `exportSession(..., "html")` and real Pi SDK `exportToHtml`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }),
}));

import { exportSession } from "@/lib/agent-manager";

type Managed = Parameters<typeof exportSession>[0];

const SYNTHETIC_SK = "sk-proj-SyntheticHtmlRedactionKey987654";
const SYNTHETIC_GHP = "ghp_SyntheticGitHubToken0123456789abcd";
const SYNTHETIC_BEARER = "eyJhbGciOiJIUzI1NiJ9.synthetic_payload.signature_xyz";
const SYNTHETIC_PROXY_PASS = "syntheticProxySecret99";
const SYNTHETIC_JSON_KEY = "syntheticNestedApiKeyValue";
const SYNTHETIC_ESCAPED_PW = "syntheticEscapedPasswordValue";
const SYNTHETIC_CUSTOM_TOOL_SECRET = "syntheticCustomToolSecretValue";

let root = "";
let agentDir = "";
let sessionPath = "";
let activeSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-html-export-e2e-"));
	agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });

	const sm = SessionManager.create(root, root);
	sm.appendMessage({
		role: "user",
		content: [
			{
				type: "text",
				text: [
					"请保留普通中文与 tokenCount=42。",
					`API key: ${SYNTHETIC_SK}`,
					`Proxy: http://proxy-user:${SYNTHETIC_PROXY_PASS}@proxy.internal:7890`,
					`JSON: ${JSON.stringify({ apiKey: SYNTHETIC_JSON_KEY, name: "keep-name" })}`,
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	});
	sm.appendMessage({
		role: "assistant",
		content: [
			{
				type: "text",
				text: `Authorization: Bearer ${SYNTHETIC_BEARER}\nEscaped: ${JSON.stringify({ payload: JSON.stringify({ password: SYNTHETIC_ESCAPED_PW }) })}`,
			},
			{
				type: "toolCall",
				id: "call_custom_1",
				name: "custom_secret_tool",
				arguments: { token: SYNTHETIC_GHP },
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	sm.appendMessage({
		role: "toolResult",
		toolCallId: "call_custom_1",
		toolName: "custom_secret_tool",
		content: [{ type: "text", text: JSON.stringify({ secret: SYNTHETIC_CUSTOM_TOOL_SECRET, ok: "safe" }) }],
		isError: false,
		timestamp: Date.now(),
	});
	sessionPath = sm.getSessionFile()!;

	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		sessionManager: sm,
		settingsManager,
		resourceLoader,
		customTools: [
			{
				name: "custom_secret_tool",
				label: "Custom Secret Tool",
				description: "Test custom tool HTML pre-rendering",
				parameters: { type: "object", properties: { token: { type: "string" } } } as never,
				async execute() {
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
				renderCall(args, _theme, _context) {
					const text = JSON.stringify({ apiKey: String((args as { token?: string }).token ?? "") });
					return {
						render: () => [text],
						invalidate: () => {},
					};
				},
				renderResult() {
					return {
						render: () => [`{"password":"${SYNTHETIC_CUSTOM_TOOL_SECRET}"}`],
						invalidate: () => {},
					};
				},
			},
		],
	});
	activeSession = session;
});

afterEach(async () => {
	activeSession?.dispose();
	activeSession = null;
	await fs.rm(root, { recursive: true, force: true });
});

function managed(): Managed {
	return {
		sessionPath,
		cwd: root,
		session: activeSession,
		creating: null,
		disposed: false,
		seq: 0,
		buffer: [],
		subscribers: new Set(),
	} as unknown as Managed;
}

function decodeEmbeddedSessionData(html: string): {
	entries: Array<{ type: string; message?: { role: string; content: unknown } }>;
	renderedTools?: Record<string, { callHtml?: string; resultHtmlExpanded?: string }>;
} {
	const match = /<script\b[^>]*id=["']session-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
	expect(match).not.toBeNull();
	const json = Buffer.from(match![1].trim(), "base64").toString("utf8");
	return JSON.parse(json) as {
		entries: Array<{ type: string; message?: { role: string; content: unknown } }>;
		renderedTools?: Record<string, { callHtml?: string; resultHtmlExpanded?: string }>;
	};
}

describe("exportSession html redaction", () => {
	it("redacts all credentials in default HTML export (raw HTML and decoded session-data)", async () => {
		const result = await exportSession(managed(), "html");
		expect(result.contentType).toBe("text/html");
		expect(result.filename.endsWith(".html")).toBe(true);
		expect(result.content).toContain("<!DOCTYPE html>");
		expect(result.content).toContain('<script id="session-data" type="application/json">');

		const secrets = [
			SYNTHETIC_SK,
			SYNTHETIC_GHP,
			SYNTHETIC_BEARER,
			SYNTHETIC_PROXY_PASS,
			SYNTHETIC_JSON_KEY,
			SYNTHETIC_ESCAPED_PW,
			SYNTHETIC_CUSTOM_TOOL_SECRET,
		];
		for (const secret of secrets) {
			expect(result.content).not.toContain(secret);
		}

		const decoded = decodeEmbeddedSessionData(result.content);
		const decodedText = JSON.stringify(decoded);
		for (const secret of secrets) {
			expect(decodedText).not.toContain(secret);
		}

		expect(decodedText).toContain("请保留普通中文与 tokenCount=42");
		expect(decodedText).toContain("sk-proj-***");
		expect(decodedText).toContain("http://proxy-user:***@proxy.internal:7890");
		expect(decodedText).toContain("Authorization: Bearer ***");
		expect(decodedText).toContain("keep-name");

		expect(decoded.renderedTools?.call_custom_1?.callHtml).toContain("{&quot;apiKey&quot;:&quot;***&quot;}");
		expect(decoded.renderedTools?.call_custom_1?.resultHtmlExpanded).toContain("{&quot;password&quot;:&quot;***&quot;}");
	});

	it("preserves raw HTML verbatim when options.raw is true", async () => {
		const result = await exportSession(managed(), "html", { raw: true });
		expect(result.contentType).toBe("text/html");
		const decoded = decodeEmbeddedSessionData(result.content);
		const decodedText = JSON.stringify(decoded);
		expect(decodedText).toContain(SYNTHETIC_SK);
		expect(decodedText).toContain(SYNTHETIC_GHP);
		expect(decodedText).toContain(SYNTHETIC_BEARER);
		expect(decodedText).toContain(SYNTHETIC_PROXY_PASS);
		expect(decodedText).toContain(SYNTHETIC_JSON_KEY);
		expect(decodedText).toContain(SYNTHETIC_ESCAPED_PW);
		expect(decodedText).toContain(SYNTHETIC_CUSTOM_TOOL_SECRET);
	});
});
