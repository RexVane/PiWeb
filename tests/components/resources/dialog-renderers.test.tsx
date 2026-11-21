// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExtensionDialogHost } from "@/components/ExtensionUI";
import { useDialogRenderers, type DialogRendererRegistry, type RenderedExtensionDialog } from "@/hooks/useDialogRenderers";
import { useResourceRegistry } from "@/hooks/useResourceRegistry";
import type { ExtensionDialog } from "@/hooks/usePiWeb";
import type { WebResourceView } from "@/lib/resources/protocol";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const view: WebResourceView = { id: "user:questions:main", resourceId: "questions", scope: "user", title: "Questions", placement: "aboveEditor", methods: ["select", "confirm", "input", "editor"], url: "/api/resources/views/abcd/assets/index.html" };
const other: WebResourceView = { ...view, id: "user:other:main", resourceId: "other", title: "Other", placement: "belowEditor", url: "/api/resources/views/efgh/assets/index.html" };
function registry(overrides: Partial<DialogRendererRegistry> = {}): DialogRendererRegistry {
	return { views: [view, other], preferences: { renderers: { select: view.id, input: view.id } }, loaded: true, error: "", registryCwd: "/workspace", ...overrides };
}
function request(overrides: Partial<ExtensionDialog> = {}): ExtensionDialog {
	return { id: "request-1", method: "select", title: "Choose", options: ["A", "B"], ts: 1, ...overrides };
}
function Requests({ dialogs, catalog, cwd = "/workspace", sessionPath = "/session", onAnswer = () => {} }: { dialogs: ExtensionDialog[]; catalog: DialogRendererRegistry; cwd?: string; sessionPath?: string; onAnswer?: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void }) {
	const { embedded, modal } = useDialogRenderers(dialogs, catalog, cwd, sessionPath);
	const host = (resolved: RenderedExtensionDialog | null) => resolved && <ExtensionDialogHost key={resolved.dialog.id} dialog={resolved.dialog} renderer={resolved.renderer} cwd={cwd} sessionPath={sessionPath} embedded={resolved.placement !== "dialog"} onAnswer={onAnswer} />;
	return <><div data-testid="above">{embedded?.placement === "aboveEditor" && host(embedded)}</div><div data-testid="below">{embedded?.placement === "belowEditor" && host(embedded)}</div><div data-testid="modal">{host(modal)}</div></>;
}
function frameDraft(frame: HTMLIFrameElement, value: string): HTMLInputElement {
	const document = frame.contentDocument!;
	document.open(); document.write('<!doctype html><html><body><input id="draft"></body></html>'); document.close();
	const input = document.getElementById("draft") as HTMLInputElement;
	input.value = value;
	return input;
}

