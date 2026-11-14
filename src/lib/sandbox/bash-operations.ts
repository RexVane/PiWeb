/**
 * sandbox/bash-operations：把 pi 的 bash 工具接到受限执行上。
 *
 * 只换「怎么起进程」，不换工具语义：schema、输出截断、临时脚本、渲染都还是 pi 的
 * `createBashToolDefinition` 在管，我们只提供 `BashOperations`。
 *
 * 档位 × 升权 → 执行方式：
 *   - full：本地执行（用户明确要的完全权限）；
 *   - workspace：ACL 沙箱，可写 = 工作区 + 额外目录 + 私有 temp；
 *   - readonly：ACL 沙箱，一个可写目录都不给（只读命令能跑，写全被内核拒）；
 *   - 一次性升权（用户刚刚批准过）：按批准的范围跑这一条，然后消耗掉。
 *
 * 沙箱建不起来时**报错拒绝执行**，绝不退化成不受限的本地执行。
 *
 * 解释器选择（`resolveSandboxShell`）：
 *   先解析用户设置及 pi 默认解释器并排除 WSL 启动器。
 *   LPAC 下原生 Git Bash 的共享系统对象不可用，因此受限档最终使用 cmd.exe；
 *   full 档保留 pi 的本地解释器配置。
 */
import fs from "node:fs";
import { createLocalBashOperations, getShellConfig, type BashOperations } from "@earendil-works/pi-coding-agent";
import { sandboxFor, type SandboxMode } from "./manager";
import { readSandboxConfig } from "./config";
import type { SandboxShell } from "./windows-acl";
import type { ToolPreset } from "../types";

/** 一次性升权的范围：比当前档位更宽一档即可，不给"一步到 full"以外的选择 */
export type EscalationScope = "workspace" | "full";

export interface SandboxBashContext {
	sessionPath: string;
	/** 会话工作区：只给本沙箱 SID 写权限 */
	cwd: string;
	/** 执行时读当前档位（切换立即生效，不必重建工具） */
	preset: () => ToolPreset;
	/** `settings.shellPath`：用户指定的解释器 */
	shellPath?: string | null;
	/** 取并消耗一次性升权（用户在审批卡上刚批准过的那一次）；参数是即将执行的命令，用于审计 */
	consumeGrant?: (command: string) => EscalationScope | null;
}

const CMD_SHELL: SandboxShell = { path: "cmd.exe", transport: "argv" };

/** WSL 启动器：命令会被交给 WSL，Windows 令牌的写入边界对它无效 */
export function isWslBash(path: string): boolean {
	const normalized = path.replaceAll("/", "\\").toLowerCase();
	if (!/(^|\\)bash\.exe$/.test(normalized)) return false;
	const systemRoot = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
	if (normalized === `${systemRoot}\\system32\\bash.exe` || normalized === `${systemRoot}\\sysnative\\bash.exe`) return true;
	return normalized.includes("\\windowsapps\\bash.exe");
}

const warned = new Set<string>();
const resolved = new Map<string, SandboxShell>();

/**
 * 解析用户期望的解释器；执行时再根据 LPAC 能力回落到 cmd。
 * 结果按 shellPath 缓存：`getShellConfig()` 内部可能 spawn `where`，不能每条命令都算一次。
 * `findDefaultShell` 仅供测试注入（结果不依赖本机 PATH 上有没有 bash）；注入时不读写缓存。
 */
