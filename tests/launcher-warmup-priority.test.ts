import { expect, it, vi } from "vitest";
import { warmFirstPaint, FIRST_PAINT_ROUTES } from "../scripts/launcher.mjs";

const base = "http://127.0.0.1:32141";
const background = ["/api/version", ...FIRST_PAINT_ROUTES.filter((route) => route !== "/api/sessions")];
const ok = () => new Response("{}", { status: 200 });

it("waits for the sessions response body before background work and does not wait for that background work", async () => {
	const requested: string[] = [], finishBackground: Array<() => void> = [];
	let body!: ReadableStreamDefaultController<Uint8Array>;
	const fetchImpl: typeof fetch = async (input) => {
		const route = new URL(String(input)).pathname; requested.push(route);
		if (route === "/api/sessions") return new Response(new ReadableStream({ start(controller) { body = controller; } }));
		return new Promise<Response>((resolve) => { finishBackground.push(() => resolve(ok())); });
	};
	const warming = warmFirstPaint(base, { check: async () => true, fetchImpl });
	await vi.waitFor(() => expect(requested).toEqual(["/api/sessions"]));
	body.enqueue(new TextEncoder().encode("{}")); body.close();
	expect(await warming).toBe(true);
	expect(requested).toEqual(["/api/sessions", ...background]);
	expect(finishBackground).toHaveLength(background.length);
	for (const finish of finishBackground) finish();
});

it.each(["network", "http"])("still starts all secondary tasks after a sessions %s failure", async (failure) => {
	const requested: string[] = [];
	const fetchImpl: typeof fetch = async (input) => {
		const route = new URL(String(input)).pathname; requested.push(route);
		if (route === "/api/sessions") { if (failure === "network") throw new Error("offline fixture"); return new Response("unavailable", { status: 503 }); }
		return ok();
	};
	expect(await warmFirstPaint(base, { check: async () => true, fetchImpl })).toBe(false);
	expect(requested).toEqual(["/api/sessions", ...background]);
});

it("bounds a stalled sessions request and then allows secondary tasks to proceed", async () => {
	const requested: string[] = [];
	const fetchImpl: typeof fetch = async (input, options) => {
		const route = new URL(String(input)).pathname; requested.push(route);
		if (route !== "/api/sessions") return ok();
		return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("fixture request timed out")), { once: true }));
	};
	expect(await warmFirstPaint(base, { check: async () => true, fetchImpl, timeoutMs: 20 })).toBe(false);
	expect(requested).toEqual(["/api/sessions", ...background]);
});

it("cancels the sessions request without starting new background work after launcher shutdown", async () => {
	const controller = new AbortController(), requested: string[] = [];
	const fetchImpl: typeof fetch = async (input, options) => {
		requested.push(new URL(String(input)).pathname);
		return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("fixture shutdown")), { once: true }));
	};
	const warming = warmFirstPaint(base, { check: async () => true, fetchImpl, signal: controller.signal });
	await vi.waitFor(() => expect(requested).toEqual(["/api/sessions"]));
	controller.abort(); expect(await warming).toBe(false);
	expect(requested).toEqual(["/api/sessions"]);
});

it("isolates background failures after sessions succeeds", async () => {
	const requested: string[] = [];
	const fetchImpl: typeof fetch = async (input) => {
		const route = new URL(String(input)).pathname; requested.push(route);
		if (route === "/api/version" || route === "/api/models") throw new Error("background fixture failure");
		return ok();
	};
	expect(await warmFirstPaint(base, { check: async () => true, fetchImpl })).toBe(true);
	expect(requested).toEqual(["/api/sessions", ...background]);
});
