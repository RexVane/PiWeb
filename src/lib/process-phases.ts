/**
 * 对话过程阶段模型：工具嵌套树、网络来源归集、意图摘要与流式接力收束。
 * 纯函数实现，无 React/DOM 依赖，便于单元测试。
 */
import type { ToolCardState } from "@/hooks/usePiWeb";
import { isCancelledTool } from "@/lib/chat/cancellation";
import type { ViewedImagePreview } from "@/lib/chat/tool-images";
import type { CommandIntentCategory } from "@/lib/process-format";
import { basename, describeCommandIntent, skillNameFromRead, toolKind } from "@/lib/process-format";
import type { WebContent } from "@/lib/types";
import { classifyWebTool, extractWebSources, mergeWebSources, type WebSource, type WebToolRole } from "@/lib/web-search";

export type ToolCallContent = Extract<WebContent, { type: "toolCall" }>;

export type ToolNode = { id: string; state: ToolCardState; children: ToolNode[] };

export type ProcessItem =
	| { kind: "think"; key: string; msgIndex: number; text: string; live: boolean; startedAt?: number }
	| { kind: "narr"; key: string; msgIndex: number; text: string; live: boolean; error: boolean }
	| { kind: "image"; key: string; msgIndex: number; data: string; mimeType: string; url?: string }
	| { kind: "viewedImages"; key: string; msgIndex: number; images: ViewedImagePreview[] }
	| { kind: "tool"; key: string; msgIndex: number; call: ToolCallContent; state?: ToolCardState; nested?: ToolNode[]; badge?: string }
	| { kind: "custom"; key: string; msgIndex: number; customType: string; text: string }
	| { kind: "error"; key: string; msgIndex: number; message: string; count: number }
	| { kind: "abort"; key: string; msgIndex: number };

export type ProcessRun = {
	kind: "run";
	key: string;
	items: ProcessItem[];
	hasThink: boolean;
	thinks: number;
	cmds: number;
	reads: number;
	searches: number;
	writes: number;
	editedOnly: boolean;
	writeAdd: number;
	writeDel: number;
	writtenFiles: string[];
	webSearches: number;
	webFetches: number;
	webSources: WebSource[];
	intentCategories: CommandIntentCategory[];
	intentTargets: Array<{ category: CommandIntentCategory; target: string }>;
	durationMs?: number;
};

export type ProcessBlock = { kind: "item"; item: ProcessItem } | ProcessRun;

export const EMPTY_WEB_SOURCES: WebSource[] = [];
const NESTED_MAX_DEPTH = 4;
const NO_NESTED: ToolNode[] = [];

/** 流式无分段兜底阈值：超过该步数时把更早步数折进摘要行，底部保留当前活跃尾巴 */
export const LIVE_FRONTIER_MAX_ITEMS = 5;
export const LIVE_FRONTIER_KEEP_TAIL = 3;

export function nestedNodes(tools: Record<string, ToolCardState>, parentId: string, depth = 0): ToolNode[] {
	const ids = tools[parentId]?.children;
	if (!ids?.length || depth >= NESTED_MAX_DEPTH) return NO_NESTED;
	const out: ToolNode[] = [];
	for (const id of ids) {
		const state = tools[id];
		if (state) out.push({ id, state, children: nestedNodes(tools, id, depth + 1) });
	}
	return out;
}

export function nestedHasWebTool(nodes: ToolNode[] | undefined): boolean {
	if (!nodes?.length) return false;
	for (const node of nodes) {
		const out = node.state.result ?? node.state.partialResult;
		if (classifyWebTool(node.state.name, node.state.args, out) !== null) return true;
		if (nestedHasWebTool(node.children)) return true;
	}
	return false;
}

export function collectToolWebData(
	name: string,
	args: unknown,
	state: ToolCardState | undefined,
	nested: ToolNode[] | undefined,
): { hasWeb: boolean; role: WebToolRole | null; sources: WebSource[] } {
	const output = state?.result ?? state?.partialResult ?? "";
	const role = classifyWebTool(name, args, output);
	const childLists: WebSource[][] = [];
	let hasWeb = role !== null;
	if (nested?.length) {
		const stack = [...nested];
		while (stack.length > 0) {
			const node = stack.shift()!;
			const sub = collectToolWebData(node.state.name, node.state.args, node.state, node.children);
			if (sub.hasWeb) hasWeb = true;
			if (sub.sources.length > 0) childLists.push(sub.sources);
		}
	}
	if (!hasWeb) return { hasWeb: false, role: null, sources: EMPTY_WEB_SOURCES };
	const ownSources = extractWebSources(args, output, role);
	const sources = childLists.length > 0 ? mergeWebSources([...childLists, ownSources]) : ownSources;
	return { hasWeb: true, role, sources };
}

