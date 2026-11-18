import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recycleFixture } from "./fixtures/recycle";
import { SessionDiskTracker } from "../src/lib/session-disk-sync";

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return { ...actual, readSync: vi.fn(actual.readSync) };
});

let root: string;
let file: string;
const row = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text } });
const base = row("base", "original");
const line = (value: unknown) => JSON.stringify(value) + "\n";
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-disk-sync-"));
	file = path.join(root, "session.jsonl");
	await fs.writeFile(file, line(base));
});
afterEach(async () => { await recycleFixture(root); vi.clearAllMocks(); });

it("does not read unchanged files, ignores own complete appends and detects same-ID changed append content", async () => {
	const tracker = new SessionDiskTracker(file);
	const own = row("own", "new message");
	const memory = new Map([[base.id, base], [own.id, own]]);
	const get = (id: string) => memory.get(id);
	vi.mocked(readSync).mockClear();
	expect(tracker.check(get)).toBe(0);
	expect(readSync).not.toHaveBeenCalled();
	await fs.appendFile(file, line(own));
	expect(tracker.check(get)).toBe(0);
	await fs.appendFile(file, line(row(own.id, "edited message")));
	expect(tracker.check(get)).toBe(1);
});

it("detects same-size edits and atomic replacements retaining IDs and modification time", async () => {
	const tracker = new SessionDiskTracker(file);
	const changed = line(row(base.id, "modified"));
	expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(line(base)));
	await fs.writeFile(file, changed);
	await fs.utimes(file, new Date(), new Date(Date.now() + 1000));
	expect(tracker.check(() => base)).toBe(1);
	expect(tracker.check(() => base)).toBe(0);
	const stat = await fs.stat(file);
	const replacement = path.join(root, "replacement.jsonl");
	await fs.writeFile(replacement, line(base));
	await fs.utimes(replacement, stat.atime, stat.mtime);
	await fs.rename(replacement, file);
	expect(tracker.check(() => base)).toBe(1);
});

it("caps each tail check and resumes an unfinished giant row without allocating its complete JSON", async () => {
	const tracker = new SessionDiskTracker(file);
	const giant = row("external-large", "x".repeat(9 * 1024 * 1024));
	await fs.appendFile(file, line(giant));
	vi.mocked(readSync).mockClear();
	expect(tracker.check((id) => id === base.id ? base : undefined)).toBe(0);
	const requested = vi.mocked(readSync).mock.calls.reduce((sum, call) => sum + Number((call as unknown[])[3]), 0);
	expect(requested).toBeLessThanOrEqual(8 * 1024 * 1024 + 32 * 1024);
	expect(tracker.checkedThrough).toBe(Buffer.byteLength(line(base)));
	expect(tracker.check((id) => id === base.id ? base : undefined)).toBe(1);
	expect(tracker.checkedThrough).toBe((await fs.stat(file)).size);
	vi.mocked(readSync).mockClear();
	expect(tracker.check(() => undefined)).toBe(0);
	expect(readSync).not.toHaveBeenCalled();
});

it("retains an incomplete UTF-8 row and discovers it only after its newline arrives", async () => {
	const tracker = new SessionDiskTracker(file);
	const message = Buffer.from(line(row("external", "中文消息")));
	const split = message.indexOf(Buffer.from("中")) + 1;
	await fs.appendFile(file, message.subarray(0, split));
	expect(tracker.check((id) => id === base.id ? base : undefined)).toBe(0);
	await fs.appendFile(file, message.subarray(split));
	expect(tracker.check((id) => id === base.id ? base : undefined)).toBe(1);
});

it("allows a new large own row and flags a later reused persisted ID without materializing either row", async () => {
	const tracker = new SessionDiskTracker(file, undefined, [base.id]);
	const own = row("own-large", "x".repeat(2 * 1024 * 1024));
	const get = (id: string) => id === own.id ? own : base;
	await fs.appendFile(file, line(own));
	expect(tracker.check(get)).toBe(0);
	await fs.appendFile(file, line(row(own.id, "y".repeat(2 * 1024 * 1024))));
	expect(tracker.check(get)).toBe(1);
});
