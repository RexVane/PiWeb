import fs from "node:fs/promises";
import path from "node:path";
import { decodeSessionId, getAgentDir, isSessionId } from "./pi";
import { BoundaryError, isPathInside, samePath } from "./path-boundary";

export { BoundaryError, isPathInside, samePath } from "./path-boundary";

export async function resolveSessionPath(id: string, options?: { allowPending?: boolean }): Promise<string> {
	if (!isSessionId(id)) throw new BoundaryError("invalid session id");
	const decoded = decodeSessionId(id);
	if (!path.isAbsolute(decoded) || path.extname(decoded).toLowerCase() !== ".jsonl") {
		throw new BoundaryError("invalid session path");
	}

	const sessionsRoot = path.join(getAgentDir(), "sessions");
	const realRoot = await fs.realpath(sessionsRoot).catch(() => path.resolve(sessionsRoot));
	// Compare canonical paths, not spellings: Windows short paths and junctions
	// can give the same store several legitimate absolute names.
	const realFile = await fs.realpath(decoded).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (realFile) {
		if (!isPathInside(realRoot, realFile)) throw new BoundaryError("session path escapes the Pi session store");
		const stat = await fs.stat(realFile);
		if (!stat.isFile()) throw new BoundaryError("session is not a file");
		return options?.allowPending ? decoded : realFile;
	}
	if (!options?.allowPending) throw new BoundaryError("session not found");

	// SessionManager creates files lazily. The nearest existing parent must
	// resolve inside the store; an outside link remains forbidden.
	let parent = path.dirname(decoded);
	for (;;) {
		const realParent = await fs.realpath(parent).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (realParent) {
			if (!isPathInside(realRoot, realParent)) throw new BoundaryError("session path escapes the Pi session store");
			return decoded;
		}
		const next = path.dirname(parent);
		if (next === parent) throw new BoundaryError("session store not found");
		parent = next;
	}
}

/**
 * 可选严格工作区模式（默认关闭，保持现状）：
 * `PIWEB_FS_STRICT_WORKSPACES=1` 时，`resolveWorkspacePath` 除了原有的存在性/目录校验，
 * 还要求目标位于「已注册工作区」或 `PIWEB_FS_ALLOWED_ROOTS`（用 path.delimiter 分隔）之内。
 * 认证后的文件接口因此不再能拿任意现存目录当 cwd；未开启时行为逐字不变。
 */
export function strictWorkspaceModeEnabled(): boolean {
	const raw = process.env.PIWEB_FS_STRICT_WORKSPACES?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

/** 显式允许的根目录（严格模式用）：部署方可以给出工作区之外但明确可用的目录。 */
function configuredAllowedRoots(): string[] {
	return (process.env.PIWEB_FS_ALLOWED_ROOTS ?? "")
		.split(path.delimiter)
		.map((value) => value.trim())
		.filter(Boolean);
}

/** 已注册工作区根：读注册表失败时按「没有注册」处理，不影响普通路径校验的报错口径。 */
async function registeredWorkspaceRoots(): Promise<string[]> {
	try {
		const { listAdded } = await import("./workspace-store");
		return await listAdded();
	} catch {
		return [];
	}
}

async function assertStrictWorkspace(real: string): Promise<void> {
	const roots = [...configuredAllowedRoots(), ...await registeredWorkspaceRoots()];
	for (const root of roots) {
		let realRoot: string;
		try {
			realRoot = await fs.realpath(root);
		} catch {
			realRoot = path.resolve(root);
		}
		if (isPathInside(realRoot, real)) return;
	}
	throw new BoundaryError("workspace is not registered; add it as a workspace or set PIWEB_FS_ALLOWED_ROOTS");
}

export async function resolveWorkspacePath(value: unknown): Promise<string> {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096) {
		throw new BoundaryError("invalid workspace path");
	}
	const real = await fs.realpath(path.resolve(value.trim())).catch(() => {
		throw new BoundaryError("workspace not found");
	});
	const stat = await fs.stat(real);
	if (!stat.isDirectory()) throw new BoundaryError("workspace is not a directory");
	if (strictWorkspaceModeEnabled()) await assertStrictWorkspace(real);
	return real;
}

export async function resolveDiscoveredPath(requested: string, allowed: string[]): Promise<string> {
	if (typeof requested !== "string" || !path.isAbsolute(requested) || requested.length > 4096) {
		throw new BoundaryError("invalid resource path");
	}
	const realRequested = await fs.realpath(requested).catch(() => {
		throw new BoundaryError("resource not found");
	});
	for (const candidate of allowed) {
		if (!candidate) continue;
		const realCandidate = await fs.realpath(candidate).catch(() => null);
		if (realCandidate && samePath(realRequested, realCandidate)) return realRequested;

	}
	throw new BoundaryError("resource is not part of the discovered Pi configuration");
}
