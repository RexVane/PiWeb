// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionImportSection } from "@/components/SessionImportSection";
import { I18nProvider, useI18n } from "@/i18n";
import { SESSION_CHANGE_EVENT } from "@/lib/session-change-events";

const scanResponse = () => Response.json({ success: true, data: {
	sessions: [{ source: "claude", externalId: "c1", title: "Import fixture", projectPath: "/ws" }],
	errors: [], imported: [], archived: [], sources: ["claude"],
} });
function LanguageSwitch() {
	const { setLang } = useI18n();
	return <button onClick={() => setLang("en")}>Switch language</button>;
}
afterEach(() => {
	cleanup(); vi.unstubAllGlobals(); localStorage.removeItem("piweb.lang");
	document.cookie = "piweb.lang=; Max-Age=0; Path=/";
	document.documentElement.lang = "zh-CN";
});

describe("session import request lifecycle", () => {
	it("continues an active import when language changes and publishes its completion", async () => {
		let stream!: ReadableStreamDefaultController<Uint8Array>;
		let importSignal!: AbortSignal;
		const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method !== "POST") return scanResponse();
			importSignal = init.signal!;
			return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
		});
		vi.stubGlobal("fetch", fetchMock);
		const changed = vi.fn(); window.addEventListener(SESSION_CHANGE_EVENT, changed);
		try {
			render(<I18nProvider initialLang="zh"><LanguageSwitch /><SessionImportSection /></I18nProvider>);
			await screen.findByText("Import fixture");
			await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false));
			fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByTestId("import-run"));
			await screen.findByTestId("import-progress");
			const readsBeforeLanguageChange = fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST").length;
			fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
			expect(importSignal.aborted).toBe(false);
			expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(readsBeforeLanguageChange);
			await act(async () => {
				stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", data: { imported: 1, skipped: 0, failed: 0, results: [], workspaces: ["/ws"] } }) + "\n"));
				stream.close();
			});
			expect(await screen.findByTestId("import-report")).toBeTruthy();
			expect(screen.queryByTestId("import-progress")).toBeNull();
			expect(changed).toHaveBeenCalledOnce();
		} finally { window.removeEventListener(SESSION_CHANGE_EVENT, changed); }
	});

	it("aborts an active import and cancels its reader when the panel unmounts", async () => {
		let importSignal!: AbortSignal;
		const cancel = vi.fn();
		vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method !== "POST") return scanResponse();
			importSignal = init.signal!;
			return new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "application/x-ndjson" } });
		}));
		const view = render(<SessionImportSection />);
		await screen.findByText("Import fixture");
		await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false));
		fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByTestId("import-run"));
		await screen.findByTestId("import-progress");
		view.unmount();
		expect(importSignal.aborted).toBe(true);
		await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
	});

	it("rescans with a fresh signal after StrictMode aborts the initial effect", async () => {
		const signals: AbortSignal[] = [];
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
			const signal = init!.signal!; signals.push(signal);
			if (signal.aborted) return Promise.reject(signal.reason);
			if (signals.length > 1) return Promise.resolve(scanResponse());
			return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		}));
		render(<StrictMode><SessionImportSection /></StrictMode>);
		expect(await screen.findByText("Import fixture")).toBeTruthy();
		expect(signals).toHaveLength(2);
		expect(signals[0].aborted).toBe(true); expect(signals[1].aborted).toBe(false);
		await waitFor(() => expect((screen.getByTestId("import-rescan") as HTMLButtonElement).disabled).toBe(false));
	});

	it("discards queued scans on a real unmount", async () => {
		let scanSignal!: AbortSignal;
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			scanSignal = init!.signal!;
			return new Promise<Response>((_resolve, reject) => scanSignal.addEventListener("abort", () => reject(scanSignal.reason), { once: true }));
		});
		vi.stubGlobal("fetch", fetchMock);
		const view = render(<SessionImportSection />);
		fireEvent(window, new Event(SESSION_CHANGE_EVENT));
		await act(async () => view.unmount());
		expect(scanSignal.aborted).toBe(true);
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
