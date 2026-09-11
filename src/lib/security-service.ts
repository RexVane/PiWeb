/**
 * security-service：pi 真实安全能力的 Web 面。
 * - 工具预设（只读/标准/全部）→ pi 的 tools 白名单（agent-manager 应用）
 * - 项目信任（settings.json 的 defaultProjectTrust：ask/always/never）
 * pi 没有 OS 级沙箱与审批系统——不做假开关。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, getSettingsManager, reloadAllLoaders, reloadSettingsManagers, syncProjectTrust } from "./pi";
import { reloadSessionsForCwd } from "./agent-manager";

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
	// 走 SDK 的 SettingsManager（带写锁、只落修改过的字段），不再整文件覆盖
	getSettingsManager(process.cwd()).setDefaultProjectTrust(value);
	// 默认值变了：每个已打开目录的信任结论可能跟着变，就地同步后重载加载器与活跃会话
	await reloadSettingsManagers();
	syncProjectTrust();
	await reloadAllLoaders();
	await reloadSessionsForCwd();
}
