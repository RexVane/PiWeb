import fs from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchTokenFile, publishLaunchToken } from "../src/lib/web-launch-token";
import { REVOCATIONS_FILENAME, SECRET_BYTES, decodeSecret, encodeSecret, loadSessionRevocations, loadWebSecret, resetWebSecretCache, revokeAllSessions, revokeSessionCookie, secretFilePath } from "../src/lib/web-secret";
import { createSessionCookie, validSessionCookie } from "../src/lib/web-auth";
import { validCookieValue as validProtocolCookie } from "../scripts/web-auth-protocol.mjs";
import { issuePairCode, resetPairingState, verifyPairCode } from "../src/lib/remote/pairing";
import { recycleFixture } from "./fixtures/recycle";

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

afterEach(async () => {
	vi.restoreAllMocks();
	for (const name of ENV_NAMES) {
		const value = saved.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	resetWebSecretCache();
	resetPairingState();
	await recycleFixture(dir);
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
		// 没有端口或令牌就什么都不写（POSIX 另有该端口的私有 IPC socket 侧车文件，Windows 用命名管道）
		publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: token });
		const published = fs.readdirSync(path.join(dir, "agent", "web-launch"));
		expect(published.filter((name) => name.endsWith(".token"))).toEqual(["30177.token"]);
		expect(published.every((name) => name === "30177.token" || name === "30177.socket")).toBe(true);
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

	it("retains prior revocations when a reader briefly blocks replacing the file", async () => {
		await revokeSessionCookie("kept", 9_000, 1_000);
		const sharingError = Object.assign(new Error("Reader holds the revocations file"), { code: "EPERM" });
		const syncRename = fs.renameSync.bind(fs);
		const asyncRename = fsAsync.rename.bind(fsAsync);
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw sharingError; }).mockImplementation(syncRename);
		vi.spyOn(fsAsync, "rename").mockRejectedValueOnce(sharingError).mockImplementation(asyncRename);
		await revokeAllSessions(5_000);
		resetWebSecretCache();
		expect(loadSessionRevocations().notBefore).toBe(5_000);
		expect(loadSessionRevocations().revoked.get("kept")).toBe(9_000);
	});

	it("starts empty and remembers a revoked cookie until it would have expired", async () => {
		expect(loadSessionRevocations()).toMatchObject({ notBefore: 0 });
		expect(loadSessionRevocations().revoked.size).toBe(0);
		await revokeSessionCookie("old", 1_500, 1_000);
		await revokeSessionCookie("kept", 9_000, 1_000);
		expect([...loadSessionRevocations().revoked.keys()].sort()).toEqual(["kept", "old"]);
		// 过期的记录在下一次写入时被清掉
		await revokeSessionCookie("new", 9_000, 2_000);
		expect([...loadSessionRevocations().revoked.keys()].sort()).toEqual(["kept", "new"]);
		// 落盘了：清缓存再读还在
		resetWebSecretCache();
		expect(loadSessionRevocations().revoked.get("kept")).toBe(9_000);
	});

	it("moves the not-before line forward and retains unexpired individual revocations", async () => {
		await revokeSessionCookie("a", 9_000, 1_000);
		await revokeAllSessions(5_000);
		expect(loadSessionRevocations().notBefore).toBe(5_000);
		expect(loadSessionRevocations().revoked.get("a")).toBe(9_000);
		await revokeAllSessions(4_000);
		expect(loadSessionRevocations().notBefore).toBe(5_001);
	});
	it("advances each logout generation at a fixed or backwards clock without blocking a new login", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(5_000);
		const secret = Buffer.alloc(32, 7);
		await revokeAllSessions();
		const first = loadSessionRevocations();
		expect(first.notBefore).toBe(5_001);
		const cookie = createSessionCookie("localhost", secret, Date.now(), "fixture", first.notBefore);
		const pair = issuePairCode(Date.now(), first.notBefore);
		const request = new Request("http://localhost/", { headers: { cookie: `${cookie.name}=${cookie.value}` } });
		expect(validSessionCookie(request, secret, Date.now(), first)).toBe(true);
		expect(validProtocolCookie(cookie.value, "localhost", secret, Date.now(), first)).toBe(true);
		await revokeAllSessions();
		const second = loadSessionRevocations();
		expect(second.notBefore).toBe(5_002);
		expect(validSessionCookie(request, secret, Date.now(), second)).toBe(false);
		expect(validProtocolCookie(cookie.value, "localhost", secret, Date.now(), second)).toBe(false);
		expect(verifyPairCode(pair.code, Date.now(), second.notBefore)).toMatchObject({ ok: false });
		clock.mockReturnValue(4_000);
		await revokeAllSessions();
		const third = loadSessionRevocations();
		expect(third.notBefore).toBe(5_003);
		const fresh = createSessionCookie("localhost", secret, Date.now(), "fixture", third.notBefore);
		expect(validSessionCookie(new Request("http://localhost/", { headers: { cookie: `${fresh.name}=${fresh.value}` } }), secret, Date.now(), third)).toBe(true);
		expect(validProtocolCookie(fresh.value, "localhost", secret, Date.now(), third)).toBe(true);
		const nextPair = issuePairCode(Date.now(), third.notBefore);
		expect(verifyPairCode(nextPair.code, Date.now(), third.notBefore)).toEqual({ ok: true });
	});

	it("fails closed on a corrupt revocation file while retaining its original bytes", async () => {
		fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
		fs.writeFileSync(path.join(dir, "agent", REVOCATIONS_FILENAME), "{oops");
		expect(loadSessionRevocations()).toMatchObject({ unavailable: true });
		await expect(revokeAllSessions(7_000)).rejects.toThrow("unavailable");
		expect(fs.readFileSync(path.join(dir, "agent", REVOCATIONS_FILENAME), "utf8")).toBe("{oops");
	});
});
