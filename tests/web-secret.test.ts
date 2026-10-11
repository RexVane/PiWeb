import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchTokenFile, publishLaunchToken } from "../src/lib/web-launch-token";
import { REVOCATIONS_FILENAME, SECRET_BYTES, decodeSecret, encodeSecret, loadSessionRevocations, loadWebSecret, resetWebSecretCache, revokeAllSessions, revokeSessionCookie, secretFilePath } from "../src/lib/web-secret";

const ENV_NAMES = ["PI_WEB_SECRET_FILE", "PI_WEB_SECRET", "PI_CODING_AGENT_DIR"] as const;
const saved = new Map<string, string | undefined>(ENV_NAMES.map((name) => [name, process.env[name]]));
let dir = "";
let file = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-secret-"));
	file = path.join(dir, "web-secret");
	process.env.PI_WEB_SECRET_FILE = file;
	delete process.env.PI_WEB_SECRET;
	resetWebSecretCache();
});

afterEach(() => {
	for (const name of ENV_NAMES) {
		const value = saved.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	resetWebSecretCache();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("web secret", () => {
	it("creates a 32-byte key on first use and reuses it afterwards", () => {
		const first = loadWebSecret();
		expect(first.byteLength).toBe(SECRET_BYTES);
		// 清缓存后再读，必须还是同一把（证明落盘了）
		resetWebSecretCache();
		const second = loadWebSecret();
		expect(second.equals(first)).toBe(true);
		expect(decodeSecret(fs.readFileSync(file, "utf8"))?.equals(first)).toBe(true);
	});

	it("writes the file with owner-only permissions on POSIX", () => {
		loadWebSecret();
		if (process.platform !== "win32") {
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		}
	});

	it("prefers PI_WEB_SECRET over the file", () => {
		process.env.PI_WEB_SECRET = encodeSecret(Buffer.alloc(32, 3));
		expect(loadWebSecret().equals(Buffer.alloc(32, 3))).toBe(true);
	});

	it("rejects an inline secret of the wrong size", () => {
		process.env.PI_WEB_SECRET = encodeSecret(Buffer.alloc(16, 3));
		expect(() => loadWebSecret()).toThrow();
	});

	it("fails loudly on a corrupt secret file instead of silently rotating it", () => {
		fs.writeFileSync(file, "not-a-key\n");
		expect(() => loadWebSecret()).toThrow();
	});

	it("resolves the path from the agent directory when none is configured", () => {
		delete process.env.PI_WEB_SECRET_FILE;
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
		expect(secretFilePath()).toBe(path.join(dir, "agent", "web-secret"));
	});

	it("leaves the launch token where the launcher looks for it", async () => {
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
		const token = "tok_abcdefghijklmnopqrstuvwxyz";
		publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: token, PIWEB_PORT: "30177" });
		expect(fs.readFileSync(launchTokenFile(30177), "utf8").trim()).toBe(token);
		// 服务端写、启动器读，两边的路径规则必须一致
		const { readLaunchToken } = await import("../scripts/launcher.mjs");
		expect(readLaunchToken(30177, { PI_CODING_AGENT_DIR: path.join(dir, "agent") })).toBe(token);
		// 没有端口或令牌就什么都不写
		publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: token });
		expect(fs.readdirSync(path.join(dir, "agent", "web-launch"))).toEqual(["30177.token"]);
	});

	it("decodes base64url strictly", () => {
		expect(decodeSecret("!!!")).toBeUndefined();
		expect(decodeSecret("")).toBeUndefined();
		expect(decodeSecret(encodeSecret(Buffer.alloc(31, 1)))).toBeUndefined();
		expect(decodeSecret(encodeSecret(Buffer.alloc(32, 1)))).toBeDefined();
	});
});

describe("session revocations", () => {
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
	});

	it("starts empty and remembers a revoked cookie until it would have expired", () => {
		expect(loadSessionRevocations()).toMatchObject({ notBefore: 0 });
		expect(loadSessionRevocations().revoked.size).toBe(0);
		revokeSessionCookie("old", 1_500, 1_000);
		revokeSessionCookie("kept", 9_000, 1_000);
		expect([...loadSessionRevocations().revoked.keys()].sort()).toEqual(["kept", "old"]);
		// 过期的记录在下一次写入时被清掉
		revokeSessionCookie("new", 9_000, 2_000);
		expect([...loadSessionRevocations().revoked.keys()].sort()).toEqual(["kept", "new"]);
		// 落盘了：清缓存再读还在
		resetWebSecretCache();
		expect(loadSessionRevocations().revoked.get("kept")).toBe(9_000);
	});

	it("moves the not-before line forward only, and clears single revocations with it", () => {
		revokeSessionCookie("a", 9_000, 1_000);
		revokeAllSessions(5_000);
		expect(loadSessionRevocations().notBefore).toBe(5_000);
		expect(loadSessionRevocations().revoked.size).toBe(0);
		revokeAllSessions(4_000);
		expect(loadSessionRevocations().notBefore).toBe(5_000);
	});

	it("treats a corrupt file as no revocations rather than locking everyone out", () => {
		fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
		fs.writeFileSync(path.join(dir, "agent", REVOCATIONS_FILENAME), "{oops");
		expect(loadSessionRevocations()).toMatchObject({ notBefore: 0 });
		// 再写一次就修好了
		revokeAllSessions(7_000);
		expect(loadSessionRevocations().notBefore).toBe(7_000);
	});
});
