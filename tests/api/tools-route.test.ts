import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let agentDir: string;

beforeEach(async () => {
agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-tools-route-"));
vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
vi.resetModules();
});

afterEach(async () => {
vi.unstubAllEnvs();
await fs.rm(agentDir, { recursive: true, force: true });
});

const put = (body: unknown) => new Request("http://localhost/api/tools", {
method: "PUT",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(body),
});

describe("global tool preference API", () => {
it("saves and reads back one global selection without any session", async () => {
const { GET, PUT } = await import("../../src/app/api/tools/route");
expect(await (await GET()).json()).toEqual({ success: true, data: null });
expect(await (await PUT(put({ toolPreset: "full", names: ["read", "bash", "read"] }))).json()).toMatchObject({
success: true,
data: { toolPreset: "full", customActiveTools: ["read", "bash"] },
});
expect(await (await GET()).json()).toMatchObject({ success: true, data: { toolPreset: "full", customActiveTools: ["read", "bash"] } });
});

it("rejects an unknown preset or an empty tool list", async () => {
const { PUT } = await import("../../src/app/api/tools/route");
const bad = await PUT(put({ toolPreset: "yolo" }));
expect(bad.status).toBe(400);
expect(await bad.json()).toMatchObject({ success: false });
const empty = await PUT(put({ toolPreset: "standard", names: [] }));
expect(empty.status).toBe(400);
});
});
