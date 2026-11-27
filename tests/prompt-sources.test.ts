/**
 * 提示词/技能来源路径解析与只读边界：
 * 验证系统提示词文件、追加提示词、项目记忆、技能、提示模板（含个人目录与禁用模板）
 * 能通过 resolvePromptSourcePath / readPromptSource 安全读取，且拒绝目录穿越与未发现路径。
 * 项目里的 .pi/{SYSTEM.md,APPEND_SYSTEM.md,skills,prompts} 属于"需要信任"的资源，
 * 所以夹具里先显式信任该目录，否则加载器不会加载它们。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PROMPT_SOURCE_BYTES, readPromptSource, resolvePromptSourcePath } from "../src/lib/prompt-sources";
import { readWorkspaceImage } from "../src/lib/files-service";

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

describe("resolvePromptSourcePath / readPromptSource（真实资源加载器）", () => {
	it("解析并读取项目与个人目录里已发现的各类来源", async () => {
		const targets = [
			[path.join(ws, ".pi", "SYSTEM.md"), "极简助手"],
			[path.join(ws, ".pi", "APPEND_SYSTEM.md"), "回答尽量短"],
			[path.join(ws, "AGENTS.md"), "项目约定"],
			[path.join(ws, ".pi", "skills", "demo-skill", "SKILL.md"), "演示技能"],
			[path.join(ws, ".pi", "prompts", "review.md"), "评审一下"],
			[path.join(agentDir, "skills", "global-skill", "SKILL.md"), "个人技能"],
			[path.join(agentDir, "prompts", "personal.md"), "个人模板正文"],
		] as const;

		for (const [target, snippet] of targets) {
			await expect(resolvePromptSourcePath(target, ws)).resolves.toBe(target);
			await expect(readPromptSource(target, ws)).resolves.toContain(snippet);
		}
	});

	it("restores disabled template tabs without authorizing their sibling files", async () => {
		const template = path.join(agentDir, "prompts", "personal.md");
		await write(path.join(agentDir, "settings.json"), JSON.stringify({ prompts: ["-prompts/personal.md"] }));
		const { reloadAllLoaders } = await import("../src/lib/pi");
		await reloadAllLoaders();
		await expect(resolvePromptSourcePath(template, ws, template)).resolves.toBe(template);
		await expect(readPromptSource(template, ws, template)).resolves.toContain("个人模板正文");
		const sibling = path.join(agentDir, "private.txt");
		await write(sibling, "private file");
		await expect(readPromptSource(sibling, ws, template)).rejects.toThrow(/escapes/);
	});

	it("bounds both discovered prompt bodies and linked documents to 1 MiB", async () => {
		const body = path.join(ws, "AGENTS.md");
		await write(body, "x".repeat(MAX_PROMPT_SOURCE_BYTES + 1));
		await expect(readPromptSource(body, ws)).rejects.toThrow("exceeds 1 MB");
		const skill = path.join(agentDir, "skills", "global-skill", "SKILL.md");
		const linked = path.join(path.dirname(skill), "references", "large.md");
		await write(linked, "x".repeat(MAX_PROMPT_SOURCE_BYTES + 1));
		await expect(readPromptSource(linked, ws, skill)).rejects.toThrow("exceeds 1 MB");
		await write(linked, "x".repeat(MAX_PROMPT_SOURCE_BYTES));
		expect((await readPromptSource(linked, ws, skill)).length).toBe(MAX_PROMPT_SOURCE_BYTES);
	});

	it("拒绝白名单之外的任意路径", async () => {
		const outside = path.join(ws, "..", "not-a-prompt.txt");
		await write(path.resolve(outside), "不该被读到");
		await expect(resolvePromptSourcePath(path.resolve(outside), ws)).rejects.toThrow(/not part of the discovered/);
		await expect(readPromptSource(path.resolve(outside), ws)).rejects.toThrow(/not part of the discovered/);
		await fs.rm(path.resolve(outside), { force: true });
	});

	it("技能相对链接能读 references，并沿用原始技能来源继续打开下一页", async () => {
		const skill = path.join(agentDir, "skills", "global-skill", "SKILL.md");
		const reference = path.join(path.dirname(skill), "references", "client-sdk.md");
		await write(reference, "[下一页](nested/next.md)");
		const next = path.join(path.dirname(reference), "nested", "next.md");
		await write(next, "第二层文档");
		await expect(resolvePromptSourcePath(reference, ws, skill)).resolves.toBe(reference);
		await expect(readPromptSource(reference, ws, skill)).resolves.toContain("下一页");
		await expect(readPromptSource(next, ws, skill)).resolves.toBe("第二层文档");
		await expect(readPromptSource(reference, ws)).rejects.toThrow(/not part of the discovered/);
	});

	it("链接校验拒绝伪造来源、目录穿越和指向技能目录外的符号链接", async () => {
		const skill = path.join(agentDir, "skills", "global-skill", "SKILL.md");
		const outside = path.join(agentDir, "private.txt");
		await write(outside, "不应读到");
		const forged = path.join(agentDir, "forged.md");
		await write(forged, "伪造来源");
		await expect(readPromptSource(outside, ws, forged)).rejects.toThrow(/not part of the discovered/);
		await expect(readPromptSource(path.join(path.dirname(skill), "..", "..", "private.txt"), ws, skill)).rejects.toThrow(/escapes/);
		const linked = path.join(path.dirname(skill), "escape.md");
		let symlinked = true;
		try {
			await fs.symlink(outside, linked);
		} catch (error) {
			// Windows 没开开发者模式且非管理员时建不了符号链接（EPERM），跳过符号链接这一条，其余校验照旧
			if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			symlinked = false;
		}
		if (symlinked) await expect(readPromptSource(linked, ws, skill)).rejects.toThrow(/escapes/);
		// 全局 AGENTS / 模板也不能用来授权整个人目录。
		await expect(readPromptSource(outside, ws, path.join(agentDir, "prompts", "personal.md"))).rejects.toThrow(/escapes/);
	});

	it("二进制技能附件复用已发现来源边界，不能读取同级私人图片", async () => {
		const skill = path.join(agentDir, "skills", "global-skill", "SKILL.md");
		const image = path.join(path.dirname(skill), "images", "中文.png");
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8QkAAAAASUVORK5CYII=", "base64");
		await fs.mkdir(path.dirname(image), { recursive: true });
		await fs.writeFile(image, png);
		await expect(readWorkspaceImage(ws, image, skill)).resolves.toEqual({ bytes: png, mimeType: "image/png" });
		const outside = path.join(agentDir, "private.png");
		await fs.writeFile(outside, png);
		await expect(readWorkspaceImage(ws, outside, skill)).rejects.toThrow(/escapes/);
		await expect(readWorkspaceImage(ws, image, outside)).rejects.toThrow(/not part of the discovered/);
	});
});