export function resolveSandboxShell(shellPath?: string | null, findDefaultShell?: () => string | undefined): SandboxShell {
	const key = shellPath?.trim() ?? "";
	const cached = findDefaultShell ? undefined : resolved.get(key);
	if (cached) return cached;

	const configured = key || undefined;
	if (configured && isWslBash(configured) && !warned.has(configured)) {
		warned.add(configured);
		// 用户明确配了 shell，却用不了：说清楚原因，而不是悄悄换掉
		console.warn(`[piweb] settings.shellPath 指向 WSL 启动器（${configured}）：命令交给 WSL 后 Windows 令牌约束不到写入，工作区内修改档改用 cmd.exe`);
	}
	let fallback: string | undefined;
	try {
		fallback = findDefaultShell ? findDefaultShell() : getShellConfig().shell;
	} catch {
		// 本机找不到 bash 时 pi 会抛错：受限档本来就落到 cmd，不能因此连 cmd 都用不了
		fallback = undefined;
	}
	const candidates = [configured, fallback].filter((value): value is string => Boolean(value));
	let picked = CMD_SHELL;
	for (const candidate of candidates) {
		if (isWslBash(candidate)) continue;
		if (!/bash(\.exe)?$/i.test(candidate)) continue;
		if (!fs.existsSync(candidate)) continue;
		picked = { path: candidate, transport: "script", scriptExt: ".sh" };
		break;
	}
	if (!findDefaultShell) resolved.set(key, picked);
	return picked;
}

/** 子进程环境通过原生 UTF-16 环境块传递，不把键值拼进命令文本。 */
function envAssignments(base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	// 只补「父进程里本来没有」的变量（例如 pi 注入的 PI_*），其余靠继承，避免命令行过长
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined || value.includes("\0")) continue;
		if (process.env[key] === value) continue;
		out[key] = value;
	}
	return { ...out, ...extra };
}

const UNAVAILABLE = "sandbox unavailable: refusing to run a shell command unconfined";

export function createSandboxBashOperations(context: SandboxBashContext): BashOperations {
	// full 档沿用 pi 的本地执行，解释器同样跟着 settings.shellPath 走
	const local = createLocalBashOperations({ shellPath: context.shellPath?.trim() || undefined });
	return {
		exec: async (command, cwd, options) => {
			const preset = context.preset();
			// full 档本来就不受限，没必要消耗一次授权
			const grant = preset === "full" ? null : context.consumeGrant?.(command) ?? null;
			if (grant === "full" || (!grant && preset === "full")) return local.exec(command, cwd, options);

			const mode: SandboxMode = grant === "workspace" || (!grant && preset === "workspace") ? "workspace" : "readonly";
			// readonly 不给任何可写目录，额外目录也只在 workspace 模式下生效
			const extraRoots = mode === "workspace" ? (await readSandboxConfig()).additionalWritableRoots : [];
			const selectedShell = resolveSandboxShell(context.shellPath);
			if (selectedShell.transport === "script" && !warned.has("appcontainer:" + selectedShell.path)) {
				warned.add("appcontainer:" + selectedShell.path);
				console.warn("[piweb] 原生 Git Bash 需要沙箱外的共享系统对象，受限权限档改用 cmd.exe。");
			}
			const holder = await sandboxFor(context.sessionPath, context.cwd, {
				mode,
				extraRoots,
				shell: selectedShell.transport === "script" ? CMD_SHELL : selectedShell,
			});
			if (!holder) throw new Error(`${UNAVAILABLE} under ${mode === "workspace" ? "工作区内修改 (workspace)" : "仅可查看 (readonly)"}. File tools remain available. Check the isolation diagnostic, native dependency installation, and shared hard links in writable roots; retry after resolving the cause, or request explicit full permission for this exact command.`);

			const result = await holder.sandbox.exec(command, {
				cwd,
				onData: options.onData,
				signal: options.signal,
				// pi 的 BashOperations 约定 timeout 以秒计，沙箱按毫秒计
				timeout: options.timeout === undefined ? undefined : options.timeout * 1000,
				// 只有 workspace 模式给 TMP/TEMP（readonly 模式下子进程连临时文件都不该写）
				env: envAssignments(
					(options.env ?? {}) as Record<string, string | undefined>,
					mode === "workspace" ? { TMP: holder.tempDir, TEMP: holder.tempDir } : {},
				),
			});
			// 与 pi 本地后端同一套错误约定：bash 工具只认这两种消息，认出来才会保留已有输出并写明原因
			if (result.timedOut) throw new Error(`timeout:${options.timeout}`);
			if (result.aborted) throw new Error("aborted");
			// 输出超限时沙箱只是不再转发，命令照常跑完；截断由 pi 自己的输出累加器负责
			return { exitCode: result.exitCode };
		},
	};
}
