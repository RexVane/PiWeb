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
await store.saveToolPreference(sessionA, { toolPreset: "workspace", customActiveTools: ["read", "bash", "codemode"] });
expect(await store.readToolPreference(sessionA)).toMatchObject({
toolPreset: "workspace",
customActiveTools: ["read", "bash", "codemode"],
});
await store.saveToolPreference(sessionB, { toolPreset: "full", customActiveTools: ["read"] });
expect(await store.readToolPreference(sessionA)).toMatchObject({ toolPreset: "workspace", customActiveTools: ["read", "bash", "codemode"] });
expect(await store.readToolPreference(sessionB)).toMatchObject({ toolPreset: "full", customActiveTools: ["read"] });
});

it("deduplicates valid names but rejects malformed permissions without losing their original record", async () => {
const store = await import("../src/lib/tool-preferences");
const session = path.join(cwd, "s.jsonl");
await store.saveToolPreference(session, { toolPreset: "readonly", customActiveTools: ["read", "read", "grep"] });
const file = path.join(agentDir, "web-tool-preferences.json");
const raw = JSON.parse(await fs.readFile(file, "utf8"));
const key = Object.keys(raw.sessions)[0];
expect(await store.readToolPreference(session)).toMatchObject({ customActiveTools: ["read", "grep"] });
raw.sessions[key].customActiveTools = ["read", 42, null, "read", "grep"];
raw.sessions["bad"] = { toolPreset: "nope" };
await fs.writeFile(file, JSON.stringify(raw));
await expect(store.readToolPreference(session)).rejects.toThrow("invalid");
await store.saveToolPreference(path.join(cwd, "other.jsonl"), { toolPreset: "readonly" });
const retained = JSON.parse(await fs.readFile(file, "utf8"));
expect(retained.sessions[key]).toEqual(raw.sessions[key]);
expect(retained.sessions.bad).toEqual(raw.sessions.bad);
});

it("does not treat an invalid preset for the requested session as an unsaved preference", async () => {
const store = await import("../src/lib/tool-preferences");
const session = path.join(cwd, "bad.jsonl");
const key = process.platform === "win32" ? path.resolve(session).toLowerCase() : path.resolve(session);
await fs.writeFile(path.join(agentDir, "web-tool-preferences.json"), JSON.stringify({ version: 2, sessions: { [key]: { toolPreset: "invalid" } } }));
await expect(store.readToolPreference(session)).rejects.toThrow("invalid");
});

it("rejects malformed file schemas and oversized data without rewriting them", async () => {
const store = await import("../src/lib/tool-preferences");
const file = path.join(agentDir, "web-tool-preferences.json");
for (const content of [JSON.stringify({ version: 2, sessions: null }), JSON.stringify({ version: 99, sessions: {} }), "x".repeat(16 * 1024 * 1024 + 1)]) {
await fs.writeFile(file, content);
await expect(store.saveToolPreference(path.join(cwd, "a.jsonl"), { toolPreset: "readonly" })).rejects.toThrow();
expect(await fs.readFile(file, "utf8")).toBe(content);
}
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
