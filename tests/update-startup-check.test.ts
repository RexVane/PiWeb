/**
 * 启动时检查更新：只查一次、有新版本才在终端打一行、离线不吭声、可以关掉；
 * 手动检查 / 更新成功会改写缓存（刷新页面不会又让人更新一次）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/update-service", () => ({ checkForUpdate: vi.fn() }));

import { ensureStartupCheck, markUpdated, recordCheck, resetStartupCheck, updateNoticeLine } from "../src/lib/update/startup-check";
import type { UpdateCheck, UpdateTarget } from "../src/lib/update-service";

const CHECKS: Record<UpdateTarget, UpdateCheck> = {
	piweb: { current: "0.3.18", latest: "0.3.20", canUpdate: true, selfUpdate: true },
	pi: { current: "1.1.0", latest: "1.1.0", canUpdate: false, selfUpdate: true },
};

beforeEach(() => resetStartupCheck());

describe("ensureStartupCheck", () => {
	it("两项各查一次，并发调用共用同一次检查", async () => {
		const check = vi.fn(async (target: UpdateTarget) => CHECKS[target]);
		const log = vi.fn();
		const [first, second] = await Promise.all([ensureStartupCheck({ check, log, env: {} }), ensureStartupCheck({ check, log, env: {} })]);
		expect(check.mock.calls.map(([target]) => target).sort()).toEqual(["pi", "piweb"]);
		expect(first?.startId).toBeTruthy();
		expect(second?.startId).toBe(first?.startId);
		expect(first?.results).toEqual(CHECKS);
		await ensureStartupCheck({ check, log, env: {} });
		expect(check).toHaveBeenCalledTimes(2);
	});

	it("有新版本才在终端打一行", async () => {
		const log = vi.fn();
		await ensureStartupCheck({ check: async (target) => CHECKS[target], log, env: {} });
		expect(log).toHaveBeenCalledWith("[更新] 有新版本：PiWeb 0.3.18 → 0.3.20。打开 设置 → 通用 点「更新」");

		resetStartupCheck();
		const quiet = vi.fn();
		await ensureStartupCheck({ check: async (target) => ({ ...CHECKS[target], latest: CHECKS[target].current, canUpdate: false }), log: quiet, env: {} });
		expect(quiet).not.toHaveBeenCalled();
	});

	it("离线（检查抛错）不打印、不抛出，失败原因留给设置页", async () => {
		const log = vi.fn();
		const updates = await ensureStartupCheck({ check: async () => { throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org"); }, log, env: {} });
		expect(log).not.toHaveBeenCalled();
		expect(updates?.results.pi).toEqual({ error: "getaddrinfo ENOTFOUND registry.npmjs.org" });
	});

	it("PI_WEB_UPDATE_CHECK=0 时不联网", async () => {
		const check = vi.fn();
		expect(await ensureStartupCheck({ check, log: vi.fn(), env: { PI_WEB_UPDATE_CHECK: "0" } })).toBeNull();
		expect(check).not.toHaveBeenCalled();
	});

	it("手动检查、更新成功改写缓存；检查期间手动查过的不被启动检查覆盖", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const pending = ensureStartupCheck({ check: async (target) => { await gate; return CHECKS[target]; }, log: vi.fn(), env: {} });
		recordCheck("pi", { current: "1.1.0", latest: "1.2.0", canUpdate: true, selfUpdate: true });
		release();
		expect((await pending)?.results.pi).toMatchObject({ latest: "1.2.0", canUpdate: true });

		markUpdated("piweb", "0.3.20");
		const after = await ensureStartupCheck({ check: vi.fn(), log: vi.fn(), env: {} });
		expect(after?.results.piweb).toMatchObject({ canUpdate: false, updatedTo: "0.3.20" });
	});
});

describe("updateNoticeLine", () => {
	it("Windows 上的 npm 安装附上要手动执行的命令", () => {
		expect(updateNoticeLine({
			piweb: { current: "0.3.18", latest: "0.3.20", canUpdate: true, selfUpdate: false, command: "npm install -g @rexvane/piweb@latest" },
			pi: { current: "1.1.0", latest: "1.2.0", canUpdate: true, selfUpdate: true },
		})).toBe("[更新] 有新版本：PiWeb 0.3.18 → 0.3.20、Pi 1.1.0 → 1.2.0。打开 设置 → 通用 点「更新」；PiWeb 要先停掉 piweb 再运行：npm install -g @rexvane/piweb@latest");
	});

	it("Git 检出版本号没变、只有新提交时写提交数", () => {
		expect(updateNoticeLine({ piweb: { current: "0.3.20", latest: "0.3.20", behind: 3, canUpdate: true, selfUpdate: true } }))
			.toBe("[更新] 有新版本：PiWeb（main 新增 3 个提交）。打开 设置 → 通用 点「更新」");
	});
});
