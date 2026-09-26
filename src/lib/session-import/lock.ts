import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

const pending = new Map<string, Promise<void>>();

export async function withImportLock<T>(agentDir: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(agentDir, { recursive: true });
  const real = await fs.realpath(agentDir);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  const previous = pending.get(key) ?? Promise.resolve();
  const result = previous.then(async () => {
    // Serialize the global provenance lookup and write, including across server processes.
    const release = await lockfile.lock(path.join(real, "piweb-session-import"), {
      realpath: false, stale: 120_000,
      retries: { retries: 60, minTimeout: 100, maxTimeout: 500 },
    });
    try { return await operation(); }
    finally { await release(); }
  });
  const settled = result.then(() => undefined, () => undefined);
  pending.set(key, settled);
  void settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
  return result;
}
