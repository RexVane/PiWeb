import { describe, expect, it } from "vitest";
import { allDirPaths, ancestorsOf, buildTree, dirsToReveal, flattenTree, fuzzyScore, graftLazy, treeNodeKey, type TreeNode } from "../src/lib/growth-tree";

describe("growth-tree", () => {
	const files = [
		{ path: "src/app/page.tsx", size: 10 },
		{ path: "src/lib/util.ts", size: 20 },
		{ path: "README.md", size: 5 },
		{ path: "src/lib/new.ts", size: 3 },
	];
	const changes = [
		{ status: "A" as const, path: "src/lib/new.ts", add: 3, del: 0 },
		{ status: "M" as const, path: "src/app/page.tsx", add: 2, del: 1 },
		{ status: "D" as const, path: "src/old.ts", add: 0, del: 9 },
	];

	it("builds directories, keeps deleted files, sorts dirs first", () => {
		const root = buildTree(files, changes);
		expect(root.children!.map((n) => n.name)).toEqual(["src", "README.md"]);
		const src = root.children![0];
		expect(src.children!.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:app", "dir:lib", "file:old.ts"]);
		expect(src.counts).toEqual({ added: 1, modified: 1, deleted: 1, renamed: 0, pending: 0 });
		const old = src.children![2];
		expect(old.status).toBe("D");
		expect(old.del).toBe(9);
	});

	it("marks pending paths and lazy dirs", () => {
		const root = buildTree(files, [], ["src/lib/gen.ts", "src/lib"], ["node_modules"]);
		const src = root.children!.find((n) => n.name === "src")!;
		const lib = src.children!.find((n) => n.name === "lib")!;
		expect(lib.pending).toBe(true);
		expect(lib.children!.find((n) => n.name === "gen.ts")?.pending).toBe(true);
		expect(root.children!.find((n) => n.name === "node_modules")?.lazy).toBe(true);
		expect(src.counts?.pending).toBe(1);
	});

	it("shows new empty directories while a tool is running", () => {
		const root = buildTree([], [], ["src/generated/"]);
		const rows = flattenTree(root, new Set(["src"]), { onlyChanges: true });
		expect(rows.map((row) => row.node.path)).toEqual(["src", "src/generated"]);
		expect(rows[1].node).toMatchObject({ kind: "dir", pending: true });
		expect(root.counts?.pending).toBe(1);
	});

	it("flattens by expanded set, filter expands matches, onlyChanges prunes", () => {
		const root = buildTree(files, changes);
		const collapsed = flattenTree(root, new Set());
		expect(collapsed.map((r) => r.node.path)).toEqual(["src", "README.md"]);
		const open = flattenTree(root, new Set(["src", "src/lib"]));
		expect(open.map((r) => `${r.depth}:${r.node.name}`)).toEqual(["0:src", "1:app", "1:lib", "2:new.ts", "2:util.ts", "1:old.ts", "0:README.md"]);
		const filtered = flattenTree(root, new Set(), { filter: "new" });
		expect(filtered.map((r) => r.node.path)).toEqual(["src", "src/lib", "src/lib/new.ts"]);
		const only = flattenTree(root, new Set(["src", "src/app", "src/lib"]), { onlyChanges: true });
		expect(only.map((r) => r.node.path)).toEqual(["src", "src/app", "src/app/page.tsx", "src/lib", "src/lib/new.ts", "src/old.ts"]);
	});

	it("helpers", () => {
		expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
		expect(dirsToReveal(changes).sort()).toEqual(["src", "src/app", "src/lib"]);
		expect(allDirPaths(buildTree(files, changes)).sort()).toEqual(["src", "src/app", "src/lib"]);
		expect(fuzzyScore("pgtsx", "src/app/page.tsx")).toBeGreaterThan(0);
		expect(fuzzyScore("zzz", "src/app/page.tsx")).toBe(-1);
		expect(fuzzyScore("page", "src/app/page.tsx")).toBeGreaterThan(fuzzyScore("pge", "src/app/page.tsx"));
	});

	it("keeps directory subtrees and deleted files with the same path through lazy grafts", () => {
		const root = buildTree([{ path: "p/child.txt" }], [
			{ path: "p", status: "D" }, { path: "p/child.txt", status: "A" },
		], ["p/"]);
		const merged = graftLazy(root, new Map([["", [{ path: "p", name: "p", kind: "dir", lazy: true, children: [] }]]]));
		const rows = flattenTree(merged, new Set(["p"]), { onlyChanges: true });
		expect(rows.map(({ node }) => treeNodeKey(node))).toEqual(["dir:p", "file:p/child.txt", "file:p"]);
		expect(rows[0]).toMatchObject({ expanded: true, node: { pending: true, counts: { added: 1, deleted: 0 } } });
		expect(rows[2]).toMatchObject({ expanded: false, node: { status: "D" } });
		expect(rows[2].node.pending).toBeUndefined();
		expect(merged.counts).toMatchObject({ added: 1, deleted: 1, pending: 1 });
		expect(root.children).toHaveLength(2);
		expect(treeNodeKey({ path: "p", kind: "file" })).not.toBe(treeNodeKey({ path: "p", kind: "dir" }));
	});

	it("retains deleted descendants when a directory is replaced by a live file", () => {
		const root = buildTree([{ path: "p" }], [{ path: "p", status: "A" }, { path: "p/old.txt", status: "D" }]);
		const merged = graftLazy(root, new Map([["", [{ path: "p", name: "p", kind: "file", lazy: true }]]]));
		const rows = flattenTree(merged, new Set(["p"]));
		expect(rows.map(({ node }) => treeNodeKey(node))).toEqual(["dir:p", "file:p/old.txt", "file:p"]);
		expect(rows[1].node.status).toBe("D");
		expect(rows[2].node.status).toBe("A");
		expect(merged.counts).toMatchObject({ added: 1, deleted: 1 });
	});

	it("merges live disk entries without replacing snapshot files or deletions", () => {
		const root = buildTree(files, changes);
		const liveDir: TreeNode = { path: "src", name: "src", kind: "dir", lazy: true, children: [] };
		const liveFile: TreeNode = { path: "LICENSE", name: "LICENSE", kind: "file", lazy: true };
		const ignoredFile: TreeNode = { path: "src/.env", name: ".env", kind: "file", lazy: true };
		const merged = graftLazy(root, new Map([["", [liveDir, liveFile]], ["src", [ignoredFile]]]));
		const src = merged.children!.find((node) => node.path === "src")!;
		expect(merged.children!.map((node) => node.path)).toEqual(["src", "LICENSE", "README.md"]);
		expect(src.lazy).toBe(true);
		expect(src.children!.some((node) => node.path === "src/old.ts" && node.status === "D")).toBe(true);
		expect(src.children!.some((node) => node.path === "src/.env" && node.lazy)).toBe(true);
		expect(merged.children!.find((node) => node.path === "README.md")?.lazy).toBeUndefined();
	});
});
