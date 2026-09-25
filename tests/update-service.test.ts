import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/version", () => ({ getRuntimeVersions: async () => ({ piWeb: "1.0.0", piEngine: "1.0.0" }) }));

import { createUpdateService, canSelfUpdateNpmInstall } from "../src/lib/update-service";
import { installPiUpdate, prepareRelease } from "../scripts/release.mjs";
import { selectProductionBuild } from "../scripts/build-output.mjs";

type CommandOptions = { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function installation() {
	// The launcher and the update service canonicalize the installation directory
	// (Windows can hand out 8.3 short paths such as RUNNER~1), so the fixture is
	// canonical too and \`options.cwd\` comparisons stay exact on every runner.
	const created = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-update-"));
	const root = await fs.realpath(created);
	roots.push(root);
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pi-web", version: "1.0.0" }));
	await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, exclude: [".next-releases"] }));
	await build(root, ".next", "old-serving-build");
	return root;
}

async function build(root: string, buildDir: string, buildId = "new-build") {
	const files = ["BUILD_ID", "routes-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/app-paths-manifest.json"];
	for (const file of files) {
		const target = path.join(root, buildDir, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, file === "BUILD_ID" ? buildId : "{}");
	}
	await fs.writeFile(path.join(root, buildDir, "required-server-files.json"), JSON.stringify({
		version: 1, config: { distDir: buildDir }, files: files.map((file) => path.join(buildDir, file)),
	}));
}

async function manifest(root: string) {
	return JSON.parse(await fs.readFile(path.join(root, ".next-releases", "active.json"), "utf8"));
}

function mockCommands(root: string, fail = "") {
	return vi.fn(async (command: string, args: string[], options: CommandOptions) => {
		expect(options.cwd).toBe(root);
		expect(options.env?.PI_WEB_PASSWORD).toBeUndefined();
		if (command === "git" && args[0] === "rev-parse") return root;
		if (command === "git" && args[0] === "status") return "";
		const key = command === process.execPath ? "verify" : `${command} ${args.join(" ")}`;
		const state = await manifest(root);
		expect(state.state).toBe("building");
		expect(options.env?.PIWEB_BUILD_DIR).toBe(state.buildDir);
		if (fail && key.includes(fail)) {
			// Even a command that leaves a seemingly complete build must not publish on failure.
			await build(root, state.buildDir, "partial-or-stale");
			throw new Error(`simulated ${fail} failure`);
		}
		if (key === "git pull --ff-only origin main") {
			await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pi-web", version: "2.0.0" }));
		} else if (command === "npm" && args[0] === "install" && args.includes("--save-exact")) {
			const packageFile = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
			await fs.mkdir(path.dirname(packageFile), { recursive: true });
			await fs.writeFile(packageFile, JSON.stringify({ version: "2.5.0" }));
		} else if (key === "npm run check") {
			await build(root, state.buildDir);
		}
		return "";
	});
}

