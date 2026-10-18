// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowthTree } from "@/components/GrowthTree";
import { buildTree, graftLazy } from "@/lib/growth-tree";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("GrowthTree type replacements", () => {
	it("renders and independently selects same-path directory and deleted file rows", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const open = vi.fn();
		const toggle = vi.fn();
		const tree = graftLazy(buildTree([{ path: "p/child.txt" }], [{ path: "p", status: "D" }, { path: "p/child.txt", status: "A" }]), new Map([["", []]]));
		render(<GrowthTree tree={tree} expanded={new Set(["p"])} selectedPath="p" onToggleDir={toggle} onOpenFile={open} />);
		const rows = screen.getAllByRole("treeitem");
		expect(rows).toHaveLength(3);
		expect(rows[0].textContent).toContain("p/");
		expect(rows[0].getAttribute("aria-expanded")).toBe("true");
		expect(rows[0].getAttribute("aria-selected")).toBe("false");
		expect(rows[2].getAttribute("aria-selected")).toBe("true");
		expect(rows[2].textContent).toMatch(/删除|Deleted/);
		fireEvent.click(rows[2]);
		expect(rows[0].getAttribute("data-focused")).toBeNull();
		expect(rows[2].getAttribute("data-focused")).toBe("true");
		fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
		expect(open).toHaveBeenCalledTimes(2);
		expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "file", path: "p", status: "D" }));
		expect(toggle).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowUp" });
		fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });
		expect(rows[0].getAttribute("data-focused")).toBe("true");
		expect(error.mock.calls.some((args) => args.some((value) => String(value).includes("same key")))).toBe(false);
	});
});

describe("GrowthTree row actions", () => {
	/**
	 * 回归：根目录总会被列出，快照里的目录只要磁盘上也有就被 graftLazy 标 lazy；
	 * 按钮原先按 lazy 隐藏，顶层目录的「打开文件夹 / @ 引用」就全没了。只有磁盘独有的节点不给按钮。
	 */
	it("keeps actions on snapshot dirs that the disk listing also contains, and hides them on disk-only rows", () => {
		const tree = graftLazy(
			buildTree([{ path: "src/a.ts" }], [{ path: "src/a.ts", status: "M" }]),
			new Map([["", [
				{ path: "src", name: "src", kind: "dir", lazy: true, children: [] },
				{ path: "docs", name: "docs", kind: "dir", lazy: true, children: [] },
				{ path: "README.md", name: "README.md", kind: "file", lazy: true },
			]]]),
		);
		render(<GrowthTree tree={tree} expanded={new Set()} onToggleDir={vi.fn()} onOpenFile={vi.fn()} onReference={vi.fn()} onOpenEditor={vi.fn()} />);
		const row = (name: string) => screen.getAllByRole("treeitem").find((item) => item.textContent?.startsWith(name))!;
		expect(row("src/").querySelector(".pw-tree-actions")).not.toBeNull();
		expect(row("docs/").querySelector(".pw-tree-actions")).toBeNull();
		expect(row("README.md").querySelector(".pw-tree-actions")).toBeNull();
	});
});
