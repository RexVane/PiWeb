import { describe, expect, it } from "vitest";
import { redactExportedHtml, redactJsonl, redactSecrets, redactUrlCredentials } from "../../src/lib/secret-redaction";

const LONG_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx";
const LONG_BEARER = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

describe("redactSecrets", () => {
	it("does not touch ordinary content", () => {
		for (const text of [
			"普通中文内容，没有任何凭据。",
			"读取 token 字段的说明文档，tokenCount: 42，tokens 是普通单词。",
			"http://localhost:7890/path?q=1",
			"https://example.com/docs/api-key-management",
			"{\"tokenCount\":123,\"tokens\":\"not-a-secret\",\"name\":\"pi\"}",
			"版本 1.2.3，时间 2026-11-15T20:00:00Z",
		]) {
			expect(redactSecrets(text), text).toBe(text);
		}
	});

	it("masks URL userinfo passwords but keeps user and host", () => {
		expect(redactUrlCredentials("http://user:pass@127.0.0.1:7890")).toBe("http://user:***@127.0.0.1:7890");
		expect(redactUrlCredentials("socks5://app:p%40ss@proxy.local:1080")).toBe("socks5://app:***@proxy.local:1080");
		const text = "httpProxy=http://user:secret@proxy:8080 and other text";
		expect(redactSecrets(text)).toBe("httpProxy=http://user:***@proxy:8080 and other text");
	});

	it("masks API keys with common prefixes", () => {
		const redacted = redactSecrets(`key=${LONG_KEY} other=SK-SHORT7 tail`);
		expect(redacted).not.toContain(LONG_KEY);
		expect(redacted).toContain("sk-proj-***");
		// 短于 8 位的普通字符串不当作 key
		expect(redactSecrets("sk-abc")).toBe("sk-abc");
		for (const key of ["ghp_abcdefghijklmnopqrstuvwxyz0123", "xoxb-1234567890-abcdef", "AKIAIOSFODNN7EXAMPLE", "AIzaSyA1234567890abcdefghijklmnopqrstu"]) {
			expect(redactSecrets(`token ${key}`), key).not.toContain(key);
		}
	});

	it("masks bearer tokens", () => {
		expect(redactSecrets(`Authorization: Bearer ${LONG_BEARER}`)).toBe("Authorization: Bearer ***");
		expect(redactSecrets(`authorization: bearer ${LONG_BEARER}`)).toBe("authorization: bearer ***");
	});

	it("masks JSON secret field values and keeps the JSON valid", () => {
		const input = JSON.stringify({ apiKey: LONG_KEY, password: "hunter2", token: "abc", secret: "s3cr3t", trackingId: "track-1", tokenCount: 7, name: "pi" });
		const output = redactSecrets(input);
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.apiKey).toBe("***");
		expect(parsed.password).toBe("***");
		expect(parsed.token).toBe("***");
		expect(parsed.secret).toBe("***");
		expect(parsed.trackingId).toBe("***");
		expect(parsed.tokenCount).toBe(7);
		expect(parsed.name).toBe("pi");
		expect(output).not.toContain("hunter2");
	});

	it("is idempotent", () => {
		const input = `{"apiKey":"${LONG_KEY}","httpProxy":"http://u:p@proxy:8080"} Authorization: Bearer ${LONG_BEARER}`;
		const once = redactSecrets(input);
		expect(redactSecrets(once)).toBe(once);
	});

	it("also redacts HTML export bodies without breaking their text", () => {
		const html = `<html><body><p>key ${LONG_KEY}</p><a href="http://u:p@proxy:8080">proxy</a></body></html>`;
		const redacted = redactSecrets(html);
		expect(redacted).not.toContain(LONG_KEY);
		expect(redacted).toContain("<p>key sk-proj-***</p>");
		expect(redacted).toContain('href="http://u:***@proxy:8080"');
		expect(redacted).toContain("<html><body>");
	});
});

