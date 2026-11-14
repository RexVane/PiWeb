/**
 * 解释器选择：沙箱里换 shell 的前提是「令牌能管住它」。
 *
 * 这里钉两件事：
 *   1. WSL 启动器（System32/Sysnative/WindowsApps 的 bash.exe）一律不用 —— 命令交给 WSL 之后，
 *      Windows 令牌管不到 drvfs 的写入，沙箱等于没开；
 *   2. 只有本机存在的原生 bash 才换掉 cmd，否则老实回 cmd。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWslBash, resolveSandboxShell } from "@/lib/sandbox/bash-operations";
import { recycleFixture } from "./fixtures";

describe("isWslBash", () => {
	it("recognises the WSL launchers", () => {
		expect(isWslBash("C:\\Windows\\System32\\bash.exe")).toBe(true);
		expect(isWslBash("c:/windows/system32/bash.exe")).toBe(true);
		expect(isWslBash("C:\\Windows\\Sysnative\\bash.exe")).toBe(true);
		expect(isWslBash("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe")).toBe(true);
	});

	it("keeps native bash", () => {
		expect(isWslBash("D:\\git\\Git\\bin\\bash.exe")).toBe(false);
		expect(isWslBash("C:\\Program Files\\Git\\usr\\bin\\bash.exe")).toBe(false);
		expect(isWslBash("C:\\Windows\\System32\\cmd.exe")).toBe(false);
	});
});

describe("resolveSandboxShell", () => {
	it("never picks a WSL launcher, even when it is the only bash on the machine", () => {
		const shell = resolveSandboxShell("C:\\Windows\\System32\\bash.exe", () => "C:\\Windows\\System32\\bash.exe");
		expect(shell.transport).toBe("argv");
		expect(shell.path).toBe("cmd.exe");
	});

	it("falls back to cmd for a missing or non-bash path", () => {
		// 默认解释器的查找结果由测试给定：本机 PATH 上有没有 bash 不影响结论
		const none = () => undefined;
		expect(resolveSandboxShell("C:\\nope\\bash.exe", none).path).toBe("cmd.exe");
		expect(resolveSandboxShell("C:\\Windows\\System32\\cmd.exe", none).path).toBe("cmd.exe");
		expect(resolveSandboxShell(null, none).path).toBe("cmd.exe");
	});

	it("falls back to cmd when pi cannot find any bash", () => {
		expect(resolveSandboxShell(null, () => { throw new Error("No bash shell found"); }).path).toBe("cmd.exe");
	});

	it("uses a native bash through a script file", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-native-shell-"));
		try {
			const gitBash = path.join(directory, "bash.exe");
			fs.writeFileSync(gitBash, "fixture: path selection only");
			const shell = resolveSandboxShell(gitBash, () => undefined);
			expect(shell).toEqual({ path: gitBash, transport: "script", scriptExt: ".sh" });
		} finally { await recycleFixture(directory); }
	});
});