describe("request renderer selection", () => {
	it("places an explicit custom resource request immediately and keeps its document when discovery arrives", () => {
		const dialog = request({ method: "resource", resourceView: { ...view, methods: [] }, resourceData: { questions: ["Choose"] } });
		const { container, rerender } = render(<StrictMode><Requests dialogs={[dialog]} catalog={registry({ loaded: false, views: [], preferences: { renderers: {} } })} /></StrictMode>);
		const frame = container.querySelector("iframe")!;
		expect(screen.getByTestId("above").contains(frame)).toBe(true);
		expect(screen.getByTestId("modal").childElementCount).toBe(0);
		const draft = frameDraft(frame, "Unsubmitted answer");
		rerender(<StrictMode><Requests dialogs={[{ ...dialog, resourceData: { questions: ["Updated"] } }]} catalog={registry({ views: [{ ...view, placement: "dialog", url: other.url, methods: [] }] })} /></StrictMode>);
		expect(container.querySelector("iframe")).toBe(frame);
		expect(screen.getByTestId("above").contains(frame)).toBe(true);
		expect(draft.isConnected).toBe(true);
		expect(draft.value).toBe("Unsubmitted answer");
	});

	it("waits for the first preferences load and then mounts directly in the chosen slot", () => {
		const dialog = request();
		const { container, rerender } = render(<Requests dialogs={[dialog]} catalog={registry({ loaded: false, views: [], preferences: { renderers: {} } })} />);
		expect(screen.queryByRole("dialog")).toBeNull();
		rerender(<Requests dialogs={[dialog]} catalog={registry()} />);
		const frame = container.querySelector("iframe")!;
		expect(screen.getByTestId("above").contains(frame)).toBe(true);
		expect(screen.getByTestId("modal").childElementCount).toBe(0);
		const draft = frameDraft(frame, "Keep this draft");
		rerender(<Requests dialogs={[dialog]} catalog={registry({ preferences: { renderers: { select: other.id } } })} />);
		expect(container.querySelector("iframe")).toBe(frame);
		expect(draft.value).toBe("Keep this draft");
	});

	it.each<[string, string, WebResourceView[]]>([
		["missing id", "user:missing:main", [view]],
		["unsupported method", view.id, [{ ...view, methods: ["confirm"] }]],
		["no explicit preference", "", [view]],
	])("uses native controls for a %s without answering automatically", (_label, preferred, views) => {
		const answer = vi.fn();
		const { container } = render(<Requests dialogs={[request()]} catalog={registry({ views: [...views], preferences: { renderers: { select: preferred } } })} onAnswer={answer} />);
		expect(container.querySelector("iframe")).toBeNull();
		expect(screen.getByRole("listbox")).toBeTruthy();
		expect(answer).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("option", { name: "B" }));
		expect(answer).toHaveBeenCalledWith("request-1", { value: "B" });
	});

	it("does not let an incompatible explicit view bypass validation through ExtensionDialogHost", () => {
		const incompatible = { ...view, methods: ["confirm"] as WebResourceView["methods"] };
		const { container } = render(<Requests dialogs={[request({ resourceView: incompatible })]} catalog={registry({ views: [incompatible] })} />);
		expect(container.querySelector("iframe")).toBeNull();
		expect(screen.getByRole("listbox")).toBeTruthy();
	});

	it("requires an explicit view to match the enabled resource id and scope", () => {
		const answer = vi.fn();
		const { container } = render(<Requests dialogs={[request({ method: "resource", resourceView: view })]} catalog={registry({ views: [{ ...view, scope: "project" }] })} onAnswer={answer} />);
		expect(container.querySelector("iframe")).toBeNull();
		expect(screen.getByRole("textbox", { name: "使用基础界面" })).toBeTruthy();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(answer).toHaveBeenCalledWith("request-1", { cancelled: true });
	});

	it.each<[string, WebResourceView[]]>([
		["resource removal", []],
		["renderer incompatibility", [{ ...view, methods: ["confirm"] }]],
	])("keeps a live iframe through polling errors but revokes it on successful %s", (_reason, remainingViews) => {
		const answer = vi.fn(); const dialog = request();
		const { container, rerender } = render(<Requests dialogs={[dialog]} catalog={registry()} onAnswer={answer} />);
		const frame = container.querySelector("iframe")!;
		const draft = frameDraft(frame, "Saved inside the frame");
		rerender(<Requests dialogs={[dialog]} catalog={registry({ error: "Offline", views: [], preferences: { renderers: {} } })} onAnswer={answer} />);
		expect(container.querySelector("iframe")).toBe(frame);
		expect(draft.value).toBe("Saved inside the frame");
		rerender(<Requests dialogs={[dialog]} catalog={registry({ views: remainingViews, preferences: { renderers: {} } })} onAnswer={answer} />);
		expect(container.querySelector("iframe")).toBeNull();
		expect(screen.getByRole("listbox")).toBeTruthy();
		expect(answer).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(answer).toHaveBeenCalledWith("request-1", { cancelled: true });
	});

	it("checks compatibility again for the next request and never upgrades a started native draft", () => {
		const dialog = request({ method: "input", placeholder: "Your answer" });
		const { container, rerender } = render(<Requests dialogs={[dialog]} catalog={registry({ error: "Offline", views: [], preferences: { renderers: {} } })} />);
		fireEvent.change(screen.getByPlaceholderText("Your answer"), { target: { value: "Native draft" } });
		rerender(<Requests dialogs={[dialog]} catalog={registry()} />);
		expect(container.querySelector("iframe")).toBeNull();
		expect((screen.getByPlaceholderText("Your answer") as HTMLInputElement).value).toBe("Native draft");
		rerender(<Requests dialogs={[{ ...dialog, id: "request-2" }]} catalog={registry({ preferences: { renderers: { input: other.id } } })} />);
		expect(container.querySelector("iframe")?.getAttribute("src")).toBe(other.url);
		expect(screen.getByTestId("below").querySelector("iframe")).toBeTruthy();
	});

	it("does not promote a second embedded request into a modal or preempt an active request", () => {
		const pending = request();
		const explicit = request({ id: "explicit", method: "resource", resourceView: other });
		const { container, rerender } = render(<Requests dialogs={[pending, explicit]} catalog={registry({ loaded: false, views: [], preferences: { renderers: {} } })} />);
		const frame = container.querySelector("iframe")!;
		const draft = frameDraft(frame, "Active question draft");
		rerender(<Requests dialogs={[pending, explicit]} catalog={registry()} />);
		expect(container.querySelectorAll("iframe")).toHaveLength(1);
		expect(container.querySelector("iframe")).toBe(frame);
		expect(screen.getByTestId("modal").childElementCount).toBe(0);
		rerender(<Requests dialogs={[explicit, pending]} catalog={registry()} />);
		expect(container.querySelector("iframe")).toBe(frame);
		expect(draft.value).toBe("Active question draft");
		rerender(<Requests dialogs={[pending]} catalog={registry()} />);
		expect(screen.getByTestId("above").querySelector("iframe")?.getAttribute("src")).toBe(view.url);
	});

	it("uses fresh preferences after changing session and avoids another workspace's stale catalog", () => {
		const dialog = request();
		const { container, rerender } = render(<Requests dialogs={[dialog]} catalog={registry()} />);
		const frame = container.querySelector("iframe")!;
		rerender(<Requests dialogs={[dialog]} sessionPath="/another-session" catalog={registry({ preferences: { renderers: { select: other.id } } })} />);
		expect(container.querySelector("iframe")).not.toBe(frame);
		expect(screen.getByTestId("below").querySelector("iframe")).toBeTruthy();
		rerender(<Requests dialogs={[dialog]} cwd="/another-workspace" catalog={registry()} />);
		expect(screen.queryByRole("dialog")).toBeNull();
		rerender(<Requests dialogs={[dialog]} cwd="/another-workspace" catalog={registry({ registryCwd: "/another-workspace", preferences: { renderers: { select: other.id } } })} />);
		expect(screen.getByTestId("below").querySelector("iframe")).toBeTruthy();
	});

	it("removes a resolved request and chooses again if its id is later reused", () => {
		const dialog = request({ method: "resource", resourceView: view });
		const answer = vi.fn();
		const { container, rerender } = render(<Requests dialogs={[dialog]} catalog={registry()} onAnswer={answer} />);
		rerender(<Requests dialogs={[]} catalog={registry()} onAnswer={answer} />);
		expect(container.querySelector("iframe")).toBeNull();
		expect(answer).not.toHaveBeenCalled();
		rerender(<Requests dialogs={[{ ...dialog, resourceView: other }]} catalog={registry()} onAnswer={answer} />);
		expect(screen.getByTestId("below").querySelector("iframe")).toBeTruthy();
	});
});