describe("redactJsonl", () => {
	it("redacts every line and keeps line boundaries, order and JSON validity", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "普通内容" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", apiKey: LONG_KEY, httpProxy: "http://u:p@proxy:8080" } }),
			JSON.stringify({ type: "meta", token: "abc123", tokenCount: 99 }),
		];
		const input = `${lines.join("\n")}\n`;
		const output = redactJsonl(input);
		const outLines = output.split("\n");
		expect(outLines).toHaveLength(4);
		expect(outLines[3]).toBe("");
		for (const line of outLines.slice(0, 3)) expect(() => JSON.parse(line)).not.toThrow();
		const second = JSON.parse(outLines[1]) as { message: Record<string, unknown> };
		expect(second.message.apiKey).toBe("***");
		expect(second.message.httpProxy).toBe("http://u:***@proxy:8080");
		expect(outLines[2]).toContain('"token":"***"');
		expect(outLines[2]).toContain('"tokenCount":99');
		expect(outLines[0]).toBe(lines[0]);
	});

	it("preserves CRLF line endings", () => {
		const line = JSON.stringify({ token: "abc" });
		expect(redactJsonl(`${line}\r\n${line}\r\n`)).toBe(`${line.replace('"abc"', '"***"')}\r\n${line.replace('"abc"', '"***"')}\r\n`);
	});

	it("returns empty input unchanged", () => {
		expect(redactJsonl("")).toBe("");
	});

	it("redacts escaped JSON secrets embedded inside JSONL string fields", () => {
		const line = JSON.stringify({
			type: "message",
			message: { role: "toolResult", content: JSON.stringify({ apiKey: "custom-inner-secret", password: "inner-password", note: "普通文本" }) },
		});
		const redacted = redactJsonl(line);
		expect(redacted).not.toContain("custom-inner-secret");
		expect(redacted).not.toContain("inner-password");
		const parsed = JSON.parse(redacted) as { message: { content: string } };
		expect(JSON.parse(parsed.message.content)).toEqual({ apiKey: "***", password: "***", note: "普通文本" });
	});
});

