/**
 * growth-tree：项目树的纯函数（服务端 / 浏览器 / 测试共用）。
 * 文件清单 + 变更清单 → 目录树；目录树 + 展开集合 → 可见行列表。
 */
import type { GrowthChange } from "./types";

/** 不进快照的目录（影子仓库 info/exclude 与项目树的懒加载目录共用；浏览器可导入） */
export const GROWTH_EXCLUDE_DIRS = [
	"node_modules", ".git", ".next", ".next-dev", ".next-dev-webpack", ".next-dev-clean", "dist", "build", "out",
	".venv", "venv", "__pycache__", ".cache", "target", ".turbo", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".idea",
	".pnpm", ".pnpm-store", ".npm", ".yarn", ".gradle", ".tox", ".nox", ".uv", ".pixi", ".conda",
	".svelte-kit", ".nuxt", ".output", ".parcel-cache", ".angular", ".expo", ".dart_tool", ".terraform", ".serverless", ".aws-sam", "coverage", "htmlcov",
];

export type NodeStatus = "A" | "M" | "D" | "R";

export interface TreeNode {
	/** 相对工作区的路径（"/" 分隔），根为 "" */
	path: string;
	name: string;
	kind: "dir" | "file";
	size?: number;
	/** 文件：相对所选范围的状态 */
	status?: NodeStatus;
	from?: string;
	add?: number;
	del?: number;
	binary?: boolean;
	/** 改盘类工具运行期间目录监听刚看到、还没进快照的路径 */
	pending?: boolean;
	/** 快照之外的目录（node_modules 等）：展开时才通过文件接口临时列出 */
	lazy?: boolean;
	children?: TreeNode[];
	/** 目录：子树里各状态的文件数 */
	counts?: { added: number; modified: number; deleted: number; renamed: number; pending: number };
}

export interface FlatRow {
	node: TreeNode;
	depth: number;
	expanded: boolean;
}

/** 目录与历史文件可以同路径共存（如 p → p/child）；状态变化不改变节点身份。 */
export function treeNodeKey(node: Pick<TreeNode, "kind" | "path">): string {
	return `${node.kind}:${node.path}`;
}

export function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** 一条路径的全部祖先目录（不含自身、不含根） */
export function ancestorsOf(path: string): string[] {
	const out: string[] = [];
	let p = parentOf(path);
	while (p) {
		out.push(p);
		p = parentOf(p);
	}
	return out.reverse();
}

