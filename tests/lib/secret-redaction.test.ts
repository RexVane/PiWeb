import { describe, expect, it } from "vitest";
import { redactJsonl, redactSecrets, redactUrlCredentials } from "../../src/lib/secret-redaction";

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
});
