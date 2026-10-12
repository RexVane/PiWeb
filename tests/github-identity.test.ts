/**
 * GitHub 身份解析：remote owner / 仓库名的解析，以及「取不到就降级」的行为。
 * 不碰网络：`parseGithubRemote` 是纯函数；离线分支只验证不发请求。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { awaitGithubIdentity, parseGithubRemote } from "../src/lib/github-identity";

describe("GitHub remote 解析", () => {
	it("https / ssh / git:// 三种写法都能取到 owner 与仓库名", () => {
		expect(parseGithubRemote("https://github.com/RexVane/PiWeb.git")).toEqual({ owner: "RexVane", repo: "RexVane/PiWeb" });
		expect(parseGithubRemote("https://github.com/RexVane/PiWeb")).toEqual({ owner: "RexVane", repo: "RexVane/PiWeb" });
		expect(parseGithubRemote("git@github.com:RexVane/PiWeb.git")).toEqual({ owner: "RexVane", repo: "RexVane/PiWeb" });
		expect(parseGithubRemote("ssh://git@github.com/RexVane/PiWeb.git")).toEqual({ owner: "RexVane", repo: "RexVane/PiWeb" });
		expect(parseGithubRemote("git://github.com/RexVane/PiWeb.git")).toEqual({ owner: "RexVane", repo: "RexVane/PiWeb" });
	});

	it("大小写与结尾斜杠不影响识别", () => {
		expect(parseGithubRemote("https://GitHub.com/RexVane/PiWeb.git/")?.owner).toBe("RexVane");
	});

	it("只给 owner 也能解析（能出头像）", () => {
		expect(parseGithubRemote("https://github.com/RexVane")).toEqual({ owner: "RexVane", repo: undefined });
	});

	it("非 GitHub / 空值一律返回 null，交给下一档降级", () => {
		expect(parseGithubRemote("https://gitlab.com/a/b.git")).toBeNull();
		expect(parseGithubRemote("")).toBeNull();
		expect(parseGithubRemote(null)).toBeNull();
		expect(parseGithubRemote(undefined)).toBeNull();
	});
});

describe("GitHub 身份降级链", () => {
	let root: string;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-gh-"));
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["remote", "add", "origin", "https://github.com/RexVane/PiWeb.git"], { cwd: root });
		const agentDir = path.join(root, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OFFLINE", "1");
		// 离线断言：任何网络调用都直接失败
		vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
	});

	afterAll(async () => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("离线时用 remote 的 owner，不联网、不给头像（面板退回首字母）", async () => {
		const identity = await awaitGithubIdentity(root);
		expect(identity).toMatchObject({ login: "RexVane", source: "remote", repo: "RexVane/PiWeb", url: "https://github.com/RexVane" });
		expect(identity?.avatar).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("root 为 null 时直接返回 null，不抛错", async () => {
		await expect(awaitGithubIdentity(null)).resolves.toBeNull();
	});
});
