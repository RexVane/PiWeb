// @vitest-environment jsdom
/** 真实 useGrowth → ProjectPanel → GrowthTree；仅替代网络边界，按可见目录状态验收。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPanel } from "@/components/ProjectPanel";
import { useGrowth } from "@/hooks/useGrowth";
import type { GrowthChange, GrowthRound } from "@/lib/types";

const h = (c: string) => c.repeat(40);
const files = ["src/app/changed.ts", "src/lib/untouched.ts", "docs/guide.md", "assets/logo.svg"].map((path) => ({ path, size: 1 }));
const oldChanges: GrowthChange[] = [{ status: "M", path: "docs/guide.md" }];
const latestChanges: GrowthChange[] = [{ status: "M", path: "src/app/changed.ts" }];
const makeRound = (id: string, changes: GrowthChange[]): GrowthRound => ({
	commit: h(id), parent: null, tree: h(id), parentTree: h("0"), ts: 1, kind: "round", title: id,
	session: "s.jsonl", promptIds: [], status: "done", changes,
	stats: { added: 0, modified: changes.length, deleted: 0, renamed: 0, add: 0, del: 0 },
});
const liveRounds: GrowthRound[] = [];
const noop = () => {};

function Harness({ cwd = "/tree", sessionPath = "/session.jsonl" }) {
	const growth = useGrowth({ cwd, sessionPath, liveRounds, active: true, connected: true });
	return <>
		<button onClick={growth.selectLatest}>重新打开项目</button>
		<button onClick={() => void growth.refresh()}>刷新项目</button>
		<button onClick={growth.expandAll}>展开全部</button>
		<button onClick={growth.collapseAll}>收起全部</button>
		<ProjectPanel growth={growth} cwd={cwd} workspaceName="tree" hasSession onOpenFile={noop} onClose={noop} onError={noop} />
	</>;
}

let rounds: GrowthRound[];
let refreshes: number;
let resolveTotal: ((value: Response) => void) | undefined;
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) }) as Response;
const row = (path: string) => screen.getAllByRole("treeitem").find((item) => item.getAttribute("title")?.split("\n")[0] === `${path}/`)!;
const showAll = () => fireEvent.click(screen.getByRole("button", { name: "只看改动" }));
const expectOpen = (path: string, open: boolean) => expect(row(path).getAttribute("aria-expanded")).toBe(String(open));

beforeEach(() => {
	localStorage.clear();
	rounds = [makeRound("1", oldChanges), makeRound("2", latestChanges)];
	refreshes = 0;
	resolveTotal = undefined;
	vi.stubGlobal("fetch", vi.fn(async (url: string) => {
		const u = new URL(url, "http://local");
		if (u.pathname === "/api/git") return response({ available: true, isRepo: true, files: [], commits: [], root: "/tree", branch: "main" });
		if (u.pathname === "/api/files") return response({ entries: [], nextOffset: null });
		if (u.searchParams.has("list")) return response({ files });
		if (u.searchParams.has("changes")) return new Promise<Response>((resolve) => { resolveTotal = resolve; });
		refreshes += 1;
		return response({ available: true, rounds: structuredClone(rounds) });
	}));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("project directory defaults", () => {
	it("ignores old expanded-all storage, opens changed ancestors and leaves unchanged siblings closed", async () => {
		localStorage.setItem("piweb.growth.expanded:/tree", JSON.stringify(["src", "src/app", "src/lib", "docs", "assets"]));
		render(<Harness />);
		await screen.findByText("changed.ts");
		showAll();
		expectOpen("src", true);
		expectOpen("src/app", true);
		expectOpen("src/lib", false);
		expectOpen("docs", false);
		expectOpen("assets", false);
		expect(screen.queryByText("untouched.ts")).toBeNull();
	});

	it("keeps every folder closed when the selected round has no changes", async () => {
		rounds = [makeRound("1", [])];
		localStorage.setItem("piweb.growth.expanded:/tree", '["src","src/app","docs"]');
		render(<Harness />);
		await screen.findByText("本轮无文件改动");
		await waitFor(() => expect(row("src")).toBeTruthy());
		expectOpen("src", false);
		expectOpen("docs", false);
		expectOpen("assets", false);
	});

	it("respects manual collapse during refresh and resets manual expansion when the project reopens", async () => {
		render(<Harness />);
		await screen.findByText("changed.ts");
		showAll();
		fireEvent.click(row("src"));
		fireEvent.click(row("docs"));
		expectOpen("docs", true);
		const before = refreshes;
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刷新项目" })); });
		await waitFor(() => expect(refreshes).toBeGreaterThan(before));
		expectOpen("src", false);
		fireEvent.click(screen.getByRole("button", { name: "重新打开项目" }));
		await screen.findByText("changed.ts");
		expectOpen("docs", false);
		fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
		expectOpen("docs", true);
		fireEvent.click(screen.getByRole("button", { name: "收起全部" }));
		expectOpen("src", false);
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刷新项目" })); });
		await waitFor(() => expect(refreshes).toBeGreaterThan(before + 1));
		expectOpen("src", false);
	});

	it("resets manually opened folders when switching sessions in the same workspace", async () => {
		const { rerender } = render(<Harness />);
		await screen.findByText("changed.ts");
		showAll();
		fireEvent.click(row("docs"));
		expectOpen("docs", true);
		rerender(<Harness sessionPath="/other-session.jsonl" />);
		await waitFor(() => expectOpen("docs", false));
		await screen.findByText("changed.ts");
		expectOpen("src/app", true);
	});

	it("resets to each round and opens a late session diff including deleted-file ancestors", async () => {
		render(<Harness />);
		await screen.findByText("changed.ts");
		showAll();
		fireEvent.click(screen.getByRole("button", { name: "上一轮" }));
		await screen.findByText("guide.md");
		expectOpen("docs", true);
		expectOpen("src", false);
		fireEvent.click(screen.getByRole("button", { name: "下一轮" }));
		await screen.findByText("changed.ts");
		expectOpen("docs", false);
		fireEvent.click(screen.getByRole("radio", { name: "本会话累计" }));
		await waitFor(() => expect(resolveTotal).toBeTruthy());
		await act(async () => { resolveTotal!(response({ changes: [...oldChanges, ...latestChanges, { status: "D", path: "archive/removed.txt" }] })); });
		await screen.findByText("removed.txt");
		expectOpen("docs", true);
		expectOpen("src/app", true);
		expectOpen("archive", true);
		fireEvent.click(screen.getByRole("radio", { name: "本轮" }));
		await waitFor(() => expectOpen("docs", false));
		expect(screen.queryByText("removed.txt")).toBeNull();
	});
});
