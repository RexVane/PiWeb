/**
 * 会话树 → 分支视图用的列表。
 *
 * pi 的会话是一棵只追加的树：编辑重发、/tree 回到某一步再提问，都会从那个位置长出新分支，
 * 旧分支留在文件里。这里只取用户提问（每一问是一个可以回去的位置），按深度优先排成一列；
 * 直线对话保持平铺，只有分叉的地方才缩进一层。
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { promptTitleText } from "./chat/skill-expansion";

export interface SessionTreeNode {
	/** 用户消息的条目 ID */
	entryId: string;
	ts: number;
	/** 提问首段（技能展开还原成 `/skill:name 参数`） */
	text: string;
	/** 缩进层数：只在分叉处加一层 */
	indent: number;
	/** 一条分支的起点：它和别的提问接在同一个位置后面（界面在这里画分叉记号，区分相邻的两条分支） */
	forked: boolean;
	/** 在当前分支上 */
	active: boolean;
	/** 当前分支上的最后一问 */
	current: boolean;
	/** 这一问自己的标签 */
	label?: string;
	/** 这一问之后、下一问之前的条目（回答、工具结果）上的标签 */
	otherLabels?: string[];
	/** 这一问之下最新的那片叶子：切到这条分支 = 把会话的叶子挪到这里 */
	leafId: string;
	/** 这一问之后分出去的后续提问数（> 1 就是分叉点） */
	branches: number;
}

export interface SessionTree {
	nodes: SessionTreeNode[];
	/** 会话当前的叶子 */
	leafId: string | null;
	/** 提问太多时只返回前面这些 */
	truncated: boolean;
}

/** 一次最多返回的提问数：再多的会话也不该把几万行塞进抽屉 */
export const SESSION_TREE_MAX_NODES = 2_000;
const TEXT_MAX_CHARS = 160;

interface RawEntry {
	id?: unknown;
	parentId?: unknown;
	type?: unknown;
	timestamp?: unknown;
	message?: { role?: unknown; content?: unknown; timestamp?: unknown };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : ""))
		.join(" ");
}

function timeOf(entry: RawEntry): number {
	const own = typeof entry.message?.timestamp === "number" ? entry.message.timestamp : NaN;
	if (Number.isFinite(own)) return own;
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function buildSessionTree(sm: Pick<SessionManager, "getEntries" | "getBranch" | "getLeafId" | "getLabel">): SessionTree {
	const entries = (sm.getEntries() as unknown as RawEntry[]).filter((entry): entry is RawEntry & { id: string } => typeof entry?.id === "string");
	const indexOf = new Map(entries.map((entry, index) => [entry.id, index]));
	const parentOf = entries.map((entry) => (typeof entry.parentId === "string" ? indexOf.get(entry.parentId) ?? -1 : -1));
	const isUser = (entry: RawEntry) => entry.type === "message" && entry.message?.role === "user";

	// 每个条目之下最新的叶子。会话只追加，子条目一定排在父条目后面，所以倒着走一遍就够：
	// 走到某条时它的子条目都已处理过，还没被子条目填过的就是叶子。
	const latestLeaf = new Array<number>(entries.length).fill(-1);
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (latestLeaf[i] < 0) latestLeaf[i] = i;
		const parent = parentOf[i];
		if (parent >= 0 && latestLeaf[i] > latestLeaf[parent]) latestLeaf[parent] = latestLeaf[i];
	}

	// 最近的用户提问祖先（-1 = 上面没有提问），以及只含提问的那棵「缩减树」
	const userAncestor = new Array<number>(entries.length).fill(-1);
	const followUps = new Map<number, number[]>();
	const otherLabels = new Map<number, string[]>();
	for (let i = 0; i < entries.length; i += 1) {
		const parent = parentOf[i];
		if (parent >= 0) userAncestor[i] = isUser(entries[parent]) ? parent : userAncestor[parent];
		if (isUser(entries[i])) {
			const siblings = followUps.get(userAncestor[i]);
			if (siblings) siblings.push(i);
			else followUps.set(userAncestor[i], [i]);
			continue;
		}
		// 回答 / 工具结果上的标签记在它所属的那一问上
		const label = userAncestor[i] >= 0 ? sm.getLabel(entries[i].id) : undefined;
		if (label) {
			const labels = otherLabels.get(userAncestor[i]);
			if (labels) labels.push(label);
			else otherLabels.set(userAncestor[i], [label]);
		}
	}

	const branch = sm.getBranch() as unknown as RawEntry[];
	const active = new Set(branch.map((entry) => entry.id));
	const currentId = [...branch].reverse().find(isUser)?.id;

	// 深度优先，用显式栈：会话可以有几千层深，递归会爆栈
	const nodes: SessionTreeNode[] = [];
	const stack: Array<{ index: number; indent: number; forked: boolean }> = [];
	/** 同一个位置后面接了不止一问 = 分叉：每一支缩进一层；直线往下不缩进 */
	const pushAll = (indexes: number[], indent: number) => {
		const forked = indexes.length > 1;
		for (let k = indexes.length - 1; k >= 0; k -= 1) stack.push({ index: indexes[k], indent: indent + (forked ? 1 : 0), forked });
	};
	// 最上面那一层没有父提问，不为它多缩进一层（只标出分叉）
	const roots = followUps.get(-1) ?? [];
	for (let k = roots.length - 1; k >= 0; k -= 1) stack.push({ index: roots[k], indent: 0, forked: roots.length > 1 });
	let truncated = false;
	while (stack.length > 0) {
		const { index, indent, forked } = stack.pop()!;
		if (nodes.length >= SESSION_TREE_MAX_NODES) {
			truncated = true;
			break;
		}
		const entry = entries[index];
		const next = followUps.get(index) ?? [];
		const label = sm.getLabel(entry.id);
		const others = otherLabels.get(index);
		nodes.push({
			entryId: entry.id,
			ts: timeOf(entry),
			text: promptTitleText(textOf(entry.message?.content)).replace(/\s+/g, " ").trim().slice(0, TEXT_MAX_CHARS),
			indent,
			forked,
			active: active.has(entry.id),
			current: entry.id === currentId,
			...(label ? { label } : {}),
			...(others?.length ? { otherLabels: others } : {}),
			leafId: entries[latestLeaf[index]].id,
			branches: next.length,
		});
		pushAll(next, indent);
	}
	return { nodes, leafId: sm.getLeafId() ?? null, truncated };
}
