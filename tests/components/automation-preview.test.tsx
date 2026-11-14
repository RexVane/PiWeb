// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutomationModal } from "@/components/workspace/AutomationModal";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (hour: number) => ({ json: async () => ({ success: true, data: { nextRunAt: Date.parse(`2026-11-14T0${hour}:00:00Z`), timeZone: "Asia/Shanghai", computedAt: 0 } }) });

it("shows the scheduler's next execution time and ignores a late preview for the previous schedule", async () => {
	let resolveOld!: (value: ReturnType<typeof response>) => void;
	const pendingOld = new Promise<ReturnType<typeof response>>((resolve) => { resolveOld = resolve; });
	vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
		if (url.startsWith("/api/models")) return Promise.resolve({ json: async () => ({ success: true, data: { models: [] } }) });
		return JSON.parse(String(init?.body)).schedule.time === "09:00" ? pendingOld : Promise.resolve(response(2));
	}));
	const { container } = render(<AutomationModal open initialTask={null} knownCwds={["/work"]} defaultCwd="/work" getWorkspaceName={(cwd) => cwd} models={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
	fireEvent.change(container.querySelector('input[type="time"]')!, { target: { value: "10:00" } });
	expect((await screen.findByText(/预计下次运行：11\/14 10:00/)).textContent).toContain("执行时区：Asia/Shanghai");
	await act(async () => resolveOld(response(1)));
	expect(screen.queryByText(/11\/14 09:00/)).toBeNull();
	expect(screen.getByText(/11\/14 10:00/)).toBeTruthy();
});