describe("checked staged releases", () => {
	it("builds without Git, preserves serving output/config and promotes only a fresh complete build", async () => {
		const root = await installation();
		const initialConfig = await fs.readFile(path.join(root, "tsconfig.json"), "utf8");
		const run = mockCommands(root);
		const result = await prepareRelease({ root, run, env: { PI_WEB_PASSWORD: "do-not-pass" } });
		expect(run.mock.calls.map(([command, args]) => command === process.execPath ? path.basename(args[0]) : `${command} ${args.join(" ")}`)).toEqual(["verify-release-config.mjs", "npm run check"]);
		expect(result).toMatchObject({ needsRestart: true, buildId: "new-build", version: "1.0.0" });
		expect(result.buildDir).toMatch(/^\.next-releases\/[A-Za-z0-9_-]+$/);
		expect(await manifest(root)).toMatchObject({ schema: 1, state: "ready", buildDir: result.buildDir, buildId: "new-build" });
		expect(selectProductionBuild(root)).toEqual({ buildDir: result.buildDir, buildId: "new-build" });
		expect(await fs.readFile(path.join(root, ".next", "BUILD_ID"), "utf8")).toBe("old-serving-build");
		expect(await fs.readFile(path.join(root, "tsconfig.json"), "utf8")).toBe(initialConfig);
		const typeConfig = JSON.parse(await fs.readFile(path.join(root, ".next-releases", "tsconfig.json"), "utf8"));
		expect(typeConfig.extends).toBe("../tsconfig.json");
		expect(typeConfig.include).toContain(`./${result.buildDir.split("/")[1]}/types/**/*.ts`);
		expect(typeConfig.exclude).not.toContain(".next-releases");
		await expect(fs.stat(path.join(root, ".next-releases", "update.lock"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.readdir(path.join(root, ".next-releases"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("rejects zero-exit check without fresh complete output instead of reusing old BUILD_ID", async () => {
		const root = await installation();
		const run = vi.fn(async () => "");
		await expect(prepareRelease({ root, run })).rejects.toThrow();
		expect((await manifest(root)).state).toBe("failed");
		expect(() => selectProductionBuild(root)).toThrow(/no stale-build fallback/);
		expect(await fs.readFile(path.join(root, ".next", "BUILD_ID"), "utf8")).toBe("old-serving-build");
	});

	it("blocks concurrent release preparation before source changes and releases the lock after failure", async () => {
		const root = await installation();
		let entered!: () => void;
		let fail!: (error: Error) => void;
		const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((_resolve, reject) => { fail = reject; });
		const first = prepareRelease({ root, run: vi.fn(async () => ""), prepare: async () => { entered(); await gate; } });
		const firstFailure = expect(first).rejects.toThrow("aborted fake update");
		await enteredPromise;
		const prepare = vi.fn();
		await expect(prepareRelease({ root, prepare })).rejects.toThrow(/already running/);
		expect(prepare).not.toHaveBeenCalled();
		fail(new Error("aborted fake update"));
		await firstFailure;
		expect((await manifest(root)).state).toBe("failed");
		const failedDir = (await manifest(root)).buildDir;
		const recovered = await prepareRelease({ root, run: mockCommands(root) });
		expect(recovered.buildDir).not.toBe(failedDir);
	});

	it("fails closed on cancellation without promoting output", async () => {
		const root = await installation();
		const controller = new AbortController();
		const run = vi.fn(async () => "");
		await expect(prepareRelease({ root, run, signal: controller.signal, prepare: async () => { controller.abort(); } })).rejects.toThrow();
		expect(run).not.toHaveBeenCalled();
		expect((await manifest(root)).state).toBe("failed");
		expect(() => selectProductionBuild(root)).toThrow();
	});

	it("rejects wrong installation roots and linked release directories before running commands", async () => {
		const root = await installation();
		const run = vi.fn(async () => "");
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "other-app" }));
		await expect(prepareRelease({ root, run })).rejects.toThrow(/outside the PiWeb/);
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pi-web" }));
		const other = await installation();
		await fs.symlink(other, path.join(root, ".next-releases"), process.platform === "win32" ? "junction" : "dir");
		await expect(prepareRelease({ root, run })).rejects.toThrow(/linked/);
		expect(run).not.toHaveBeenCalled();
	});
});

describe("update service transactions", () => {
	it("runs fixed PiWeb pull/install/check commands and returns ready only after promotion", async () => {
		const root = await installation();
		const run = mockCommands(root);
		const service = createUpdateService({ root, run, env: { PI_WEB_PASSWORD: "secret" } });
		const idle = vi.fn(async () => {});
		const result = await service.runUpdate("piweb", { assertIdle: idle });
		expect(result).toMatchObject({ version: "2.0.0", needsRestart: true, buildId: "new-build" });
		expect(run.mock.calls.map(([command, args]) => command === process.execPath ? "verify" : `${command} ${args.join(" ")}`)).toEqual([
			"git rev-parse --show-toplevel", "git status --porcelain --untracked-files=no", "git pull --ff-only origin main", "npm install --no-audit --no-fund", "verify", "npm run check",
		]);
		expect(idle).toHaveBeenCalledTimes(4);
		expect((await manifest(root)).state).toBe("ready");
	});

	it("Pi engine update also synchronizes icons and builds the new release", async () => {
		const root = await installation();
		const run = mockCommands(root);
		const result = await createUpdateService({ root, run }).runUpdate("pi");
		expect(result.version).toBe("2.5.0");
		expect(run.mock.calls.map(([command, args]) => command === process.execPath ? "verify" : `${command} ${args.join(" ")}`)).toEqual([
			"npm install --save-exact @earendil-works/pi-coding-agent@latest @earendil-works/pi-ai@latest --no-audit --no-fund", "npm run sync:provider-icons", "verify", "npm run check",
		]);
		expect((await manifest(root)).state).toBe("ready");
	});

	it("CLI Pi installation helper uses the same transaction before mutations", async () => {
		const root = await installation();
		const run = mockCommands(root);
		await prepareRelease({ root, run, prepare: async (context) => { expect(await installPiUpdate(context)).toBe("2.5.0"); } });
		expect((await manifest(root)).state).toBe("ready");
	});

	it.each(["git pull", "npm install", "verify", "npm run check"])("does not publish after %s failure and a retry gets a new directory", async (failure) => {
		const root = await installation();
		const previous = await prepareRelease({ root, run: mockCommands(root) });
		const service = createUpdateService({ root, run: mockCommands(root, failure) });
		await expect(service.runUpdate("piweb")).rejects.toThrow(/simulated/);
		const failed = await manifest(root);
		expect(failed.state).toBe("failed");
		expect(() => selectProductionBuild(root)).toThrow(/no stale-build fallback/);
		expect(await fs.readFile(path.join(root, previous.buildDir, "BUILD_ID"), "utf8")).toBe("new-build");
		expect(await fs.readFile(path.join(root, ".next", "BUILD_ID"), "utf8")).toBe("old-serving-build");
		const recovered = await createUpdateService({ root, run: mockCommands(root) }).runUpdate("piweb");
		expect(recovered.buildDir).not.toBe(failed.buildDir);
	});

	it("refuses tracked local changes, wrong git roots and streaming before modifying the manifest", async () => {
		const root = await installation();
		const previous = await prepareRelease({ root, run: mockCommands(root) });
		const readyText = await fs.readFile(path.join(root, ".next-releases", "active.json"), "utf8");
		const dirty = vi.fn(async (_command: string, args: string[]) => args[0] === "rev-parse" ? root : " M src/user.ts");
		await expect(createUpdateService({ root, run: dirty }).runUpdate("piweb")).rejects.toThrow(/local tracked changes/);
		expect(dirty).toHaveBeenCalledTimes(2);
		const other = await installation();
		const wrongRoot = vi.fn(async () => other);
		await expect(createUpdateService({ root, run: wrongRoot }).runUpdate("piweb")).rejects.toThrow(/Git installation root/);
		const run = vi.fn(async () => "");
		await expect(createUpdateService({ root, run }).runUpdate("pi", { assertIdle: async () => { throw new Error("session busy"); } })).rejects.toThrow(/busy/);
		expect(run).not.toHaveBeenCalled();
		expect(await fs.readFile(path.join(root, ".next-releases", "active.json"), "utf8")).toBe(readyText);
		expect(selectProductionBuild(root)?.buildDir).toBe(previous.buildDir);
	});

	it("rejects an invalid runtime target before any commands", async () => {
		const root = await installation();
		const run = vi.fn(async () => "");
		await expect(createUpdateService({ root, run }).runUpdate("x; echo nope" as "pi")).rejects.toThrow(/unknown target/);
		expect(run).not.toHaveBeenCalled();
	});

	it("checks only the branch version which its fixed pull command will install", async () => {
		const root = await installation();
		const run = vi.fn(async (_command: string, args: string[]) => {
			if (args[0] === "rev-list") return "2\n";
			if (args[0] === "show") return JSON.stringify({ name: "pi-web", version: "1.2.0" });
			return "";
		});
		expect(await createUpdateService({ root, run }).checkForUpdate("piweb")).toEqual({ current: "1.0.0", latest: "1.2.0", behind: 2, canUpdate: true, selfUpdate: true });
		expect(run.mock.calls.some(([, args]) => args[0] === "tag")).toBe(false);
	});
});

/**
 * 用户装的是 npm 成品包（<prefix>/node_modules/@rexvane/piweb），那里没有 Git 仓库，
 * 更新只能走 npm；以前这条路会直接抛 "fatal: not a git repository"。
 */
describe("npm-installed PiWeb updates from the registry", () => {
	/** 复刻 npm 全局安装的目录布局。 */
	async function npmInstallation(version = "1.0.0") {
		const prefix = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-npm-")));
		roots.push(prefix);
		const root = path.join(prefix, "node_modules", "@rexvane", "piweb");
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@rexvane/piweb", version }));
		await build(root, ".next", "installed-build");
		return root;
	}

	const versions = async () => ({ piWeb: "1.0.0", piEngine: "1.0.0" });

	it("compares the registry version instead of touching Git", async () => {
		const root = await npmInstallation();
		const run = vi.fn(async (command: string, args: string[]) => {
			expect(command).toBe("npm");
			return args[0] === "view" ? "2.0.0\n" : "";
		});
		const check = await createUpdateService({ root, run, versions }).checkForUpdate("piweb");
		expect(check).toMatchObject({ current: "1.0.0", latest: "2.0.0", canUpdate: true, selfUpdate: canSelfUpdateNpmInstall() });
		// 不能原地替换的平台上，界面改显示这条命令
		expect(check.command).toBe(canSelfUpdateNpmInstall() ? undefined : "npm install -g @rexvane/piweb@latest");
		expect(run.mock.calls.map(([, args]) => args.join(" "))).toEqual(["view @rexvane/piweb version"]);
	});

	it("shows the install command instead of a button on Windows", async () => {
		// Windows 下运行中的 piweb 锁着自己的安装目录，npm rename 会 EBUSY（已实测）；
		// 所以这里必须给出命令，而不是一个注定失败的按钮。
		const root = await npmInstallation();
		const run = vi.fn(async (_command: string, args: string[]) => args[0] === "view" ? "2.0.0\n" : "");
		const check = await createUpdateService({ root, run, versions, platform: "win32" }).checkForUpdate("piweb");
		expect(check).toMatchObject({ canUpdate: true, selfUpdate: false, command: "npm install -g @rexvane/piweb@latest" });

		const service = createUpdateService({ root, run, versions, platform: "win32" });
		await expect(service.runUpdate("piweb", { assertIdle: async () => {} })).rejects.toThrow(/npm install -g @rexvane\/piweb@latest/);
		expect(run.mock.calls.some(([, args]) => args[0] === "install")).toBe(false);
	});

	it("installs the published package itself where the platform allows it", async () => {
		const root = await npmInstallation();
		const calls: string[][] = [];
		const run = vi.fn(async (command: string, args: string[]) => {
			expect(command).toBe("npm");
			calls.push(args);
			if (args[0] === "install") {
				// npm 用新版本的成品包替换目录内容（含 .next），服务进程仍跑旧代码直到重启
				await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@rexvane/piweb", version: "2.0.0" }));
				await build(root, ".next", "new-installed-build");
			}
			return "";
		});
		const result = await createUpdateService({ root, run, versions, platform: "linux" }).runUpdate("piweb", { assertIdle: async () => {} });
		expect(calls).toEqual([["install", "-g", "@rexvane/piweb@latest", "--no-audit", "--no-fund"]]);
		expect(result).toEqual({ buildDir: ".next", buildId: "new-installed-build", version: "2.0.0", needsRestart: true });
		// 不走 git、也不产生 release 清单：成品包自带构建
		await expect(fs.access(path.join(root, ".next-releases", "active.json"))).rejects.toThrow();
	});

	it("refuses to report success when npm updated a different copy", async () => {
		const root = await npmInstallation();
		const run = vi.fn(async (_command: string, args: string[]) => args[0] === "view" ? "2.0.0\n" : "");
		await expect(createUpdateService({ root, run, versions, platform: "linux" }).runUpdate("piweb", { assertIdle: async () => {} }))
			.rejects.toThrow(/not the global package/);
	});

	it("fails on a truncated installed build instead of after a restart", async () => {
		const root = await npmInstallation();
		const run = vi.fn(async (_command: string, args: string[]) => {
			if (args[0] === "install") {
				await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@rexvane/piweb", version: "2.0.0" }));
				// 0.3.7 就是这样发的：BUILD_ID 在，运行时清单不在
				await fs.rm(path.join(root, ".next", "required-server-files.json"));
			}
			return "";
		});
		await expect(createUpdateService({ root, run, versions, platform: "linux" }).runUpdate("piweb", { assertIdle: async () => {} }))
			.rejects.toThrow(/incomplete production build/);
	});
});