export function itemWebInfo(item: ProcessItem): { hasWeb: boolean; role: WebToolRole | null; sources: WebSource[] } {
	if (item.kind !== "tool") return { hasWeb: false, role: null, sources: EMPTY_WEB_SOURCES };
	return collectToolWebData(item.call.name, item.call.arguments, item.state, item.nested);
}

/** 可折进阶段摘要的步骤：已完成的思考，以及成功结束的命令 / 读取 / 搜索 / 联网（编辑、失败与已中止步外露展示） */
export function isCollapsibleProcessItem(item: ProcessItem): boolean {
	if (item.kind === "think") return !item.live;
	if (item.kind === "tool") {
		if (item.badge) return false;
		const s = item.state;
		if (!s || s.state !== "done" || s.isError || s.images?.length) return false;
		const raw = s.result ?? s.partialResult ?? "";
		if (isCancelledTool(s.name, s.isError, raw)) return false;
		const k = toolKind(item.call.name);
		if (k === "read" && skillNameFromRead(item.call.name, item.call.arguments)) return false;
		if (k === "cmd" || k === "read" || k === "search") return true;
		return classifyWebTool(item.call.name, item.call.arguments, raw) !== null || nestedHasWebTool(item.nested);
	}
	return false;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function rawCommandOf(args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	return str(a.command) ?? str(a.cmd) ?? str(a.script) ?? "";
}

function writeTargetOf(args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const raw = str(a.path) ?? str(a.file_path) ?? "";
	return raw ? basename(raw) : "";
}

function toolDiffCounts(name: string, args: unknown, state: ToolCardState | undefined): { add: number; del: number } {
	if (!state || state.state !== "done") return { add: 0, del: 0 };
	const raw = (state.patch || state.result || state.partialResult || "").replace(/\r\n/g, "\n");
	if (raw) {
		let add = 0;
		let del = 0;
		let oldLeft = 0;
		let newLeft = 0;
		let inHunk = false;
		for (const line of raw.split("\n")) {
			const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (hunk) {
				oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
				newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
				inHunk = oldLeft > 0 || newLeft > 0;
				continue;
			}
			if (!inHunk) continue;
			if (line.startsWith("+") && newLeft > 0) { add += 1; newLeft -= 1; }
			else if (line.startsWith("-") && oldLeft > 0) { del += 1; oldLeft -= 1; }
			else if (line.startsWith(" ")) { oldLeft = Math.max(0, oldLeft - 1); newLeft = Math.max(0, newLeft - 1); }
			if (oldLeft === 0 && newLeft === 0) inHunk = false;
		}
		if (add > 0 || del > 0) return { add, del };
	}
	if (name.toLowerCase() === "write") {
		const content = str((args as { content?: unknown } | undefined)?.content);
		if (content) return { add: content.replace(/\r/g, "").replace(/\n$/, "").split("\n").length, del: 0 };
	}
	return { add: 0, del: 0 };
}

function summarizeTargetToken(category: CommandIntentCategory, rawTarget: string): string {
	const t = rawTarget.trim();
	if (!t) return "";
	if (category === "code_search") {
		const [first, second] = t.split(" · ");
		const pick = (first && !/[\\/*]/.test(first) ? first : "") || second || first || "";
		const out = pick.includes("/") ? basename(pick) : pick;
		return out === "Temp" || out === "." ? "" : out;
	}
	if (category === "dir_list" || category === "file_read") {
		const first = t.split(" · ")[0]?.trim() ?? "";
		if (!first || first === "Temp" || first === ".") return "";
		return first.includes("/") ? basename(first) : first;
	}
	return t.includes("/") ? basename(t) : t;
}

function buildRun(
	slice: ProcessItem[],
	spanOf: (a: number, b: number) => number | undefined,
	cwd?: string,
): ProcessBlock[] {
	let cmds = 0;
	let reads = 0;
	let searches = 0;
	let writes = 0;
	let hasCreateWrite = false;
	let writeAdd = 0;
	let writeDel = 0;
	let webSearches = 0;
	let webFetches = 0;
	let hasThink = false;
	let thinks = 0;
	const sourceBatches: WebSource[][] = [];
	const intentSet = new Set<CommandIntentCategory>();
	const intentTargets: Array<{ category: CommandIntentCategory; target: string }> = [];
	const seenIntentTarget = new Set<string>();
	const writtenFiles: string[] = [];
	const seenWriteFile = new Set<string>();

	for (const item of slice) {
		if (item.kind === "think") {
			hasThink = true;
			thinks += 1;
		} else if (item.kind === "tool") {
			const web = itemWebInfo(item);
			if (web.sources.length > 0) sourceBatches.push(web.sources);
			if (web.role === "search") {
				webSearches += 1;
			} else if (web.role === "fetch") {
				webFetches += 1;
			} else if (web.hasWeb) {
				webSearches += 1;
			} else {
				const k = toolKind(item.call.name);
				if (k === "cmd") {
					cmds += 1;
					const intent = describeCommandIntent(rawCommandOf(item.call.arguments), cwd);
					if (intent) {
						intentSet.add(intent.category);
						if (intent.target) {
							const cleanTarget = summarizeTargetToken(intent.category, intent.target);
							const dedupeKey = `${intent.category}:${cleanTarget}`;
							if (cleanTarget && !seenIntentTarget.has(dedupeKey)) {
								seenIntentTarget.add(dedupeKey);
								intentTargets.push({ category: intent.category, target: cleanTarget });
							}
						}
					}
				} else if (k === "write") {
					writes += 1;
					if (item.call.name.toLowerCase() === "write") hasCreateWrite = true;
					const file = writeTargetOf(item.call.arguments);
					if (file && !seenWriteFile.has(file)) {
						seenWriteFile.add(file);
						writtenFiles.push(file);
					}
					const counts = toolDiffCounts(item.call.name, item.call.arguments, item.state);
					writeAdd += counts.add;
					writeDel += counts.del;
				} else if (k === "read") {
					reads += 1;
				} else {
					searches += 1;
				}
			}
		}
	}

	const durationMs = spanOf(slice[0].msgIndex, slice[slice.length - 1].msgIndex);
	const webSources = sourceBatches.length > 0 ? mergeWebSources(sourceBatches) : EMPTY_WEB_SOURCES;
	const totalTools = cmds + reads + searches + writes + webSearches + webFetches;

	// 单条独立的联网步骤直接原位展示，避免多包一层折叠
	if (slice.length === 1 && !hasThink && cmds + reads + searches + writes === 0 && webSearches + webFetches === 1) {
		return [{ kind: "item", item: slice[0] }];
	}
	if (totalTools === 0 && durationMs === undefined) {
		return slice.map((item) => ({ kind: "item", item }));
	}
	return [
		{
			kind: "run",
			key: `run-${slice[0].key}`,
			items: slice,
			hasThink,
			thinks,
			cmds,
			reads,
			searches,
			writes,
			editedOnly: writes > 0 && !hasCreateWrite,
			writeAdd,
			writeDel,
			writtenFiles,
			webSearches,
			webFetches,
			webSources,
			intentCategories: [...intentSet],
			intentTargets,
			durationMs,
		},
	];
}

function isPhaseBoundary(item: ProcessItem): boolean {
	if (item.kind === "narr" || item.kind === "custom" || item.kind === "error" || item.kind === "abort" || item.kind === "viewedImages" || item.kind === "image") {
		return true;
	}
	if (item.kind === "tool") {
		if (item.badge) return true;
		const k = toolKind(item.call.name);
		if (k === "read" && skillNameFromRead(item.call.name, item.call.arguments)) return true;
	}
	return false;
}

function hasPhaseBoundaryAfter(items: ProcessItem[], fromIndex: number): boolean {
	for (let k = fromIndex; k < items.length; k += 1) {
		if (isPhaseBoundary(items[k])) return true;
	}
	return false;
}

/**
 * 构建过程渲染块：
 * - 回合结束后（turnLive=false）：叙述或特殊边界之间所有连续可折叠步骤合并为 1 条摘要行，展开后保持原有时序；
 * - 流式运行中（turnLive=true）：遵循「运行中展开，完成一组立即收回，继续下一组」接力模型；
 *   当前进行中的阶段保持展开；一旦出现后续阶段边界，前面这组自动收回；
 *   若当前无分段连续超过 LIVE_FRONTIER_MAX_ITEMS，则把更早步数折入 1 条摘要前缀，保留尾部展开。
 */
export function buildProcessBlocks(
	items: ProcessItem[],
	spanOf: (a: number, b: number) => number | undefined,
	options: { turnLive: boolean; cwd?: string } = { turnLive: false },
): ProcessBlock[] {
	const blocks: ProcessBlock[] = [];
	let i = 0;
	while (i < items.length) {
		if (!isCollapsibleProcessItem(items[i])) {
			blocks.push({ kind: "item", item: items[i] });
			i += 1;
			continue;
		}
		let j = i;
		while (j < items.length && isCollapsibleProcessItem(items[j])) j += 1;
		const slice = items.slice(i, j);
		const isActivePhase = !hasPhaseBoundaryAfter(items, j);

		if (!options.turnLive || !isActivePhase) {
			blocks.push(...buildRun(slice, spanOf, options.cwd));
		} else if (slice.length <= LIVE_FRONTIER_MAX_ITEMS) {
			for (const item of slice) blocks.push({ kind: "item", item });
		} else {
			const splitAt = slice.length - LIVE_FRONTIER_KEEP_TAIL;
			blocks.push(...buildRun(slice.slice(0, splitAt), spanOf, options.cwd));
			for (const item of slice.slice(splitAt)) blocks.push({ kind: "item", item });
		}
		i = j;
	}
	return blocks;
}
