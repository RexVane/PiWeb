import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it("executes an exact test specification while retaining workspace aliases and setup", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-exact-test-")));
  try {
    await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "junction");
    await fs.mkdir(path.join(root, "tests/nested/tests"), { recursive: true });
    await fs.writeFile(path.join(root, "value.js"), "export const value = 42;\n");
    await fs.writeFile(path.join(root, "setup.js"), "globalThis.exactSetup = true;\n");
    await fs.writeFile(path.join(root, "vitest.config.mjs"), `export default { resolve: { alias: { '#value': ${JSON.stringify(path.join(root, "value.js").replaceAll("\\", "/"))} } }, test: { include: ['tests/**/*.test.{ts,tsx}'], setupFiles: ['./setup.js'], maxWorkers: 1 } };\n`);
    const selected = path.join(root, "tests/a.test.ts");
    await fs.writeFile(selected, "import { test, expect } from 'vitest'; import { value } from '#value'; test('exact target', () => { expect(value).toBe(42); expect(globalThis.exactSetup).toBe(true); });\n");
    for (const relative of ["tests/a.test.tsx", "tests/nested/tests/a.test.ts"]) {
      await fs.writeFile(path.join(root, relative), "throw new Error('UNSELECTED_FILE_EXECUTED');\n");
    }
    const report = path.join(root, "report.json");
    await exec(process.execPath, [path.join(process.cwd(), "scripts/run-test-file.mjs"), root, selected, report], {
      cwd: root, timeout: 60_000, windowsHide: true, env: { ...process.env, CI: "1" },
    });
    const result = JSON.parse(await fs.readFile(report, "utf8"));
    expect(result.success).toBe(true);
    expect(result.numPassedTests).toBe(1);
    expect(result.testResults).toHaveLength(1);
    expect(result.testResults[0].name.replaceAll("\\", "/")).toBe(selected.replaceAll("\\", "/"));
  } finally {
    const base = await fs.realpath(os.tmpdir());
    if (!root.startsWith(`${base}${path.sep}piweb-exact-test-`)) throw new Error("unexpected fixture path");
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
