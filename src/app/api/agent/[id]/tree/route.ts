import { NextResponse } from "next/server";
import { getManaged } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (typeof item === "string" ? item : item && typeof item === "object" && "text" in item ? String(item.text ?? "") : ""))
		.join(" ");
}

/** 会话树上的用户消息（分支点）：保持 Pi JSONL 树的真实层级与活动分支。 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const m = getManaged(await resolveSessionPath(id));
		const activeBranch = m.sm.getBranch() as unknown as any[];
		const activeUserId = [...activeBranch]
			.reverse()
			.find((entry) => entry?.type === "message" && entry?.message?.role === "user")?.id ?? "";
		const userMessages: Array<{ entryId: string; ts: number; text: string; depth: number; label?: string }> = [];
		const walk = (nodes: Array<{ entry: any; children: any[]; label?: string }>, depth: number) => {
			for (const node of nodes) {
				const entry = node.entry;
				if (entry?.type === "message" && entry?.message?.role === "user" && entry.id) {
					const parsedTimestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number(entry.timestamp);
					userMessages.push({
						entryId: String(entry.id),
						ts: Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0,
						text: messageText(entry.message.content).replace(/\s+/g, " ").slice(0, 160),
						depth,
						label: node.label || undefined,
					});
				}
				walk(node.children ?? [], depth + 1);
			}
		};
		walk(m.sm.getTree() as unknown as Array<{ entry: any; children: any[]; label?: string }>, 0);
		return NextResponse.json({ success: true, data: { userMessages, activeUserId } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
