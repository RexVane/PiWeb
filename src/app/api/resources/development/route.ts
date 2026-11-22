import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { isResourceDesignWorkspace, prepareExistingResource, prepareNewResource, resourceAdaptationPrompt, type PreparedResource } from "@/lib/resources/development";
import { readPackageManifest } from "@/lib/resources/manifest";
import { effectiveResourceDevelopmentRoot } from "@/lib/resources/preferences";
import { resolveWorkspacePath, isPathInside } from "@/lib/path-security";
import { apiError } from "@/lib/api-error";
import { preparedResourceViews } from "@/lib/resources/preview";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
	try {
		const params = new URL(request.url).searchParams;
		const cwd = params.get("cwd");
		if (!cwd) throw new Error("Preview workspace is required");
		if (params.get("status") === "1") {
			const workspace = await resolveWorkspacePath(cwd);
			const design = await isResourceDesignWorkspace(workspace);
			const manifest = design ? await readPackageManifest(workspace).catch(() => undefined) : undefined;
			return NextResponse.json({ success: true, data: { design, hasWeb: Boolean(manifest?.piweb) } }, { headers: { "Cache-Control": "no-store" } });
		}
		return NextResponse.json({ success: true, data: { views: (await preparedResourceViews(cwd)).map((item) => item.view) } }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) { return NextResponse.json({ success: false, ...apiError(error, "Resource preview is unavailable.") }, { status: 400 }); }
}
export async function POST(request: Request) {
	try {
		const body = await request.json() as { action?: string; root?: string; source?: string; preparedCwd?: string };
		if (!body || typeof body !== "object" || Array.isArray(body) || body.root !== undefined && typeof body.root !== "string" || body.source !== undefined && typeof body.source !== "string") throw new Error("Invalid resource development request");
		let prepared: PreparedResource;
		if (body.action === "design") prepared = await prepareNewResource(body.root);
		else if (body.action === "inspect" || body.action === "adapt") {
			if (body.preparedCwd) {
				const root = await effectiveResourceDevelopmentRoot();
				const cwd = await resolveWorkspacePath(body.preparedCwd);
				if (!root || !isPathInside(await resolveWorkspacePath(root), cwd) || cwd === root) throw new Error("Not a prepared resource workspace");
				const upstream = JSON.parse(await fs.readFile(path.join(cwd, "piweb-upstream.json"), "utf8"));
				prepared = { cwd, source: upstream.source, name: upstream.name, version: upstream.version, types: ["extensions"], compatibility: "unknown" };
			} else {
				if (!body.source) throw new Error("Resource source is required");
				prepared = await prepareExistingResource(body.source, body.root);
			}
		} else throw new Error("Unknown resource development action");
		return NextResponse.json({ success: true, data: { prepared, ...(body.action === "adapt" ? { prompt: resourceAdaptationPrompt(prepared) } : {}) } }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) { return NextResponse.json({ success: false, ...apiError(error, "Resource preparation failed; acquired files were retained.", true) }, { status: 400 }); }
}
