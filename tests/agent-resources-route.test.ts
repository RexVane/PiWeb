import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../src/lib/agent-manager", () => ({ loadWorkspaceResources: mocks.load }));
import { GET } from "../src/app/api/agent/resources/route";

let cwd: string;
beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resources-route-"));
	mocks.load.mockReset();
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });
const request = (cwd?: string) => new Request(`http://localhost/api/agent/resources${cwd === undefined ? "" : `?cwd=${encodeURIComponent(cwd)}`}`);

describe("workspace resources route", () => {
	it("loads resources for the validated canonical workspace without a session ID", async () => {
		const resources = { skills: [{ name: "probe" }], promptTemplates: [], extensionCommands: [] };
		mocks.load.mockResolvedValue(resources);
		const result = await GET(request(cwd));
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ success: true, data: resources });
		expect(mocks.load).toHaveBeenCalledWith(await fs.realpath(cwd));
	});

	it.each([undefined, "", "missing"])("rejects an invalid workspace (%s) before loading executable resources", async (input) => {
		const result = await GET(request(input === "missing" ? path.join(cwd, "missing") : input));
		expect(result.status).toBe(400);
		expect((await result.json()).success).toBe(false);
		expect(mocks.load).not.toHaveBeenCalled();
	});

	it("returns resource discovery errors instead of a false successful empty catalog", async () => {
		mocks.load.mockRejectedValue(new Error("Discovery failed"));
		const result = await GET(request(cwd));
		expect(result.status).toBe(500);
		expect(await result.json()).toEqual({ success: false, error: "Discovery failed" });
	});
});
