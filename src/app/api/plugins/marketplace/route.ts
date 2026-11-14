import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
	getLocalPiRuntimeInfo,
	inspectMarketplacePackages,
	searchMarketplacePlugins,
	type MarketplaceCategory,
} from "@/lib/plugins-marketplace";

export const dynamic = "force-dynamic";

const VALID_CATEGORIES = new Set<MarketplaceCategory>(["all", "tools", "mcp", "theme", "context"]);

export async function GET(req: NextRequest) {
	try {
		const q = req.nextUrl.searchParams.get("q") ?? "";
		const rawCategory = req.nextUrl.searchParams.get("category") ?? "all";
		const category: MarketplaceCategory = VALID_CATEGORIES.has(rawCategory as MarketplaceCategory)
			? (rawCategory as MarketplaceCategory)
			: "all";
		const sizeParam = Number(req.nextUrl.searchParams.get("size") ?? 24);
		const size = Number.isFinite(sizeParam) ? sizeParam : 24;
		const refresh = req.nextUrl.searchParams.get("refresh") === "1";

		const result = await searchMarketplacePlugins({ query: q, category, size, refresh });
		return NextResponse.json(result);
	} catch (error) {
		return NextResponse.json(
			{ ...apiError(error, "插件市场暂时不可用，请检查网络连接后重试。"), items: [] },
			{ status: 502 },
		);
	}
}

export async function POST(req: NextRequest) {
	try {
		const body = (await req.json()) as { packages?: unknown };
		const rawPackages = Array.isArray(body?.packages) ? body.packages : [];
		const specs = rawPackages
			.filter((entry): entry is { name: string; version?: string } => Boolean(entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"))
			.map((entry) => ({
				name: entry.name,
				...(typeof entry.version === "string" ? { version: entry.version } : {}),
			}));
		const runtime = getLocalPiRuntimeInfo();
		const compatibility = await inspectMarketplacePackages(specs, { runtime });
		return NextResponse.json({ success: true, data: { compatibility, runtime } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "插件兼容性检查失败，请稍后重试。") },
			{ status: error instanceof SyntaxError ? 400 : 502 },
		);
	}
}
