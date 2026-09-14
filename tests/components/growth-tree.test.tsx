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
