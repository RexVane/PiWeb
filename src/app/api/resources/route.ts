import { NextResponse } from "next/server";
import { APP_ROOT } from "@/lib/app-root";
import { apiError } from "@/lib/api-error";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath, samePath } from "@/lib/path-security";
import { encodeSessionId } from "@/lib/pi";
import { discoverResourcePackages, resourceViews } from "@/lib/resources/discovery";
import { getResourcePreferences, saveResourcePreferences } from "@/lib/resources/preferences";
import { readResourceMarket } from "@/lib/resources/catalog";
import { invokeResourceAction, resourceHostStatuses } from "@/lib/resources/host";
import type { ResourcePreferences } from "@/lib/resources/protocol";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(request: Request) {
	try {
		const params = new URL(request.url).searchParams;
		const cwd = await resolveWorkspacePath(params.get("cwd") || APP_ROOT);
		if (params.get("market") === "1") return json({ success: true, data: await readResourceMarket({ fresh: params.get("fresh") === "1" }) });
		const [packages, views, preferences] = await Promise.all([discoverResourcePackages(cwd), resourceViews(cwd), getResourcePreferences()]);
		return json({ success: true, data: {
			packages: packages.map(({ root: _root, installRoot: _installRoot, manifest, ...item }) => ({ ...item, apiVersion: manifest?.apiVersion, hasHost: Boolean(manifest?.host) })),
			views, preferences, hosts: resourceHostStatuses(),
		} });
	} catch (error) { return json({ success: false, ...apiError(error, "Resource information is unavailable; existing data was not changed.") }, error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500); }
}

export async function POST(request: Request) {
	try {
		const text = await request.text();
		if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Resource request is too large");
		const body = JSON.parse(text) as Record<string, unknown>;
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid resource request");
		const cwd = await resolveWorkspacePath(body.cwd || APP_ROOT);
		if (body.action === "preferences") {
			const patch = body.preferences as Partial<ResourcePreferences>;
			if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid resource preferences");
			if (patch.developmentRoot !== undefined) patch.developmentRoot = await resolveWorkspacePath(patch.developmentRoot);
			if (patch.renderers) {
				const views = await resourceViews(cwd);
				for (const [method, id] of Object.entries(patch.renderers)) if (id && !views.some((view) => view.id === id && view.methods.includes(method as never))) throw new Error("Renderer is not an enabled compatible resource view");
			}
			return json({ success: true, data: { preferences: await saveResourcePreferences(patch) } });
		}
		if (body.action === "setEnabled" && typeof body.resourceId === "string" && typeof body.enabled === "boolean" && (body.scope === "user" || body.scope === "project")) {
			const { toggleResource } = await import("@/lib/plugins-service");
			await toggleResource(body.resourceId, !body.enabled, body.scope, cwd);
			return json({ success: true });
		}
		if (body.action === "invoke" && typeof body.resourceId === "string" && typeof body.name === "string") {
			let sessionPath: string | undefined;
			if (body.sessionPath !== undefined) {
				if (typeof body.sessionPath !== "string") throw new Error("Invalid resource session");
				sessionPath = await resolveSessionPath(encodeSessionId(body.sessionPath), { allowPending: true });
				const { getManaged } = await import("@/lib/agent-manager");
				if (!samePath(getManaged(sessionPath).cwd, cwd)) throw new Error("Resource session does not belong to this workspace");
			}
			const scope = body.scope === "user" || body.scope === "project" ? body.scope : undefined;
			return json({ success: true, data: await invokeResourceAction(body.resourceId, body.name, body.args, { cwd, sessionPath, scope, signal: request.signal }) });
		}
		throw new Error("Unknown resource action");
	} catch (error) { return json({ success: false, ...apiError(error, "Resource action failed; no approval was implied.") }, 400); }
}
