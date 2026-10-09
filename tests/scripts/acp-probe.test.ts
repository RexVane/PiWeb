import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProbeArgs, resolveLaunch } from "../../scripts/acp-probe.mjs";

const probeScript = fileURLToPath(new URL("../../scripts/acp-probe.mjs", import.meta.url));
const fakeAgent = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

function runProbe(args: string[], timeoutMs = 60_000) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [probeScript, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`probe 超时：${stderr}`)); }, timeoutMs);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
	});
}

describe("ACP 探路脚本（M0b）", () => {
	it("读假 Agent 的 initialize 能力，session/new 与 MCP 回声都通", async () => {
		const result = await runProbe(["--json", "--try-session", "--timeout", "20", process.execPath, fakeAgent]);
		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.ok).toBe(true);
		expect(report.initialize.ok).toBe(true);
		expect(report.initialize.result.protocolVersion).toBe(1);
		expect(report.initialize.result.agentInfo.name).toBe("fake-acp-agent");
		expect(report.initialize.result.agentCapabilities.loadSession).toBe(true);
		expect(report.initialize.result.authMethods[0].id).toBe("fake-login");
		expect(report.sessionNew.ok).toBe(true);
		expect(report.sessionNew.result.sessionId).toBe("fake-session-1");
		expect(report.mcpEcho.used).toBe(true);
	}, 90_000);

	it("不带 --try-session 时不建会话，--help 打印用法", async () => {
		const probe = await runProbe(["--json", process.execPath, fakeAgent]);
		expect(probe.code).toBe(0);
		const report = JSON.parse(probe.stdout);
		expect(report.sessionNew).toBeNull();
		const help = await runProbe(["--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("用法");
	}, 60_000);

	it("命令不存在时给出可读的失败", async () => {
		const result = await runProbe(["--timeout", "5", "definitely-missing-piweb-probe-command"]);
		expect(result.code).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("definitely-missing-piweb-probe-command");
	}, 30_000);
});

describe("Windows 命令解析", () => {
	const env = { PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: "C:\\tools;D:\\NodeJs" };

	it("无扩展名时按 PATHEXT 找后缀，.cmd 经 cmd.exe 启动", () => {
		const launch = resolveLaunch("opencode", ["acp"], {
			env,
			platform: "win32",
			exists: (candidate) => candidate.toLowerCase() === "d:\\nodejs\\opencode.cmd",
		});
		expect(launch.file).toMatch(/cmd\.exe$/i);
		expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(launch.args.at(-1)?.toLowerCase()).toBe("d:\\nodejs\\opencode.cmd acp");
	});

	it("带扩展名的命令直接启动，不走 cmd.exe", () => {
		const launch = resolveLaunch("tool.exe", ["a"], { env, platform: "win32", exists: () => true });
		expect(launch.file.endsWith("tool.exe")).toBe(true);
		expect(launch.args).toEqual(["a"]);
	});

	it("带空格的路径会加引号，POSIX 交给操作系统解析", () => {
		const quoted = resolveLaunch("C:\\tools with space\\x.cmd", [], { platform: "win32", env, exists: () => false });
		expect(quoted.args.at(-1)).toBe('"C:\\tools with space\\x.cmd"');
		expect(resolveLaunch("grok", ["agent", "stdio"], { platform: "linux" })).toEqual({ file: "grok", args: ["agent", "stdio"] });
	});

	it("PATH 里只有 sh 用的无扩展名脚本时给出可读错误", () => {
		expect(() => resolveLaunch("opencode", [], { env, platform: "win32", exists: (candidate) => candidate === "D:\\NodeJs\\opencode" }))
			.toThrowError(/找不到命令/);
	});
});
