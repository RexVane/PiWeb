import fs from "node:fs/promises";
import path from "node:path";
import { decodeSessionId, getAgentDir, isSessionId } from "./pi";

export class BoundaryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BoundaryError";
	}
}

function comparable(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(comparable(root), comparable(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveSessionPath(id: string, options?: { allowPending?: boolean }): Promise<string> {
	if (!isSessionId(id)) throw new BoundaryError("invalid session id");
	const decoded = decodeSessionId(id);
	if (!path.isAbsolute(decoded) || path.extname(decoded).toLowerCase() !== ".jsonl") {
		throw new BoundaryError("invalid session path");
	}

	const sessionsRoot = path.join(getAgentDir(), "sessions");
	const realRoot = await fs.realpath(sessionsRoot).catch(() => path.resolve(sessionsRoot));
	if (!isPathInside(realRoot, path.resolve(decoded))) throw new BoundaryError("session path is outside the Pi session store");

	// A freshly created session may not be materialized on disk yet
	// (SessionManager is lazy); allow pending sessions through so setup
	// commands can apply first. The real file is materialized by ensureSession.

	if (options?.allowPending) return decoded;

	const realFile = await fs.realpath(decoded).catch(() => {
		throw new BoundaryError("session not found");
	});
	const stat = await fs.stat(realFile);
	if (!stat.isFile()) throw new BoundaryError("session is not a file");
	return realFile;
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
	return real;
}

export function samePath(left: string, right: string): boolean {
	return comparable(left) === comparable(right);
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