function compareNodes(a: TreeNode, b: TreeNode): number {
	if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function emptyCounts(): NonNullable<TreeNode["counts"]> {
	return { added: 0, modified: 0, deleted: 0, renamed: 0, pending: 0 };
}

/**
 * 文件清单（所选步的 tree）+ 变更（相对上一步或会话基线）+ 生成中路径 + 懒加载目录名 → 目录树。
 * 被删的文件不在清单里，从变更里补成 D 节点。
 */
export function buildTree(
	files: { path: string; size?: number }[],
	changes: GrowthChange[],
	pending: string[] = [],
	lazyDirs: string[] = [],
): TreeNode {
	const root: TreeNode = { path: "", name: "", kind: "dir", children: [], counts: emptyCounts() };
	const dirs = new Map<string, TreeNode>([["", root]]);
	const ensureDir = (path: string): TreeNode => {
		const found = dirs.get(path);
		if (found) return found;
		const parent = ensureDir(parentOf(path));
		const node: TreeNode = { path, name: path.slice(path.lastIndexOf("/") + 1), kind: "dir", children: [], counts: emptyCounts() };
		parent.children!.push(node);
		dirs.set(path, node);
		return node;
	};
	const fileNodes = new Map<string, TreeNode>();
	const addFile = (path: string, size?: number): TreeNode => {
		const existing = fileNodes.get(path);
		if (existing) return existing;
		const parent = ensureDir(parentOf(path));
		const node: TreeNode = { path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", size };
		parent.children!.push(node);
		fileNodes.set(path, node);
		return node;
	};
	for (const f of files) addFile(f.path, f.size);
	for (const c of changes) {
		const node = addFile(c.path);
		node.status = c.status;
		if (c.from) node.from = c.from;
		if (c.add !== undefined) node.add = c.add;
		if (c.del !== undefined) node.del = c.del;
		if (c.binary) node.binary = true;
	}
	for (const p of pending) {
		const isDir = /[/\\]$/.test(p);
		const rel = p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (!rel) continue;
		// 目录事件保留尾斜杠；被删路径无法 stat 时暂按文件处理，下一张快照会修正。
			const existing = isDir ? dirs.get(rel) : fileNodes.get(rel) ?? dirs.get(rel);
		if (existing) existing.pending = true;
		else if (isDir) ensureDir(rel).pending = true;
		else addFile(rel).pending = true;
	}
	for (const d of lazyDirs) {
		if (dirs.has(d)) continue;
		const node = ensureDir(d);
		node.lazy = true;
	}
	const finalize = (node: TreeNode): NonNullable<TreeNode["counts"]> => {
		const counts = emptyCounts();
		for (const child of node.children ?? []) {
			if (child.kind === "dir") {
				const c = finalize(child);
				if (child.pending && !c.pending) counts.pending += 1;
				counts.added += c.added;
				counts.modified += c.modified;
				counts.deleted += c.deleted;
				counts.renamed += c.renamed;
				counts.pending += c.pending;
			} else {
				if (child.status === "A") counts.added += 1;
				else if (child.status === "M") counts.modified += 1;
				else if (child.status === "D") counts.deleted += 1;
				else if (child.status === "R") counts.renamed += 1;
				if (child.pending) counts.pending += 1;
			}
		}
		node.children!.sort(compareNodes);
		node.counts = counts;
		return counts;
	};
	finalize(root);
	return root;
}

export function hasChanges(node: TreeNode): boolean {
	if (node.kind === "file") return Boolean(node.status || node.pending);
	const c = node.counts;
	return Boolean(node.pending || (c && (c.added || c.modified || c.deleted || c.renamed || c.pending)));
}

/**
 * 可见行：按展开集合深度优先展开；filter 非空时按名字子串匹配并把命中路径上的目录全部展开；
 * onlyChanges 只保留有变化的文件与包含变化的目录。
 */
export function flattenTree(root: TreeNode, expanded: Set<string>, opts: { onlyChanges?: boolean; filter?: string } = {}): FlatRow[] {
	const needle = (opts.filter ?? "").trim().toLowerCase();
	const out: FlatRow[] = [];
	const matches = (node: TreeNode): boolean => {
		if (opts.onlyChanges && !hasChanges(node)) return false;
		if (!needle) return true;
		if (node.kind === "file") return node.name.toLowerCase().includes(needle);
		return (node.children ?? []).some(matches);
	};
	const walk = (node: TreeNode, depth: number) => {
		for (const child of node.children ?? []) {
			if (!matches(child)) continue;
			const isOpen = child.kind === "dir" && (needle ? true : expanded.has(child.path));
			out.push({ node: child, depth, expanded: isOpen });
			if (isOpen) walk(child, depth + 1);
		}
	};
	walk(root, 0);
	return out;
}

/** 全部目录路径（展开全部用） */
export function allDirPaths(root: TreeNode): string[] {
	const out: string[] = [];
	const walk = (node: TreeNode) => {
		for (const child of node.children ?? []) {
			if (child.kind !== "dir") continue;
			out.push(child.path);
			walk(child);
		}
	};
	walk(root);
	return out;
}

/** 变更路径的祖先目录集合（新步到来时自动展开用） */
export function dirsToReveal(changes: GrowthChange[], pending: string[] = []): string[] {
	const set = new Set<string>();
	for (const c of changes) for (const d of ancestorsOf(c.path)) set.add(d);
	for (const p of pending) for (const d of ancestorsOf(p.replace(/\\/g, "/"))) set.add(d);
	return [...set];
}

/** 简易模糊匹配：按顺序命中每个字符，返回打分（越大越好）；不匹配返回 -1 */
export function fuzzyScore(query: string, candidate: string): number {
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();
	if (!q) return 0;
	const idx = c.indexOf(q);
	if (idx >= 0) return 1000 - idx - (c.length - q.length) * 0.01;
	let score = 0;
	let pos = 0;
	let last = -2;
	for (const ch of q) {
		const i = c.indexOf(ch, pos);
		if (i < 0) return -1;
		score += i === last + 1 ? 5 : 1;
		if (i === 0 || c[i - 1] === "/" || c[i - 1] === "." || c[i - 1] === "-" || c[i - 1] === "_") score += 3;
		last = i;
		pos = i + 1;
	}
	return score - c.length * 0.01;
}

/** 把当前磁盘目录的懒加载结果并入快照树，保留快照里的状态和已删除文件。 */
export function graftLazy(root: TreeNode, lazyChildren: Map<string, TreeNode[]>): TreeNode {
	if (!lazyChildren.size) return root;
	const graft = (node: TreeNode): TreeNode => {
		if (node.kind !== "dir") return node;
		const children = new Map((node.children ?? []).map((child) => [treeNodeKey(child), graft(child)]));
		for (const live of lazyChildren.get(node.path) ?? []) {
			const key = treeNodeKey(live);
			const existing = children.get(key);
			if (!existing) children.set(key, graft(live));
			else if (existing.kind === "dir") children.set(key, { ...existing, lazy: true });
		}
		return { ...node, children: [...children.values()].sort(compareNodes) };
	};
	return graft(root);
}
