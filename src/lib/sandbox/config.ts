/**
 * sandbox/config：`工作区内修改` 档额外允许写入的目录（`~/.pi/agent/web-sandbox.json`）。
 *
 * 为什么需要：真实项目经常要写工作区之外的东西——Git worktree 的共享 `.git`、构建缓存目录、
 * 兄弟仓库。没有这个口子，用户只能整体切到「完全权限」。
 *
 * 与 DSH 的 `additionalWritableRoots` 同一语义，但只接受**物理绝对目录**：
 *   - 相对路径、文件、不存在的路径一律拒绝（拼错就是显式报错，而不是悄悄不生效）；
 *   - 符号链接/junction 根也拒绝——链接本身指向哪里可以事后被改，边界就不成立了。
 *
 * 读配置时宽容（坏掉的条目跳过并告警），写配置时严格（throw），
 * 这样用户手动改坏文件不会让 shell 直接不可用。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "../pi";
import { randomUUID } from "node:crypto";
import { replaceFileAtomically } from "../atomic-file";
import { withSettingsWriteLock, withExternalSettingsLock } from "../settings-write-lock";
import { BoundaryError } from "../path-security";

export interface SandboxConfig {
	/** 已 realpath 的物理绝对目录 */
	additionalWritableRoots: string[];
}

const MAX_ROOTS = 8;
const MAX_PATH = 4096;

function configPath(): string {
	return path.join(getAgentDir(), "web-sandbox.json");
}

function comparable(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 单条校验：绝对路径、存在、是目录、不是链接根；返回 realpath */
async function resolveRoot(value: unknown): Promise<string> {
	if (typeof value !== "string") throw new BoundaryError("可写目录必须是字符串");
	const raw = value.trim();
	if (!raw) throw new BoundaryError("可写目录不能为空");
	if (raw.length > MAX_PATH) throw new BoundaryError(`路径过长（上限 ${MAX_PATH}）`);
	if (!path.isAbsolute(raw)) throw new BoundaryError(`必须是绝对路径：${raw}`);
	let real: string;
	try {
		real = await fs.realpath(raw);
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "")) throw new BoundaryError(`目录不存在：${raw}`);
		throw error;
	}
	if (comparable(real) !== comparable(raw)) throw new BoundaryError(`不接受符号链接/junction 根目录：${raw}`);
	const stat = await fs.stat(real);
	if (!stat.isDirectory()) throw new BoundaryError(`不是目录：${raw}`);
	return real;
}

/** 读配置：坏条目跳过并告警，不让一个手滑的路径把 shell 弄没 */
export async function readSandboxConfig(): Promise<SandboxConfig> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(configPath(), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { additionalWritableRoots: [] };
		return { additionalWritableRoots: [] };
	}
	const raw = (parsed as { additionalWritableRoots?: unknown })?.additionalWritableRoots;
	if (!Array.isArray(raw)) return { additionalWritableRoots: [] };

	const roots: string[] = [];
	const seen = new Set<string>();
	for (const entry of raw.slice(0, MAX_ROOTS)) {
		try {
			const real = await resolveRoot(entry);
			const key = comparable(real);
			if (seen.has(key)) continue;
			seen.add(key);
			roots.push(real);
		} catch (error) {
			console.warn(`[piweb] 忽略 web-sandbox.json 里的可写目录：${(error as Error)?.message ?? error}`);
		}
	}
	return { additionalWritableRoots: roots };
}

/** 写配置：严格校验，任何一条不合格就整体拒绝，避免"存了但没生效" */
export async function writeSandboxConfig(input: unknown): Promise<SandboxConfig> {
	const list = (input as { additionalWritableRoots?: unknown })?.additionalWritableRoots;
	if (!Array.isArray(list)) throw new BoundaryError("additionalWritableRoots 必须是数组");
	if (list.length > MAX_ROOTS) throw new BoundaryError(`最多 ${MAX_ROOTS} 个目录`);

	const roots: string[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		const real = await resolveRoot(entry);
		const key = comparable(real);
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push(real);
	}
	const target = configPath();
	await fs.mkdir(path.dirname(target), { recursive: true });
	await withSettingsWriteLock(target, () => withExternalSettingsLock(target, async () => {
		const temporary = target + "." + randomUUID() + ".tmp";
		try {
			await fs.writeFile(temporary, JSON.stringify({ version: 1, additionalWritableRoots: roots }, null, "\t") + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
			await replaceFileAtomically(temporary, target);
		} finally { await fs.unlink(temporary).catch(() => undefined); }
	}));
	return { additionalWritableRoots: roots };
}
