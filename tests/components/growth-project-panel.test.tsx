// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPanel } from "@/components/ProjectPanel";
import type { GrowthApi } from "@/hooks/useGrowth";
import { buildTree } from "@/lib/growth-tree";

const growth: GrowthApi = {
	available: true, loading: false, error: null, steps: [], rounds: [], baseline: null, latest: null,
	selected: null, selectedRound: null, following: true, scope: "step", range: null, changes: [], sessionChanges: [],
	tree: buildTree([], []), filePaths: [], expanded: new Set(), fresh: new Set(), pending: [],
	follow() {}, selectRound() {}, prev() {}, next() {}, setScope() {}, toggleDir() {}, revealPath() {}, expandAll() {}, collapseAll() {},
	async expandLazy() {}, async refresh() {}, async snapshotNow() { return null; },
};

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("ProjectPanel Git unknown state", () => {
	it.each(["status", "request"])("does not show clean or commit controls after a %s failure", async (kind) => {
		vi.useFakeTimers();
		const info = { available: true, isRepo: true, root: "/workspace", branch: "main", upstream: null, ahead: 0, behind: 0, detached: false, files: [], commits: [], statusError: "index file corrupt" };
		vi.stubGlobal("fetch", kind === "status"
			? vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: info }) })
			: vi.fn().mockRejectedValue(new Error("request failed")));
		render(<ProjectPanel growth={growth} workspaceName="workspace" cwd="/workspace" hasSession={false} onOpenFile={vi.fn()} onClose={vi.fn()} onError={vi.fn()} onAskCommit={vi.fn()} />);
		await act(async () => { await vi.advanceTimersByTimeAsync(300); });
		const error = screen.getByTestId("growth-git-error");
		expect(error.textContent).toMatch(/Git 状态读取失败|Git status unavailable/);
		expect(error.getAttribute("title")).toBe(kind === "status" ? "index file corrupt" : "request failed");
		expect(screen.queryByText(/工作区干净|Working tree clean/)).toBeNull();
		expect(screen.queryByRole("button", { name: /让 pi 提交|Ask pi to commit/ })).toBeNull();
	});
});
