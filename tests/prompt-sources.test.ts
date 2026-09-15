/**
 * 提示词来源汇总：把系统提示词文件、项目记忆、技能、提示模板（含个人目录与包/扩展）列出来，
 * 并能按需读取内容。项目里的 .pi/{SYSTEM.md,APPEND_SYSTEM.md,skills,prompts} 属于"需要信任"的资源，
 * 所以夹具里先显式信任该目录，否则加载器不会加载它们。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPromptSources, classifyPromptOrigin, listPromptSources, readPromptSource } from "../src/lib/prompt-sources";

const prior = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
let ws: string;

async function write(file: string, content: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content, "utf8");
}

beforeEach(async () => {
	agentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-prompts-agent-")));
	ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-prompts-ws-")));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await write(path.join(ws, "AGENTS.md"), "# 项目约定\n\n只写必要的注释。\n");
	await write(path.join(ws, ".pi", "SYSTEM.md"), "你是一个极简助手。\n");
	await write(path.join(ws, ".pi", "APPEND_SYSTEM.md"), "追加：回答尽量短。\n");
	await write(path.join(ws, ".pi", "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 演示技能\n---\n\n正文\n");
	await write(path.join(ws, ".pi", "prompts", "review.md"), "---\ndescription: 代码评审\n---\n\n评审一下 $1\n");
	await write(path.join(agentDir, "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: 个人技能\n---\n\n正文\n");
	await write(path.join(agentDir, "prompts", "personal.md"), "---\ndescription: 个人模板\n---\n\n个人模板正文\n");
	// 项目含 .pi/skills 等资源 → 需要信任；显式信任后才加载
	const { setProjectTrust } = await import("../src/lib/pi");
	setProjectTrust(ws, true);
	const { reloadAllLoaders } = await import("../src/lib/pi");
	await reloadAllLoaders();
});

afterEach(async () => {
	if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prior;
	await fs.rm(agentDir, { recursive: true, force: true });
	await fs.rm(ws, { recursive: true, force: true });
});

const names = (sources: Array<{ kind: string; name: string }>, kind: string) => sources.filter((s) => s.kind === kind).map((s) => s.name).sort();

describe("classifyPromptOrigin（纯函数）", () => {
	it("区分项目、个人、包与扩展", () => {
		// 用真实临时路径构造：POSIX 字面量在 Windows 上不落在同一个盘，会造成假失败
		expect(classifyPromptOrigin(path.join(ws, "AGENTS.md"), ws).scope).toBe("project");
		expect(classifyPromptOrigin(path.join(agentDir, "skills", "a", "SKILL.md"), ws).scope).toBe("agent");
		expect(classifyPromptOrigin(path.join(ws, "node_modules", "@scope", "pkg", "skills", "a", "SKILL.md"), ws)).toEqual({ scope: "package", name: "@scope/pkg" });
		expect(classifyPromptOrigin(path.join(agentDir, "extensions", "my-ext", "index.ts"), ws)).toEqual({ scope: "extension", name: "my-ext" });
	});
});

describe("buildPromptSources（纯函数）", () => {
	it("按类别再按名字排序，并补上 origin", () => {
		const built = buildPromptSources([
			{ kind: "skill", name: "b", path: path.join(ws, ".pi", "skills", "b", "SKILL.md"), cwd: ws },
			{ kind: "system", name: "SYSTEM.md", path: path.join(ws, ".pi", "SYSTEM.md"), cwd: ws },
			{ kind: "agents", name: "AGENTS.md", path: path.join(ws, "AGENTS.md"), cwd: ws },
			{ kind: "skill", name: "a", path: path.join(ws, ".pi", "skills", "a", "SKILL.md"), cwd: ws },
		]);
		expect(built.map((s) => `${s.kind}:${s.name}`)).toEqual(["system:SYSTEM.md", "agents:AGENTS.md", "skill:a", "skill:b"]);
		expect(built.every((s) => s.origin.scope === "project")).toBe(true);
	});
});

describe("listPromptSources / readPromptSource（真实资源加载器）", () => {
	it("列出项目与个人两边的提示词来源", async () => {
		const { sources } = await listPromptSources({ cwd: ws });
		expect(names(sources, "agents")).toEqual(["AGENTS.md"]);
		expect(names(sources, "skill")).toContain("demo-skill");
		expect(names(sources, "skill")).toContain("global-skill");
		expect(names(sources, "template")).toContain("review");
		expect(names(sources, "template")).toContain("personal");
		// 个人目录里的来源要标成 agent，项目里的标成 project
		const personal = sources.find((s) => s.name === "personal");
		expect(personal?.origin.scope).toBe("agent");
		expect(sources.find((s) => s.name === "AGENTS.md")?.origin.scope).toBe("project");
		// 文件类来源都能拿到字节数
		expect(sources.find((s) => s.name === "AGENTS.md")?.bytes).toBeGreaterThan(0);
	});

	it("冷会话：只给文件来源，并说明合成项要等会话启动", async () => {
		const result = await listPromptSources({ cwd: ws });
		expect(result.sessionReady).toBe(false);
		expect(result.assembledSystemPrompt).toBeUndefined();
		expect(result.tools).toBeUndefined();
	});

	it("热会话：附带组装后的系统提示词与工具定义", async () => {
		const session = {
			systemPrompt: "你是 pi。\n\nThe following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n- demo-skill: 演示技能\n</available_skills>\n",
			getAllTools: () => [
				{ name: "read", description: "读取文件", parameters: { type: "object" }, sourceInfo: { source: "builtin" } },
				{ name: "custom_tool", description: "扩展工具", promptGuidelines: ["先想再用"], sourceInfo: { source: "extension" } },
			],
		};
		const result = await listPromptSources({ cwd: ws, session });
		expect(result.sessionReady).toBe(true);
		expect(result.assembledSystemPrompt).toContain("<available_skills>");
		expect(result.tools?.map((tool) => `${tool.name}:${tool.source}`)).toEqual(["read:builtin", "custom_tool:extension"]);
		expect(result.tools?.[0].parameters).toEqual({ type: "object" });
	});

	it("读取内容：列表里的路径可读，列表外的路径被拒", async () => {
		const { sources } = await listPromptSources({ cwd: ws });
		const agents = sources.find((s) => s.kind === "agents");
		expect(agents?.path).toBeTruthy();
		await expect(readPromptSource(agents!.path!, ws)).resolves.toContain("项目约定");

		const outside = path.join(ws, "..", "not-a-prompt.txt");
		await write(path.resolve(outside), "不该被读到");
		await expect(readPromptSource(path.resolve(outside), ws)).rejects.toThrow(/not part of the discovered/);
		await fs.rm(path.resolve(outside), { force: true });
	});
});
