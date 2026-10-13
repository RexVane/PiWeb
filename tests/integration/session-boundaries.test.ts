import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { encodeSessionId } from "@/lib/pi";
import { deleteSession } from "@/lib/session-reader";
import { resolveSessionPath } from "@/lib/path-security";

it("accepts configured and canonical session paths when the agent directory is a junction", async () => {
 const previous = process.env.PI_CODING_AGENT_DIR;
 const temp = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-agent-alias-"));
 try {
  const actual = path.join(temp, "actual-agent");
  const alias = path.join(temp, "linked-agent");
  await fs.mkdir(path.join(actual, "sessions"), { recursive: true });
  await fs.writeFile(path.join(actual, "sessions", "existing.jsonl"), "{}\n");
  await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
  process.env.PI_CODING_AGENT_DIR = alias;
  const canonical = await fs.realpath(path.join(actual, "sessions", "existing.jsonl"));
  for (const agent of [alias, actual]) {
   const existing = path.join(agent, "sessions", "existing.jsonl");
   await expect(resolveSessionPath(encodeSessionId(existing))).resolves.toBe(canonical);
   await expect(resolveSessionPath(encodeSessionId(existing), { allowPending: true })).resolves.toBe(existing);
   const pending = path.join(agent, "sessions", "new-workspace", "pending.jsonl");
   await expect(resolveSessionPath(encodeSessionId(pending), { allowPending: true })).resolves.toBe(pending);
  }
  await deleteSession(canonical);
  await expect(fs.stat(canonical)).rejects.toMatchObject({ code: "ENOENT" });
 } finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await fs.rm(temp, { recursive: true, force: true });
 }
});
