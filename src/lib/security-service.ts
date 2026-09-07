/**
 * security-service：pi 真实安全能力的 Web 面。
 * - 工具预设（只读/标准/全部）→ pi 的 tools 白名单（agent-manager 应用）
 * - 项目信任（settings.json 的 defaultProjectTrust：ask/always/never）
 * pi 没有 OS 级沙箱与审批系统——不做假开关。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "./pi";

export type ProjectTrust = "ask" | "always" | "never";

export async function getSecurity(): Promise<{ defaultProjectTrust: ProjectTrust }> {
	try {
		const raw = await fs.readFile(path.join(getAgentDir(), "settings.json"), "utf8");
		const parsed = JSON.parse(raw) as { defaultProjectTrust?: ProjectTrust };
		const t = parsed.defaultProjectTrust;
		return { defaultProjectTrust: t === "always" || t === "never" ? t : "ask" };
	} catch {
		return { defaultProjectTrust: "ask" };
	}
}

export async function setProjectTrust(value: ProjectTrust): Promise<void> {
	const file = path.join(getAgentDir(), "settings.json");
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
	} catch {
		parsed = {};
	}
	parsed.defaultProjectTrust = value;
	await fs.writeFile(file, JSON.stringify(parsed, null, "\t"), "utf8");
}
