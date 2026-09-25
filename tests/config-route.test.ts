import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/lib/pi", () => ({ getAgentDir: () => agentDir.path }));
import { GET } from "../src/app/api/config/route";

beforeEach(async () => { agentDir.path = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-config-route-")); });
afterEach(async () => { await fs.rm(agentDir.path, { recursive: true, force: true }); });

it("downloads an empty config on a fresh installation without creating a file", async () => {
	const response = await GET();
	expect(response.status).toBe(200);
	expect(response.headers.get("content-disposition")).toContain("settings.json");
	expect(await response.json()).toEqual({});
	await expect(fs.stat(path.join(agentDir.path, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("downloads the existing settings file unchanged", async () => {
	const source = '{"theme":"dark"}\n';
	await fs.writeFile(path.join(agentDir.path, "settings.json"), source);
	const response = await GET();
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(source);
});
