/**
 * permission-gate：把「权限档位」从工具白名单升级成执行期的真实闸门。
 *
 * lib/pi.ts 的 TOOL_PRESETS 只决定「哪些工具对模型可见」，它管不住三件事：
 *   1. 已经打开的 write / edit 到底写到哪个路径（`../`、绝对路径、符号链接、盘符变体都能出去）；
 *   2. bash 里敲什么（路径检查对任意命令无效）；
 *   3. 扩展后来注册的工具、MCP 工具（`mcp__*`）、codemode 脚本里对 tools.write 的嵌套调用
 *      —— 这些都会经过 SDK 的 tool_call，但白名单只按名字判断。
 *
 * pi 官方明确没有内置沙箱（docs/security.md）：工作目录只决定「默认位置」，
 * 不阻止工具访问其它路径。所以这里补一道执行期检查，与白名单一起构成「档位」的真实语义：
 *
 *   readonly   —— 任何会改盘 / 执行命令的调用直接拒绝（白名单之外的第二道锁，防策略被绕过）
 *   workspace  —— 写入目标的 realpath 必须仍在会话工作区内；shell 只在有 OS 沙箱时放行（bash），
 *                 交给内核关住边界；manage_automation 与 powershell 仍然拒绝；
 *                 MCP 只放 readOnlyHint 的工具；manage_automation 不放（能建更高权限的任务）
 *   full       —— 不限制
 *
 * 边界说明（不要把它当安全边界）：扩展与 pi 同进程、同 OS 权限，这里挡的是「模型通过 pi 工具
 * 管道发起的动作」。真正的工作区硬边界要么是容器，要么是 OS 级受限进程，见 docs/workspace-isolation.md。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "./path-security";
import type { ToolPreset } from "./types";

/** 能执行任意命令的工具：工作区档在无 OS 沙箱或不支持的 shell 上拒绝（路径检查管不住 shell） */
export const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "pwsh"]);

/** 会改盘或改运行环境的工具：只读档一律拒绝 */
const MUTATING_TOOL_NAMES = new Set([...SHELL_TOOL_NAMES, "write", "edit", "codemode", "manage_automation"]);

/** 带文件路径的写工具 → 输入里的路径字段名（与 pi 内置工具的参数名一致） */
export const WRITE_PATH_FIELDS = new Map([
	["write", "path"],
	["edit", "path"],
]);

const MCP_PREFIX = "mcp__";

/** 与 pi 的 resolveToCwd 对齐：去 `@` 前缀、把各种不间断空格换成普通空格、展开 `~`。 */
export function resolveModelPath(raw: string, cwd: string, home: string = os.homedir()): string {
	let cleaned = raw
		.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
		.trim()
		.replace(/^@/, "");
	// Match pi's resolveToCwd on Windows; authorization and the SDK must agree
	// on Git Bash / MSYS / WSL drive spellings before choosing an execution scope.
	if (process.platform === "win32" && cleaned.startsWith("/") && !cleaned.startsWith("//") && !cleaned.includes("\\")) {
		const drive = cleaned.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (drive) cleaned = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
	}
	if (/^file:/i.test(cleaned)) return fileURLToPath(cleaned);
	if (/^[a-z][a-z\d+.-]*:/i.test(cleaned) && !/^[a-z]:[\\/]/i.test(cleaned)) throw new Error("unsupported file path scheme");
	const expanded = cleaned === "~"
		? home
		: cleaned.startsWith("~/") || cleaned.startsWith("~\\")
			? path.join(home, cleaned.slice(2))
			: cleaned;
	return path.resolve(cwd, expanded);
}

/**
 * 取真实路径；目标还不存在时按「最近的已存在祖先的真实路径 + 剩余段」求值
 * —— write 新建文件就是这种情形，直接 realpath 会 ENOENT，从而漏掉父目录是指向外部的链接。
 */
