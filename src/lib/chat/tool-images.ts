import type { ToolCardState } from "@/hooks/usePiWeb";
import type { WebContent, WebMessage } from "@/lib/types";

type ImageContent = Extract<WebContent, { type: "image" }>;
type ToolCallContent = Extract<WebContent, { type: "toolCall" }>;

export interface ViewedImagePreview {
	id: string;
	image: ImageContent;
	path?: string;
}

/** 以实际返回的图片计数，不根据扩展名猜测（失败/只返回文字的 read 不能算已查看）。 */
export function toolImagePreviews(id: string, args: unknown, state?: ToolCardState): ViewedImagePreview[] {
	if (!state || state.state !== "done" || state.isError) return [];
	const a = args as { path?: unknown; file_path?: unknown } | null;
	const path = a?.path ?? a?.file_path;
	return (state.images ?? []).map((image, index) => ({ id: `${id}/${index}`, image, path: typeof path === "string" ? path : undefined }));
}

// 历史消息身份稳定：复用恢复的工具对象，避免当前回合出 token 时反复重绘旧图集。
const restoredTools = new WeakMap<WebMessage, Map<string, { call: ToolCallContent; tool: ToolCardState }>>();

/** 实时工具缓存有条数上限；被淘汰的历史图片调用仍能从消息中的懒加载引用恢复。 */
export function imageToolsFromMessages(messages: readonly WebMessage[]): Record<string, ToolCardState> {
	const calls = new Map<string, ToolCallContent>();
	const tools = new Map<string, ToolCardState>();
	for (const message of messages) {
		let images: ImageContent[] | undefined;
		for (const part of message.content) {
			if (part.type === "toolCall") {
				calls.set(part.id, part);
				continue;
			}
			if (message.role !== "toolResult" || part.type !== "toolResult" || !part.toolCallId) continue;
			const call = calls.get(part.toolCallId);
			if (!call) continue;
			images ??= message.content.filter((content) => content.type === "image");
			if (!images.length) continue;
			let cache = restoredTools.get(message);
			if (!cache) restoredTools.set(message, cache = new Map());
			let restored = cache.get(part.toolCallId);
			if (!restored || restored.call !== call) {
				restored = { call, tool: {
					name: call.name, args: call.arguments, state: "done", result: part.text,
					images, isError: part.isError, encodingLoss: part.encodingLoss, patch: part.patch,
					endedAt: message.timestamp,
				} };
				cache.set(part.toolCallId, restored);
			}
			tools.set(part.toolCallId, restored.tool);
		}
	}
	return Object.fromEntries(tools);
}
