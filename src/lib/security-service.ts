/**
 * security-service：pi 真实安全能力的 Web 面。
 * - 工具预设（只读/标准/全部）→ pi 的 tools 白名单（agent-manager 应用）
 * - 项目信任（settings.json 的 defaultProjectTrust：ask/always/never）
 * pi 没有 OS 级沙箱与审批系统——不做假开关。
 */
import path from "node:path";
import { invalidateJsonFile, readJsonObject } from "./agent-config";
import { getAgentDir, getSettingsManager, reloadAllLoaders, reloadSettingsManagers, syncProjectTrust } from "./pi";
import { reloadSessionsForCwd } from "./agent-manager";
import { flushSettingsOrThrow, withSettingsWriteLock } from "./settings-write-lock";
import { APP_ROOT } from "./app-root";

export type ProjectTrust = "ask" | "always" | "never";

export async function getSecurity(): Promise<{ defaultProjectTrust: ProjectTrust }> {
	// 统一缓存：settings.json 在信任判定 / 会话创建 / 快照里被读很多次
	const parsed = await readJsonObject(path.join(getAgentDir(), "settings.json"));
	const trust = parsed.defaultProjectTrust;
	return { defaultProjectTrust: trust === "always" || trust === "never" ? trust : "ask" };
}

export async function setProjectTrust(value: ProjectTrust): Promise<void> {
	if (value !== "ask" && value !== "always" && value !== "never") throw new Error("invalid defaultProjectTrust");
	await withSettingsWriteLock(path.join(getAgentDir(), "settings.json"), async () => {
		await getSecurity(); // ENOENT only; malformed or unreadable settings must fail closed.
		const manager = getSettingsManager(APP_ROOT);
		await flushSettingsOrThrow(manager);
		await manager.reload();
		await flushSettingsOrThrow(manager);
		// SDK 自己持有跨进程锁，只落修改字段；flush 不抛写错，必须显式 drainErrors。
		manager.setDefaultProjectTrust(value);
		await flushSettingsOrThrow(manager);
		// 刚写过的文件必须重新读盘再验：(mtime, ctime, size, ino) 校验戳有可能与旧值相同
		invalidateJsonFile(path.join(getAgentDir(), "settings.json"));
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
