import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(async () => {
root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-tool-prefs-"));
agentDir = path.join(root, "agent");
cwd = path.join(root, "workspace");
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(cwd, { recursive: true });
vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
vi.resetModules();
});

afterEach(async () => {
vi.unstubAllEnvs();
await fs.rm(root, { recursive: true, force: true });
});

describe("tool preferences", () => {
it("returns null before anything is saved", async () => {
const store = await import("../src/lib/tool-preferences");
expect(await store.readToolPreference(path.join(cwd, "s.jsonl"))).toBeNull();
});

it("keeps preset and per-tool switches isolated per session", async () => {
const store = await import("../src/lib/tool-preferences");
const sessionA = path.join(cwd, "a.jsonl");
const sessionB = path.join(cwd, "b.jsonl");
await store.saveToolPreference(sessionA, { toolPreset: "standard", customActiveTools: ["read", "bash", "codemode"] });
expect(await store.readToolPreference(sessionA)).toMatchObject({
toolPreset: "standard",
customActiveTools: ["read", "bash", "codemode"],
});
await store.saveToolPreference(sessionB, { toolPreset: "full", customActiveTools: ["read"] });
expect(await store.readToolPreference(sessionA)).toMatchObject({ toolPreset: "standard", customActiveTools: ["read", "bash", "codemode"] });
expect(await store.readToolPreference(sessionB)).toMatchObject({ toolPreset: "full", customActiveTools: ["read"] });
});

it("deduplicates names and drops malformed entries instead of crashing", async () => {
const store = await import("../src/lib/tool-preferences");
const session = path.join(cwd, "s.jsonl");
await store.saveToolPreference(session, { toolPreset: "readonly", customActiveTools: ["read", "read", "grep"] });
const file = path.join(agentDir, "web-tool-preferences.json");
const raw = JSON.parse(await fs.readFile(file, "utf8"));
const key = Object.keys(raw.sessions)[0];
raw.sessions[key].customActiveTools = ["read", 42, null, "read", "grep"];
raw.sessions["bad"] = { toolPreset: "nope" };
await fs.writeFile(file, JSON.stringify(raw));
expect(await store.readToolPreference(session)).toMatchObject({ toolPreset: "readonly", customActiveTools: ["read", "grep"] });
});

it("overwrites preset while clearing a previous custom list", async () => {
const store = await import("../src/lib/tool-preferences");
const session = path.join(cwd, "s.jsonl");
await store.saveToolPreference(session, { toolPreset: "full", customActiveTools: ["read"] });
await store.saveToolPreference(session, { toolPreset: "readonly" });
expect(await store.readToolPreference(session)).toMatchObject({ toolPreset: "readonly" });
expect((await store.readToolPreference(session))?.customActiveTools).toBeUndefined();
});
});
