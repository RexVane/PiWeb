/**
 * prompts-service：pi Prompt 模板发现与查看（~/.pi/agent/prompts、.pi/prompts、pi 包）。
 */
import fs from "node:fs/promises";
import { getResourceLoader, resourceLoaderReady } from "./pi";
import { resolveDiscoveredPath } from "./path-security";

export interface PromptView {
	name: string;
	description: string;
	argumentHint?: string;
	filePath: string;
	scope: "global" | "project" | "package";
}

function classifyScope(filePath: string, cwd: string): PromptView["scope"] {
	const norm = filePath.replace(/\\/g, "/").toLowerCase();
	if (norm.includes("/.pi/agent/npm/") || norm.includes("/.pi/agent/git/")) return "package";
	if (norm.includes("/.pi/agent/")) return "global";
	if (norm.includes("/.pi/")) return "project";
	if (norm.includes("/node_modules/")) return "package";
	void cwd;
	return "global";
}

export async function listPrompts(cwd: string): Promise<PromptView[]> {
	await resourceLoaderReady(cwd);
	const loader = getResourceLoader(cwd);
	const { prompts } = loader.getPrompts();
	return prompts.map((p: any) => ({
		name: String(p.name ?? ""),
		description: String(p.description ?? ""),
		argumentHint: p.argumentHint ? String(p.argumentHint) : undefined,
		filePath: String(p.filePath ?? ""),
		scope: classifyScope(String(p.filePath ?? ""), cwd),
	}));
}

export async function readPrompt(filePath: string, cwd: string): Promise<string> {
	const prompts = await listPrompts(cwd);
	const authorized = await resolveDiscoveredPath(filePath, prompts.map((prompt) => prompt.filePath));
	return fs.readFile(authorized, "utf8");
}
