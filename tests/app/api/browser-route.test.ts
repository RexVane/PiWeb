import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pick = vi.hoisted(() => ({ captureForPicking: vi.fn(), pickElementAt: vi.fn() }));
vi.mock("@/lib/browser/pick", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/browser/pick")>()), ...pick }));
vi.mock("@/lib/agent/agent-manager", () => ({ getManaged: () => ({ cwd: "/workspace" }) }));

let root = "";
let sessionId = "";
let POST: typeof import("@/app/api/browser/route").POST;
let errors: typeof import("@/lib/browser/pick");
let encodeSessionId: typeof import("@/lib/pi").encodeSessionId;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-browser-route-"));
	const sessionsDir = path.join(root, "agent", "sessions", "--w--");
	await fs.mkdir(sessionsDir, { recursive: true });
	const sessionFile = path.join(sessionsDir, "s.jsonl");
	await fs.writeFile(sessionFile, "{}\n");
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
	({ POST } = await import("@/app/api/browser/route"));
	errors = await import("@/lib/browser/pick");
	({ encodeSessionId } = await import("@/lib/pi"));
	sessionId = encodeSessionId(await fs.realpath(sessionFile));
});

afterAll(async () => {
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
	pick.captureForPicking.mockReset();
	pick.pickElementAt.mockReset();
});

function post(body: unknown) {
	return POST(new Request("http://127.0.0.1/api/browser", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
}

describe("POST /api/browser", () => {
	it("captures and picks through the session's own tab", async () => {
		pick.captureForPicking.mockResolvedValue({ width: 1280 });
		const captured = await post({ action: "capture", session: sessionId });
		expect(captured.status).toBe(200);
		expect(await captured.json()).toEqual({ success: true, data: { width: 1280 } });
		expect(pick.captureForPicking.mock.calls[0][0]).toMatch(/s\.jsonl$/);

		pick.pickElementAt.mockResolvedValue({ locations: [] });
		const picked = await post({ action: "pick", session: sessionId, x: 10.5, y: 20 });
		expect(picked.status).toBe(200);
		expect(pick.pickElementAt.mock.calls[0].slice(1)).toEqual(["/workspace", 10.5, 20]);
	});

	it("validates the request before touching the browser", async () => {
		expect((await post("{not json")).status).toBe(400);
		expect((await post([])).status).toBe(400);
		expect((await post({ action: "capture", session: "bad id!" })).status).toBe(400);
		expect((await post({ action: "capture", session: encodeSessionId(path.join(root, "outside.jsonl")) })).status).toBe(400);
		expect((await post({ action: "pick", session: sessionId, x: "1", y: 2 })).status).toBe(400);
		expect((await post({ action: "navigate", session: sessionId })).status).toBe(400);
		expect((await post("x".repeat(5000))).status).toBe(400);
		expect(pick.captureForPicking).not.toHaveBeenCalled();
		expect(pick.pickElementAt).not.toHaveBeenCalled();
	});

	it("maps picking failures to meaningful status codes", async () => {
		pick.captureForPicking.mockRejectedValueOnce(new errors.NoBrowserPageError());
		const noPage = await post({ action: "capture", session: sessionId });
		expect(noPage.status).toBe(409);
		expect((await noPage.json()).error).toMatch(/no page open/);
		pick.pickElementAt.mockRejectedValueOnce(new errors.NoElementError());
		expect((await post({ action: "pick", session: sessionId, x: 1, y: 1 })).status).toBe(404);
	});
});