describe("redactExportedHtml", () => {
	function extractSessionData(html: string): Record<string, unknown> {
		const match = /<script\b[^>]*id=["']session-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
		expect(match).not.toBeNull();
		const b64 = match![1].trim();
		return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
	}

	it("redacts base64-encoded session-data JSON including nested JSON, CJK, and renderedTools", () => {
		const sessionData = {
			header: { type: "session", version: 3, id: "sess-1", timestamp: "2026-11-27T00:00:00Z", cwd: "/tmp/proj" },
			entries: [
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-11-27T00:00:01Z",
					message: {
						role: "user",
						content: [
							{ type: "text", text: `普通中文内容 tokenCount=42 key=${LONG_KEY} proxy=http://alice:hunter2@proxy.local:8080` },
							{ type: "text", text: JSON.stringify({ apiKey: "nested-json-secret", trackingId: "trk-999", ok: "keep-me" }) },
							{ type: "text", text: `Prefix {\"password\":\"escaped-json-pass\"} suffix` },
						],
					},
				},
				{
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2026-11-27T00:00:02Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `Authorization: Bearer ${LONG_BEARER}` }],
						apiKey: "top-level-key",
					},
				},
			],
			leafId: "m2",
			systemPrompt: "System prompt with ghp_abcdefghijklmnopqrstuvwxyz0123",
			tools: [{ name: "bash", description: "Run shell" }],
			renderedTools: {
				call_1: {
					callHtml: '<div class="ansi-line">{&quot;apiKey&quot;:&quot;rendered-secret&quot;}</div>',
					resultHtmlExpanded: `<div class="ansi-line">Bearer ${LONG_BEARER} &nbsp; 普通</div>`,
				},
			},
		};
		const b64 = Buffer.from(JSON.stringify(sessionData), "utf8").toString("base64");
		const html = `<!DOCTYPE html><html><head><style>body{color:#fff}</style></head><body><div id="messages"></div><script id="session-data" type="application/json">${b64}</script><script>const data = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array()));</script></body></html>`;

		const redacted = redactExportedHtml(html);
		expect(redacted).not.toContain(LONG_KEY);
		expect(redacted).not.toContain("hunter2");
		expect(redacted).not.toContain("nested-json-secret");
		expect(redacted).not.toContain("trk-999");
		expect(redacted).not.toContain("escaped-json-pass");
		expect(redacted).not.toContain(LONG_BEARER);
		expect(redacted).not.toContain("top-level-key");
		expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
		expect(redacted).not.toContain("rendered-secret");

		const decoded = extractSessionData(redacted) as typeof sessionData;
		expect(decoded.leafId).toBe("m2");
		expect(decoded.systemPrompt).toBe("System prompt with ghp_***");
		expect(decoded.entries[0].message.content[0].text).toBe("普通中文内容 tokenCount=42 key=sk-proj-*** proxy=http://alice:***@proxy.local:8080");
		expect(JSON.parse(decoded.entries[0].message.content[1].text)).toEqual({ apiKey: "***", trackingId: "***", ok: "keep-me" });
		expect(decoded.entries[0].message.content[2].text).toBe('Prefix {"password":"***"} suffix');
		expect((decoded.entries[1].message as { apiKey?: string }).apiKey).toBe("***");
		expect(decoded.entries[1].message.content[0].text).toBe("Authorization: Bearer ***");
		expect(decoded.renderedTools.call_1.callHtml).toBe('<div class="ansi-line">{&quot;apiKey&quot;:&quot;***&quot;}</div>');
		expect(decoded.renderedTools.call_1.resultHtmlExpanded).toBe('<div class="ansi-line">Bearer *** &nbsp; 普通</div>');
	});

	it("redacts raw JSON scripts, atob payloads, data-* attributes, data URIs, and HTML entities while preserving ordinary markup", () => {
		const inlinePayload = Buffer.from(JSON.stringify({ secret: "atob-secret", name: "ok" }), "utf8").toString("base64");
		const attrPayload = Buffer.from(JSON.stringify({ token: "attr-b64-secret" }), "utf8").toString("base64");
		const dataUriPayload = Buffer.from(JSON.stringify({ password: "uri-secret" }), "utf8").toString("base64");
		const pngUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

		const html = [
			"<html><body>",
			`<p>Hello&nbsp;world &copy; 2026 &amp; plain text</p>`,
			`<p>{&quot;apiKey&quot;:&quot;entity-secret&quot;,&quot;keep&quot;:&quot;yes&quot;} &nbsp; http://u&#58;entitypass&#64;proxy:8080</p>`,
			`<div data-session="${attrPayload}" data-config="{&quot;password&quot;:&quot;attr-entity-secret&quot;}"></div>`,
			`<a href="data:application/json;base64,${dataUriPayload}">dl</a>`,
			`<img src="${pngUri}" alt="pixel">`,
			`<script type="application/json">{"apiKey":"raw-json-secret","html":"\\u003c/script>"}</script>`,
			`<script>const x = atob("${inlinePayload}"); const y = "${LONG_KEY}";</script>`,
			"</body></html>",
		].join("");

		const redacted = redactExportedHtml(html);
		expect(redacted).not.toContain("atob-secret");
		expect(redacted).not.toContain("attr-b64-secret");
		expect(redacted).not.toContain("uri-secret");
		expect(redacted).not.toContain("entity-secret");
		expect(redacted).not.toContain("entitypass");
		expect(redacted).not.toContain("attr-entity-secret");
		expect(redacted).not.toContain("raw-json-secret");
		expect(redacted).not.toContain(LONG_KEY);

		expect(redacted).toContain("<p>Hello&nbsp;world &copy; 2026 &amp; plain text</p>");
		expect(redacted).toContain("{&quot;apiKey&quot;:&quot;***&quot;,&quot;keep&quot;:&quot;yes&quot;} &nbsp; http://u:***@proxy:8080");
		expect(redacted).toContain('data-config="{&quot;password&quot;:&quot;***&quot;}"');
		expect(redacted).toContain(pngUri);
		expect(redacted).toContain('{"apiKey":"***","html":"<\\/script>"}');

		const attrMatch = /data-session="([^"]+)"/.exec(redacted);
		expect(JSON.parse(Buffer.from(attrMatch![1], "base64").toString("utf8"))).toEqual({ token: "***" });

		const atobMatch = /atob\("([^"]+)"\)/.exec(redacted);
		expect(JSON.parse(Buffer.from(atobMatch![1], "base64").toString("utf8"))).toEqual({ secret: "***", name: "ok" });

		const dataUriMatch = /data:application\/json;base64,([A-Za-z0-9+/=]+)/.exec(redacted);
		expect(JSON.parse(Buffer.from(dataUriMatch![1], "base64").toString("utf8"))).toEqual({ password: "***" });

		expect(redactExportedHtml(redacted)).toBe(redacted);
	});
});
