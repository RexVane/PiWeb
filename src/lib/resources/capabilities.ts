import { resourceViews } from "./discovery";
import { RESOURCE_BROWSER_CAPABILITIES, type JsonValue, type ResourceActionContext, type ResourceBrowserCapability } from "./protocol";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath, samePath } from "../path-security";
import { encodeSessionId } from "../pi";
import { getWorkspaceRegistry } from "../workspace-store";

/** Validate every call against the live declaration, not the frame's cached manifest. */
export async function invokeResourceCapability(resourceId: string, viewId: string, name: string, raw: unknown, context: ResourceActionContext): Promise<JsonValue> {
	context.signal?.throwIfAborted();
	if (!RESOURCE_BROWSER_CAPABILITIES.includes(name as ResourceBrowserCapability)) throw new BoundaryError("Unknown resource capability");
	const view = (await resourceViews(context.cwd)).find((item) => item.id === viewId && item.resourceId === resourceId && (!context.scope || item.scope === context.scope));
	if (!view || !view.capabilities?.includes(name as ResourceBrowserCapability)) throw new BoundaryError("Resource capability is unavailable or not declared");
	if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) throw new BoundaryError("Invalid capability arguments");
	const args = (raw ?? {}) as Record<string, unknown>;
	const workspaces = async () => {
		const registry = await getWorkspaceRegistry();
		if (registry.error) throw new Error("Workspace registry is unavailable");
		const candidates = [context.cwd, ...registry.workspaces.filter((cwd) => !registry.removedWorkspaces.some((removed) => samePath(removed, cwd)))];
		const result: Array<{ cwd: string; name: string }> = [];
		for (const candidate of candidates.slice(0, 512)) {
			const cwd = await resolveWorkspacePath(candidate).catch(() => undefined);
			if (cwd && !result.some((item) => samePath(item.cwd, cwd))) result.push({ cwd, name: registry.aliases[cwd] || cwd });
		}
		return result;
	};
	const targetWorkspace = async () => {
		const cwd = await resolveWorkspacePath(args.cwd ?? context.cwd);
		if (!(await workspaces()).some((item) => samePath(item.cwd, cwd))) throw new BoundaryError("Select a registered workspace first");
		return cwd;
	};
	let result: JsonValue;
	if (name === "workspaces.list") result = { workspaces: await workspaces() };
	else if (name === "models.list") {
		const cwd = await targetWorkspace();
		const { listWorkspaceModelsForPiWeb } = await import("../models-service");
		const { models } = await listWorkspaceModelsForPiWeb(cwd);
		result = { cwd, models: models.map(({ provider, id, name }) => ({ provider, id, name })) };
	} else if (name === "sessions.open") {
		if (typeof args.sessionPath !== "string") throw new BoundaryError("A session path is required");
		const sessionPath = await resolveSessionPath(encodeSessionId(args.sessionPath), { allowPending: true });
		result = { type: "sessions.open", sessionPath };
	} else if (name === "views.open") {
		if (typeof args.viewId !== "string" || args.viewId.length > 80) throw new BoundaryError("Invalid dialog view");
		const target = (await resourceViews(context.cwd)).find((item) => item.resourceId === resourceId && item.scope === view.scope && item.id.endsWith(`:${args.viewId}`) && item.placement === "dialog");
		if (!target || JSON.stringify(args.data ?? null).length > 120 * 1024) throw new BoundaryError("Resource dialog is unavailable or too large");
		result = JSON.parse(JSON.stringify({ type: "views.open", view: target, cwd: context.cwd, sessionPath: context.sessionPath, data: args.data ?? null }));
	} else {
		if (typeof args.text !== "string" || args.text.length > 50_000) throw new BoundaryError("Invalid draft text");
		result = { type: "sessions.draft", cwd: await targetWorkspace(), text: args.text };
	}
	context.signal?.throwIfAborted();
	// A revoke that races an async catalog read must not grant a stale navigation intent.
	const current = (await resourceViews(context.cwd)).find((item) => item.id === viewId && item.resourceId === resourceId && item.scope === view.scope);
	if (!current?.capabilities?.includes(name as ResourceBrowserCapability)) throw new BoundaryError("Resource capability was revoked");
	return result;
}