export async function realpathLoose(target: string): Promise<string> {
	let current = path.resolve(target);
	const tail: string[] = [];
	for (;;) {
		try {
			const real = await fs.realpath(current);
			return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

export interface PathVerdict {
	/** 目标（解析符号链接后）是否仍在工作区内 */
	inside: boolean;
	/** 解析后的目标绝对路径，用于错误信息与排错 */
	resolved: string;
	/** 工作区根的真实路径 */
	root: string;
}

/**
 * 判断一次写入是否落在工作区内。比较的是 realpath 之后的路径：
 * 大小写（Windows）、软链接、junction、`..` 别名都在这一步归一到同一形态。
 *
 * 先做一次不含文件系统的字符串判断再 realpath：`../x`、绝对路径、UNC、设备路径这些
 * 一望即知的越界不必碰盘（UNC 还会去连网络，不能因为一次越界检查挂住），
 * 只有「字面上在工作区内」的才需要 realpath 去查链接。
 */
export async function judgeWritePath(
	cwd: string,
	rawPath: string,
	additionalWritableRoots: readonly string[] = [],
): Promise<PathVerdict> {
	const plainWorkspace = path.resolve(cwd);
	let target: string;
	try {
		if (/^[\\/]{2}/.test(rawPath.trim().replace(/^@/, ""))) return { inside: false, resolved: rawPath, root: plainWorkspace };
		target = resolveModelPath(rawPath, cwd);
	} catch {
		return { inside: false, resolved: rawPath, root: plainWorkspace };
	}
	const candidates = [
		plainWorkspace,
		...additionalWritableRoots
			.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
			.map((entry) => path.resolve(cwd, entry)),
	];
	if (!candidates.some((candidate) => isPathInside(candidate, target))) {
		return { inside: false, resolved: target, root: plainWorkspace };
	}
	let resolved: string;
	let realRoots: string[];
	try {
		[resolved, ...realRoots] = await Promise.all([
			realpathLoose(target),
			...candidates.map((candidate) => fs.realpath(candidate)),
		]);
		const stat = await fs.stat(resolved).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		});
		if (stat?.isFile() && stat.nlink > 1) return { inside: false, resolved, root: realRoots[0] ?? plainWorkspace };
	} catch {
		return { inside: false, resolved: target, root: plainWorkspace };
	}
	const matchedRoot = realRoots.find((root) => isPathInside(root, resolved));
	if (matchedRoot) return { inside: true, resolved, root: matchedRoot };
	return { inside: false, resolved, root: realRoots[0] ?? plainWorkspace };
}

export interface ToolCallGateRequest {
	preset: ToolPreset;
	/** 会话工作区（AgentSession 的 cwd） */
	cwd: string;
	toolName: string;
	input: unknown;
	/** MCP 工具声明的只读提示；拿不到就当「可写」处理 */
	readOnlyHint?: boolean;
	/**
	 * 这台机器上是否有 OS 级 shell 沙箱（见 lib/sandbox/manager 的能力探测）。
	 * false = 工作区档没有 shell；true = 有，交给沙箱关住。缺省按 false 处理。
	 */
	shellAvailable?: boolean;
	/** 沙箱配置里允许写入的工作区外目录（与 bash 沙箱的 extraRoots 对齐） */
	additionalWritableRoots?: readonly string[];
}

export interface ToolCallDenial {
	block: true;
	reason: string;
}

function pathOf(input: unknown, field: string): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const value = (input as Record<string, unknown>)[field];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

const switchHint = "Switch the permission level to 工作区内修改 (workspace) or 完全权限 (full) if the user approves.";

/**
 * 一次工具调用的执行期裁决。返回 undefined 表示放行。
 * 异步是因为要 realpath（写入路径校验）；SDK 的 tool_call 处理器支持 await。
 */
export async function permissionDenial(request: ToolCallGateRequest): Promise<ToolCallDenial | undefined> {
	const { preset, cwd, toolName, input, readOnlyHint, shellAvailable = false, additionalWritableRoots } = request;
	if (preset === "full") return undefined;

	const isMcp = toolName.startsWith(MCP_PREFIX);

	if (preset === "readonly") {
		// 只读档的 shell 也走沙箱（一个可写目录都不给）；没有后端就还是拒绝。
		if (toolName === "bash" && shellAvailable) return undefined;
		if (MUTATING_TOOL_NAMES.has(toolName)) {
			return {
				block: true,
				reason: `Tool "${toolName}" is blocked: this session is 仅可查看 (readonly), so nothing may modify files or run commands. ${switchHint}`,
			};
		}
		if (isMcp && readOnlyHint !== true) {
			return {
				block: true,
				reason: `MCP tool "${toolName}" is blocked: this session is 仅可查看 (readonly), and the server does not declare it as read-only. ${switchHint}`,
			};
		}
		return undefined;
	}

	// workspace
	if (SHELL_TOOL_NAMES.has(toolName)) {
		// 只有 bash 有受限执行后端；powershell 没有对应实现，保持拒绝（否则就是不受限的 shell）
		const confined = toolName === "bash" && shellAvailable;
		if (!confined) {
			return {
				block: true,
				reason: toolName === "bash" && !shellAvailable
					? `Tool "bash" is blocked: 工作区内修改 (workspace) has no shell on this machine (no OS-level sandbox backend), because path checks cannot confine arbitrary commands. Stay with file tools, or switch to 完全权限 (full) if the user approves.`
					: `Tool "${toolName}" is blocked at 工作区内修改 (workspace): only bash runs inside the OS sandbox; ${toolName} has no confined backend. Switch to 完全权限 (full) if the user approves.`,
			};
		}
	}
	if (toolName === "manage_automation") {
		// 自动化任务自带权限档位，能建出一个 full 档的任务再从那里跑 shell —— 等于开后门。
		// codemode 不在这里挡：它调用的每个工具都会各自过一次本闸门（路径照样 realpath 校验）。
		return {
			block: true,
			reason: `Tool "${toolName}" is blocked at 工作区内修改 (workspace): automation tasks run with their own permission preset, so they can act outside the workspace. ${switchHint}`,
		};
	}
	if (isMcp && readOnlyHint !== true) {
		return {
			block: true,
			reason: `MCP tool "${toolName}" is blocked at 工作区内修改 (workspace): the server does not declare it as read-only, so it may write outside the workspace. ${switchHint}`,
		};
	}
	const field = WRITE_PATH_FIELDS.get(toolName);
	if (!field) return undefined;
	const rawPath = pathOf(input, field);
	if (!rawPath) return undefined; // 参数缺失交给 pi 自己的校验报错
	const verdict = await judgeWritePath(cwd, rawPath, additionalWritableRoots);
	if (verdict.inside) return undefined;
	return {
		block: true,
		reason: `Writing "${rawPath}" is blocked: it resolves to "${verdict.resolved}", outside the workspace "${verdict.root}". 工作区内修改 (workspace) only allows edits inside the workspace; use a path inside it, or switch to 完全权限 (full) if the user approves.`,
	};
}
