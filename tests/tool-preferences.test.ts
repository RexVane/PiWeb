import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let agentDir: string;

beforeEach(async () => {
root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-tool-prefs-"));
agentDir = path.join(root, "agent");
await fs.mkdir(agentDir, { recursive: true });
vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
vi.resetModules();
});

afterEach(async () => {
vi.unstubAllEnvs();
await fs.rm(root, { recursive: true, force: true });
});

describe("global tool preferences", () => {
it("returns null before anything is saved", async () => {
const store = await import("../src/lib/tool-preferences");
expect(await store.readToolPreference()).toBeNull();
});

it("stores one global selection shared by every session", async () => {
const store = await import("../src/lib/tool-preferences");
await store.saveToolPreference({ toolPreset: "standard", customActiveTools: ["read", "bash", "codemode"] });
expect(await store.readToolPreference()).toMatchObject({
toolPreset: "standard",
customActiveTools: ["read", "bash", "codemode"],
});
// 再存一次只覆盖同一份全局配置，不会留下第二个会话维度
await store.saveToolPreference({ toolPreset: "full", customActiveTools: ["read"] });
expect(await store.readToolPreference()).toMatchObject({ toolPreset: "full", customActiveTools: ["read"] });
const raw = JSON.parse(await fs.readFile(path.join(agentDir, "web-tool-preferences.json"), "utf8"));
expect(raw.version).toBe(3);
expect(Object.keys(raw)).not.toContain("sessions");
});

it("deduplicates names and drops malformed entries instead of crashing", async () => {
const store = await import("../src/lib/tool-preferences");
await store.saveToolPreference({ toolPreset: "readonly", customActiveTools: ["read", "read", "grep"] });
const file = path.join(agentDir, "web-tool-preferences.json");
const raw = JSON.parse(await fs.readFile(file, "utf8"));
raw.global.customActiveTools = ["read", 42, null, "read", "grep"];
await fs.writeFile(file, JSON.stringify(raw));
expect(await store.readToolPreference()).toMatchObject({ toolPreset: "readonly", customActiveTools: ["read", "grep"] });
});

it("migrates the most recently used per-session entry from the older layout", async () => {
const store = await import("../src/lib/tool-preferences");
const file = path.join(agentDir, "web-tool-preferences.json");
await fs.writeFile(file, JSON.stringify({
version: 2,
sessions: {
"/a.jsonl": { toolPreset: "readonly", updatedAt: 10 },
"/b.jsonl": { toolPreset: "full", customActiveTools: ["read", "bash"], updatedAt: 20 },
},
}));
expect(await store.readToolPreference()).toMatchObject({ toolPreset: "full", customActiveTools: ["read", "bash"] });
});

it("ignores malformed entries and reports an unreadable file", async () => {
const store = await import("../src/lib/tool-preferences");
const file = path.join(agentDir, "web-tool-preferences.json");
await fs.writeFile(file, JSON.stringify({ version: 3, global: { toolPreset: "nope" } }));
expect(await store.readToolPreference()).toBeNull();
await fs.writeFile(file, "not json");
await expect(store.readToolPreference()).rejects.toThrow();
});

it("overwrites preset while clearing a previous custom list", async () => {
const store = await import("../src/lib/tool-preferences");
await store.saveToolPreference({ toolPreset: "full", customActiveTools: ["read"] });
await store.saveToolPreference({ toolPreset: "readonly" });
expect(await store.readToolPreference()).toMatchObject({ toolPreset: "readonly" });
expect((await store.readToolPreference())?.customActiveTools).toBeUndefined();
});
});
