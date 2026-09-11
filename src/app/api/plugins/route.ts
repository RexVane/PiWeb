import { NextResponse } from "next/server";
import {
	installPackage,
	listLoadedExtensions,
	listPackages,
	reloadExtensions,
	removePackage,
	toggleExtension,
	togglePackage,
	updatePackages,
} from "@/lib/plugins-service";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const cwd = await resolveWorkspacePath(new URL(req.url).searchParams.get("cwd") || process.cwd());
		const [packages, extensions] = await Promise.all([listPackages(cwd), listLoadedExtensions(cwd)]);
		return NextResponse.json({ success: true, data: { packages, extensions } });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action: "install" | "remove" | "update" | "reload" | "toggle";
			source?: string;
			path?: string;
			kind?: "package" | "extension";
			disabled?: boolean;
			scope?: "user" | "project";
			local?: boolean;
			cwd?: string;
		};
		const cwd = await resolveWorkspacePath(body.cwd || process.cwd());
		if (body.source && body.source.length > 4096) {
			return NextResponse.json({ success: false, error: "package source is too long" }, { status: 400 });
		}
		if (body.action === "reload") {
			const reloaded = await reloadExtensions(cwd);
			return NextResponse.json({ success: true, data: reloaded });
		}
		if (body.action === "toggle") {
			if (body.kind === "package" && body.source) {
				await togglePackage(body.source, body.disabled === true, body.scope === "project" ? "project" : "user", cwd);
				return NextResponse.json({ success: true });
			}
			if (body.kind === "extension" && body.path) {
				await toggleExtension(body.path, body.disabled === true, cwd);
				return NextResponse.json({ success: true });
			}
			return NextResponse.json({ success: false, error: "invalid toggle payload" }, { status: 400 });
		}
		if (body.action === "install") {
			if (!body.source) return NextResponse.json({ success: false, error: "missing source" }, { status: 400 });
			await installPackage(body.source, body.local === true, cwd);
			return NextResponse.json({ success: true });
		}
		if (body.action === "remove") {
			if (!body.source) return NextResponse.json({ success: false, error: "missing source" }, { status: 400 });
			const removed = await removePackage(body.source, body.local === true, cwd);
			if (!removed) return NextResponse.json({ success: false, error: `package not found: ${body.source}` }, { status: 404 });
			return NextResponse.json({ success: true, data: { removed } });
		}
		if (body.action === "update") {
			await updatePackages(body.source, cwd);
			return NextResponse.json({ success: true });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500 },
		);
	}
}
