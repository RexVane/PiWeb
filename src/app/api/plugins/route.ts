import { NextResponse } from "next/server";
import { PackageSourceValidationError } from "@/lib/package-manager-safe";
import {
	ExtensionToggleError,
	ResourceRefreshError,
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
import { APP_ROOT } from "@/lib/app-root";
import { apiError } from "@/lib/api-error";
import { NpmTransactionPendingCommitError } from "@/lib/npm-install-transaction";
import { publicDiagnostic } from "@/lib/public-diagnostic";
import { parseResourceSelection } from "@/lib/resources/selection";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const cwd = await resolveWorkspacePath(new URL(req.url).searchParams.get("cwd") || APP_ROOT);
		const [packages, extensions] = await Promise.all([listPackages(cwd), listLoadedExtensions(cwd)]);
		return NextResponse.json({ success: true, data: {
			packages,
			extensions: extensions.map((extension) => extension.error ? { ...extension, error: publicDiagnostic(extension.error, "此扩展加载失败，请检查扩展配置后重新载入。") } : extension),
		} });
	} catch (err: unknown) {
		return NextResponse.json({ success: false, ...apiError(err, "读取插件失败，请检查文件权限或稍后重试。") }, { status: err instanceof BoundaryError ? 400 : 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action: "install" | "remove" | "update" | "reload" | "toggle";
			source?: string;
			selection?: unknown;
			path?: string;
			kind?: "package" | "extension";
			disabled?: boolean;
			scope?: "user" | "project";
			local?: boolean;
			cwd?: string;
		};
		const cwd = await resolveWorkspacePath(body.cwd || APP_ROOT);
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
			if (body.selection === undefined) await installPackage(body.source, body.local === true, cwd);
			else await installPackage(body.source, body.local === true, cwd, parseResourceSelection(body.selection));
			return NextResponse.json({ success: true });
		}
		if (body.action === "remove") {
			if (!body.source) return NextResponse.json({ success: false, error: "missing source" }, { status: 400 });
			const removed = await removePackage(body.source, body.local === true, cwd);
			if (!removed) return NextResponse.json({ success: false, error: "请求的插件包不存在，请刷新插件列表后重试。" }, { status: 404 });
			return NextResponse.json({ success: true, data: { removed } });
		}
		if (body.action === "update") {
			await updatePackages(body.source, cwd);
			return NextResponse.json({ success: true });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (error) {
		if (error instanceof NpmTransactionPendingCommitError) return NextResponse.json({ success: false, pending: true, error: error.message }, { status: 503, headers: { "Cache-Control": "no-store" } });
		if (error instanceof ResourceRefreshError) {
			const fallback = error.warningCode === "PACKAGE_TRASH_PENDING"
				? "插件卸载已生效，但旧安装尚未全部进入系统回收站；文件和恢复记录已保留，请检查回收站后刷新列表。"
				: "插件配置已保存，但刷新失败。请在会话空闲后重新载入插件。";
			return NextResponse.json({ success: true, data: { applied: true, warning: apiError(error, fallback).error, ...(error.warningCode ? { warningCode: error.warningCode } : {}) } });
		}
		const failure = apiError(error, "插件操作失败，请检查来源和文件权限后重试。", error instanceof ExtensionToggleError || error instanceof PackageSourceValidationError);
		if (error instanceof ExtensionToggleError && error.message.includes("whole-package")) failure.error = "此扩展属于插件包，请使用整个插件包的开关（whole-package）。";
		return NextResponse.json(
			{ success: false, ...failure },
			{ status: error instanceof BoundaryError || error instanceof SyntaxError || error instanceof ExtensionToggleError || error instanceof PackageSourceValidationError ? 400 : 500 },
		);
	}
}
