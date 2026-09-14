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
import { flushSettingsOrThrow, withSettingsWriteLock } from "./settings-write-lock";

export type ProjectTrust = "ask" | "always" | "never";

export async function getSecurity(): Promise<{ defaultProjectTrust: ProjectTrust }> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(getAgentDir(), "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { defaultProjectTrust: "ask" };
		throw error;
	}
	const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json must contain a JSON object");
	const trust = (parsed as { defaultProjectTrust?: unknown }).defaultProjectTrust;
	return { defaultProjectTrust: trust === "always" || trust === "never" ? trust : "ask" };
}

export async function setProjectTrust(value: ProjectTrust): Promise<void> {
	if (value !== "ask" && value !== "always" && value !== "never") throw new Error("invalid defaultProjectTrust");
	await withSettingsWriteLock(path.join(getAgentDir(), "settings.json"), async () => {
		await getSecurity(); // ENOENT only; malformed or unreadable settings must fail closed.
		const manager = getSettingsManager(process.cwd());
		await flushSettingsOrThrow(manager);
		await manager.reload();
		await flushSettingsOrThrow(manager);
		// SDK 自己持有跨进程锁，只落修改字段；flush 不抛写错，必须显式 drainErrors。
		manager.setDefaultProjectTrust(value);
		await flushSettingsOrThrow(manager);
		if ((await getSecurity()).defaultProjectTrust !== value) {
			throw new Error("defaultProjectTrust was not persisted");
		}
		// Only a confirmed persisted change may alter loaders and active sessions.
		await reloadSettingsManagers();
		await flushSettingsOrThrow(manager);
		syncProjectTrust();
		await flushSettingsOrThrow(manager);
		await reloadAllLoaders();
		await flushSettingsOrThrow(manager);
		await reloadSessionsForCwd();
	});
}
