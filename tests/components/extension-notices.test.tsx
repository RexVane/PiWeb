// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExtensionNotices } from "@/components/ExtensionUI";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function notice(id: string, message: string, overrides: Record<string, unknown> = {}) {
	return { id, message, type: "info" as const, ts: Date.now(), ...overrides };
}

describe("ExtensionNotices", () => {
	it("renders each notice and dismisses on click", () => {
		const onDismiss = vi.fn();
		render(<ExtensionNotices notices={[notice("a", "first notice"), notice("b", "second notice")]} onDismiss={onDismiss} />);
		expect(screen.getByText("first notice")).toBeTruthy();
		expect(screen.getByText("second notice")).toBeTruthy();
		fireEvent.click(screen.getByText("first notice"));
		expect(onDismiss).toHaveBeenCalledWith("a");
	});

	it("auto-dismisses roughly six seconds after the notice timestamp", () => {
		vi.useFakeTimers();
		const onDismiss = vi.fn();
		render(<ExtensionNotices notices={[notice("a", "timed", { ts: Date.now() })]} onDismiss={onDismiss} />);
		act(() => {
			vi.advanceTimersByTime(5900);
		});
		expect(onDismiss).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(onDismiss).toHaveBeenCalledWith("a");
	});

	it("dismisses stale notices after a shorter grace period", () => {
		vi.useFakeTimers();
		const onDismiss = vi.fn();
		render(<ExtensionNotices notices={[notice("a", "old", { ts: Date.now() - 30_000 })]} onDismiss={onDismiss} />);
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(onDismiss).toHaveBeenCalledWith("a");
	});

	it("renders nothing without notices", () => {
		const { container } = render(<ExtensionNotices notices={[]} onDismiss={vi.fn()} />);
		expect(container.firstChild).toBeNull();
	});
});
