import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ exitCode: 128 }));
vi.mock("@/lib/growth-service", () => ({ resolveGitBin: async () => "git" }));
vi.mock("node:child_process", async (original) => {
 const actual = await original<typeof import("node:child_process")>();
 const { EventEmitter } = await import("node:events");
 const { PassThrough } = await import("node:stream");
 return { ...actual, spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  queueMicrotask(() => {
   child.stdout.end("visible.txt\0");
   child.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
   setImmediate(() => child.emit("close", state.exitCode));
  });
  return child;
 } };
});
import { listWorkspaceDir } from "@/lib/files-service";

it.each([128, 0])("keeps files visible when git closes stdin early (exit %s)", async (code) => {
 state.exitCode = code;
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-ignore-pipe-"));
 try {
  await fs.writeFile(path.join(dir, "visible.txt"), "content");
  const result = await listWorkspaceDir(dir, "");
  expect(result.entries).toEqual([{ name: "visible.txt", kind: "file", size: 7 }]);
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
