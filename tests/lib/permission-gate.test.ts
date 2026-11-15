/**
 * 权限闸门：把「档位」从工具白名单变成执行期真实拦截。
 *
 * 这里钉的是三件容易说成真、实则没做的事：
 *   1. 「工作区内修改」到底管不管住 `../`、绝对路径、符号链接（→ realpath 后再比）；
 *   2. 「工作区内修改」有没有 shell（→ 没有：路径检查管不住任意命令）；
 *   3. 「仅可查看」是不是只靠工具名单（→ 还有第二道锁，改盘/执行一律拒）。
 *
 * 另外钉住 Windows 的三种写法：盘符大小写、UNC、设备路径——它们在字符串层面看着「像在里面」，
 * 或者看着「像相对路径」，都必须在比较前归一。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judgeWritePath, permissionDenial, realpathLoose, resolveModelPath } from "@/lib/permission-gate";
import { recycleFixture } from "./sandbox/fixtures";

const win32 = process.platform === "win32";

let base: string;
let workspace: string;
let outside: string;
let linkPath: string;

beforeAll(async () => {
	// Canonical base: resolveModelPath/judgeWritePath return realpaths, and on Windows
	// the system temp dir may be spelled with an 8.3 short name (`...\RUNNER~1\...`).
	base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-permission-gate-")));
	await fs.mkdir(path.join(base, "workspace", "src"), { recursive: true });
	await fs.mkdir(path.join(base, "outside"), { recursive: true });
	workspace = await fs.realpath(path.join(base, "workspace"));
	outside = await fs.realpath(path.join(base, "outside"));
	// 目录链接不需要管理员权限：Windows 用 junction，其它平台用 dir symlink
	linkPath = path.join(workspace, "escape");
	await fs.symlink(outside, linkPath, win32 ? "junction" : "dir");
});

afterAll(async () => {
	await recycleFixture(base);
});

describe("resolveModelPath", () => {
	it("resolves like pi's tools: cwd for relative paths, keeps absolute ones", () => {
		expect(resolveModelPath("src/a.ts", workspace)).toBe(path.join(workspace, "src", "a.ts"));
		expect(resolveModelPath(path.join(outside, "b.ts"), workspace)).toBe(path.join(outside, "b.ts"));
		expect(resolveModelPath("../x.ts", workspace)).toBe(path.join(base, "x.ts"));
	});

	it("strips the @ prefix, expands ~ and normalizes unicode spaces", () => {
		const home = path.join(base, "home");
		expect(resolveModelPath("@src/a.ts", workspace)).toBe(path.join(workspace, "src", "a.ts"));
		expect(resolveModelPath("~/notes.md", workspace, home)).toBe(path.join(home, "notes.md"));
		expect(resolveModelPath("~", workspace, home)).toBe(home);
		expect(resolveModelPath("my\u00A0file.ts", workspace)).toBe(path.join(workspace, "my file.ts"));
	});
	it("normalizes shell drive spellings consistently with the SDK", async () => {
		if (!win32) {
			expect(resolveModelPath("/mnt/c/outside.txt", workspace)).toBe("/mnt/c/outside.txt");
			return;
		}
		for (const name of ["/c/outside.txt", "/mnt/c/outside.txt", "/cygdrive/c/outside.txt"]) {
			expect(resolveModelPath(name, workspace)).toBe("C:\\outside.txt");
			expect((await judgeWritePath(workspace, name)).inside).toBe(false);
		}
		const drivePath = workspace.replaceAll("\\", "/").replace(/^([a-z]):/i, (_, letter) => `/mnt/${letter.toLowerCase()}`);
		expect((await judgeWritePath(workspace, `${drivePath}/src/inside.txt`)).inside).toBe(true);
	});
});

describe("judgeWritePath", () => {
	it("accepts paths inside the workspace, including files that do not exist yet", async () => {
		expect(await judgeWritePath(workspace, "src/new-file.ts")).toMatchObject({ inside: true });
		expect(await judgeWritePath(workspace, path.join(workspace, "src", "deep", "later.txt"))).toMatchObject({ inside: true });
		expect(await judgeWritePath(workspace, ".")).toMatchObject({ inside: true });
	});

	it("rejects ../ escapes and absolute paths outside", async () => {
		const dotdot = await judgeWritePath(workspace, "../x.ts");
		expect(dotdot.inside).toBe(false);
		expect(dotdot.resolved).toBe(path.join(base, "x.ts"));

		expect((await judgeWritePath(workspace, "../../etc/passwd")).inside).toBe(false);
		expect((await judgeWritePath(workspace, path.join(outside, "b.ts"))).inside).toBe(false);
	});

	it("rejects a path that only looks relative but lands outside", async () => {
		const verdict = await judgeWritePath(workspace, "src/../../outside/b.ts");
		expect(verdict.inside).toBe(false);
		expect(verdict.resolved).toBe(path.join(outside, "b.ts"));
	});

	it("rejects writes that escape through a directory link inside the workspace", async () => {
		const verdict = await judgeWritePath(workspace, path.join("escape", "leak.txt"));
		expect(verdict.inside).toBe(false);
		// realpath 之后落在链接目标上：这条断言就是「只比字符串就会漏掉」的证据
		expect(verdict.resolved).toBe(path.join(outside, "leak.txt"));
	});

	it("does not confuse a similarly prefixed sibling directory with the workspace", async () => {
		const sibling = `${workspace}-other`;
		expect((await judgeWritePath(workspace, path.join(sibling, "x.ts"))).inside).toBe(false);
	});

	it.skipIf(!win32)("treats a differently cased drive/path as the same location on Windows", async () => {
		expect((await judgeWritePath(workspace, path.join(workspace.toUpperCase(), "src", "a.ts"))).inside).toBe(true);
		expect((await judgeWritePath(workspace.toUpperCase(), "src/a.ts")).inside).toBe(true);
	});

	it("rejects UNC and device paths without touching the network", async () => {
		if (win32) {
			expect((await judgeWritePath(workspace, String.raw`\\server\share\x.ts`)).inside).toBe(false);
			expect((await judgeWritePath(workspace, String.raw`\\?\C:\Windows\System32\drivers\etc\hosts`)).inside).toBe(false);
		} else {
			// 非 Windows 上这两个串只是普通文件名，仍然不应该被当成工作区内的绝对路径
			expect((await judgeWritePath(workspace, "/etc/passwd")).inside).toBe(false);
			expect((await judgeWritePath(workspace, "//server/share/x")).inside).toBe(false);
		}
	});
});

describe("realpathLoose", () => {
	it("resolves the existing ancestor and keeps the missing tail", async () => {
		const resolved = await realpathLoose(path.join(workspace, "src", "a", "b", "c.txt"));
		expect(resolved).toBe(path.join(workspace, "src", "a", "b", "c.txt"));
		expect(await realpathLoose(linkPath)).toBe(outside);
	});
});

describe("permissionDenial — 仅可查看 (readonly)", () => {
	const request = (toolName: string, input: unknown = {}, readOnlyHint?: boolean, shellAvailable?: boolean) =>
		permissionDenial({ preset: "readonly", cwd: workspace, toolName, input, readOnlyHint, shellAvailable });

	it("blocks everything that could change the disk or spawn a process", async () => {
		for (const toolName of ["write", "edit", "bash", "powershell", "codemode", "manage_automation"]) {
			const denial = await request(toolName, { path: "src/a.ts", command: "echo hi" });
			expect(denial?.block, toolName).toBe(true);
			expect(denial?.reason, toolName).toContain("readonly");
		}
	});

	it("lets bash through when a read-only OS sandbox backs it", async () => {
		// 只读沙箱：命令能跑（读），写一律被内核拒；没有后端时仍然整条拒绝
		expect(await request("bash", { command: "type nul" }, undefined, true)).toBeUndefined();
		expect((await request("powershell", { command: "echo hi" }, undefined, true))?.block).toBe(true);
	});

	it("keeps read-only tools available", async () => {
		for (const toolName of ["read", "grep", "find", "ls", "ask_user_question"]) {
			expect(await request(toolName, { path: path.join(outside, "b.ts") }), toolName).toBeUndefined();
		}
	});

	it("blocks MCP tools unless the server declares them read-only", async () => {
		expect((await request("mcp__fs__write_file", {}))?.block).toBe(true);
		expect(await request("mcp__docs__search", {}, true)).toBeUndefined();
	});
});

describe("permissionDenial — 工作区内修改 (workspace)", () => {
	const request = (toolName: string, input: unknown = {}, readOnlyHint?: boolean, shellAvailable?: boolean) =>
		permissionDenial({ preset: "workspace", cwd: workspace, toolName, input, readOnlyHint, shellAvailable });

	it("allows writes inside the workspace", async () => {
		expect(await request("write", { path: "src/a.ts", content: "" })).toBeUndefined();
		expect(await request("edit", { path: path.join(workspace, "src", "a.ts"), edits: [] })).toBeUndefined();
	});

	it("blocks writes outside the workspace and names the resolved target", async () => {
		const denial = await request("write", { path: "../x.ts", content: "" });
		expect(denial?.block).toBe(true);
		expect(denial?.reason).toContain("outside the workspace");
		expect(denial?.reason).toContain(path.join(base, "x.ts"));

		expect((await request("edit", { path: path.join(outside, "b.ts"), edits: [] }))?.block).toBe(true);
		expect((await request("write", { path: path.join("escape", "leak.txt"), content: "" }))?.block).toBe(true);
	});

	it("allows writes inside additionalWritableRoots and still blocks outside both", async () => {
		const extraDir = path.join(base, "shared-cache");
		await fs.mkdir(extraDir, { recursive: true });
		expect(
			await permissionDenial({
				preset: "workspace",
				cwd: workspace,
				toolName: "write",
				input: { path: path.join(extraDir, "artifact.json"), content: "{}" },
				additionalWritableRoots: [extraDir],
			}),
		).toBeUndefined();
		const outsideDenial = await permissionDenial({
			preset: "workspace",
			cwd: workspace,
			toolName: "write",
			input: { path: path.join(outside, "blocked.json"), content: "{}" },
			additionalWritableRoots: [extraDir],
		});
		expect(outsideDenial?.block).toBe(true);
		expect(outsideDenial?.reason).toContain("outside the workspace");
	});

	it("has no shell when the machine has no sandbox backend", async () => {
		const bash = await request("bash", { command: "echo hi" });
		expect(bash?.block).toBe(true);
		expect(bash?.reason).toContain("no shell");
		// powershell 没有受限实现，无论有没有沙箱后端都拒绝
		const powershell = await request("powershell", { command: "echo hi" });
		expect(powershell?.block).toBe(true);
		expect(powershell?.reason).toContain("no confined backend");
	});

	it("lets bash through only when an OS sandbox backs it, and never powershell", async () => {
		// 有沙箱后端时 bash 放行（边界交给内核）；powershell 没有受限实现，仍然拒绝
		expect(await request("bash", { command: "echo hi" }, undefined, true)).toBeUndefined();
		const denial = await request("powershell", { command: "echo hi" }, undefined, true);
		expect(denial?.block).toBe(true);
		expect(denial?.reason).toContain("no confined backend");
	});

	it("keeps codemode but blocks the automation tool that would open a back door", async () => {
		// codemode 的嵌套调用各自过闸门（见 docs/workspace-isolation.md），所以本体放行；
		// manage_automation 能建出 full 档任务，等于绕开工作区限制，直接拒绝。
		expect(await request("codemode", { script: "return tools.write({path: 'src/a.ts'})" })).toBeUndefined();
		const denial = await request("manage_automation", { action: "create" });
		expect(denial?.block).toBe(true);
		expect(denial?.reason).toContain("automation");
	});

	it("allows read-only MCP tools and blocks the rest", async () => {
		expect(await request("mcp__docs__search", {}, true)).toBeUndefined();
		expect((await request("mcp__fs__write_file", {}))?.block).toBe(true);
	});

	it("leaves reads unrestricted", async () => {
		expect(await request("read", { path: path.join(outside, "b.ts") })).toBeUndefined();
	});

	it("lets a missing path argument through so pi reports the real validation error", async () => {
		expect(await request("write", { content: "" })).toBeUndefined();
		expect(await request("write", { path: "   " })).toBeUndefined();
	});
});

describe("permissionDenial — 完全权限 (full)", () => {
	it("does not restrict anything", async () => {
		const request = (toolName: string, input: unknown) => permissionDenial({ preset: "full", cwd: workspace, toolName, input });
		expect(await request("write", { path: path.join(outside, "b.ts"), content: "" })).toBeUndefined();
		expect(await request("bash", { command: "rm -rf /" })).toBeUndefined();
		expect(await request("mcp__fs__write_file", {})).toBeUndefined();
	});
});
