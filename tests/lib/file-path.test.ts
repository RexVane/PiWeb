/**
 * 正文里的文件路径识别。
 *
 * 这条测试的重点是「不认什么」——误判的代价比漏认大得多：把普通文字变成可点的链接，
 * 用户点开只会看到一个「文件不存在」。所以下面把版本号、URL、邮箱、绝对路径、
 * 通配符等容易混淆的形状都钉住。
 */
import { describe, expect, it } from "vitest";
import { looksLikeFilePath } from "@/lib/chat/file-path";

describe("looksLikeFilePath", () => {
	it("accepts relative paths with a directory", () => {
		for (const value of [
			"src/lib/pi.ts",
			"./scripts/dev.mjs",
			"../tests/lib/font.ts",
			"src/app/api/agent/[id]/route.ts",
			"docs/state/progress.md",
		]) {
			expect(looksLikeFilePath(value), value).toBe(true);
		}
	});

	it("accepts bare filenames only for known code and document extensions", () => {
		for (const value of ["package.json", "AGENTS.md", "vite.config.ts", "next.config.mjs", "globals.css"]) {
			expect(looksLikeFilePath(value), value).toBe(true);
		}
	});

	it("rejects version numbers that look like filenames", () => {
		for (const value of ["1.2", "1.2.3", "v1.2.3", "1.2.3-beta.1", "v0.3.24"]) {
			expect(looksLikeFilePath(value), value).toBe(false);
		}
	});

	it("rejects URLs, emails and protocol-relative addresses", () => {
		for (const value of [
			"https://example.com/v1",
			"http://127.0.0.1:30141/api",
			"//cdn.example.com/a.js",
			"www.example.com/index.html",
			"user@example.com",
		]) {
			expect(looksLikeFilePath(value), value).toBe(false);
		}
	});

	it("rejects absolute and home paths because they are not the current workspace", () => {
		for (const value of ["/etc/hosts", "~/.pi/agent/settings.json", "C:/Users/x/app.ts", "C:\\Users\\x\\app.ts"]) {
			expect(looksLikeFilePath(value), value).toBe(false);
		}
	});

	it("rejects fragments with wildcards, placeholders or spaces", () => {
		for (const value of ["src/**/*.ts", "src/<name>.ts", "src/{a,b}.ts", "src/lib/pi.ts 里", "a b.ts", "*.md"]) {
			expect(looksLikeFilePath(value), value).toBe(false);
		}
	});

	it("rejects a bare word and a bare extension-less name", () => {
		for (const value of ["", "readme", "LICENSE", "Makefile", "something.unknownext"]) {
			expect(looksLikeFilePath(value), value).toBe(false);
		}
	});

	it("rejects over-long fragments", () => {
		expect(looksLikeFilePath(`src/${"a".repeat(300)}.ts`)).toBe(false);
	});
});