describe("resource registry workspace marker", () => {
	it("marks the source workspace during a transition and ignores an earlier workspace's late response", async () => {
		const pending: Array<(value: unknown) => void> = [];
		vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => pending.push(resolve))));
		const renders: Array<{ requested: string; source: string; ids: string[] }> = [];
		function Probe({ cwd }: { cwd: string }) {
			const catalog = useResourceRegistry(cwd);
			renders.push({ requested: cwd, source: catalog.registryCwd, ids: catalog.views.map((view) => view.id) });
			return <span>{catalog.registryCwd}:{catalog.views.map((view) => view.id).join(",")}</span>;
		}
		const response = (views: WebResourceView[]) => ({ ok: true, json: async () => ({ success: true, data: { views } }) });
		const { rerender } = render(<Probe cwd="/first" />);
		await act(async () => pending[0](response([view])));
		await waitFor(() => expect(screen.getByText(`/first:${view.id}`)).toBeTruthy());
		await act(async () => { window.dispatchEvent(new Event("piweb:resources-changed")); });
		rerender(<Probe cwd="/second" />);
		expect(renders.some((render) => render.requested === "/second" && render.source === "/first" && render.ids[0] === view.id)).toBe(true);
		await act(async () => pending[2](response([other])));
		await waitFor(() => expect(screen.getByText(`/second:${other.id}`)).toBeTruthy());
		await act(async () => pending[1](response([view])));
		expect(screen.getByText(`/second:${other.id}`)).toBeTruthy();
	});
});
