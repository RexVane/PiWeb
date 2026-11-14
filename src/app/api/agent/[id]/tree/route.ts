import { NextResponse } from "next/server";
import { getManaged } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";
import { buildSessionTree } from "@/lib/session-tree";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** 会话树上的用户提问（每一问是一个可以回去的位置）：保持 pi JSONL 树的真实分叉与当前分支。 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const m = getManaged(await resolveSessionPath(id, { allowPending: true }));
		const tree = buildSessionTree(m.sm);
		return NextResponse.json({
			success: true,
			data: {
				...tree,
				// 旧字段：这个接口最早只返回这两项，保留给还按老形状读的调用方
				userMessages: tree.nodes.map((node) => ({ entryId: node.entryId, ts: node.ts, text: node.text, depth: node.indent, label: node.label })),
				activeUserId: tree.nodes.find((node) => node.current)?.entryId ?? "",
			},
		}, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "会话分支读取失败，请重试。") },
			{ status: error instanceof BoundaryError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
