import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { BoundaryError, isPathInside, resolveWorkspacePath } from "./path-security";
import { resolveProjectTrust } from "./pi";

const exec = promisify(execFile);
const running = new Set<string>();
const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const MAX_SOURCE_BYTES = 200_000;

export interface TestRunResult {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  success: boolean;
  tests: Array<{ name: string; status: string; durationMs: number }>;
  output: string;
}

async function testRoot(cwdValue: unknown): Promise<{ cwd: string; root: string }> {
  const cwd = await resolveWorkspacePath(cwdValue);
  const root = path.join(cwd, "tests");
  const real = await fs.realpath(root).catch(() => { throw new BoundaryError("tests directory not found"); });
  if (!isPathInside(cwd, real)) throw new BoundaryError("tests directory escapes workspace");
  return { cwd, root: real };
}
async function testFile(cwdValue: unknown, fileValue: unknown): Promise<{ cwd: string; file: string; relative: string }> {
  const { cwd, root } = await testRoot(cwdValue);
  if (typeof fileValue !== "string" || !TEST_NAME.test(fileValue) || fileValue.length > 4096) throw new BoundaryError("invalid test file");
  const file = await fs.realpath(path.resolve(cwd, fileValue)).catch(() => { throw new BoundaryError("test file not found"); });
  if (!isPathInside(root, file)) throw new BoundaryError("test file escapes tests directory");
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new BoundaryError("test file is too large");
  return { cwd, file, relative: path.relative(cwd, file).replace(/\\/g, "/") };
}
export async function listTestFiles(cwdValue: unknown): Promise<string[]> {
  const { cwd, root } = await testRoot(cwdValue);
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (files.length >= 500) break;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && TEST_NAME.test(entry.name)) files.push(path.relative(cwd, candidate).replace(/\\/g, "/"));
    }
  }
  await walk(root);
  return files.sort();
}
export async function readTestFile(cwdValue: unknown, fileValue: unknown): Promise<{ file: string; content: string }> {
  const { file, relative } = await testFile(cwdValue, fileValue);
  return { file: relative, content: await fs.readFile(file, "utf8") };
}
export function summarizeVitestReport(data: any, stdout: string, stderr: string): Pick<TestRunResult, "passed" | "failed" | "skipped" | "tests" | "output"> {
  const suites = Array.isArray(data?.testResults) ? data.testResults : [];
  const tests = suites.flatMap((suite: any) => Array.isArray(suite?.assertionResults)
    ? suite.assertionResults.map((test: any) => ({ name: String(test.fullName ?? test.title ?? ""), status: String(test.status ?? "unknown"), durationMs: Number(test.duration ?? 0) }))
    : []);
  const failures = suites.flatMap((suite: any) => [
    ...(suite?.message ? [String(suite.message)] : []),
    ...(Array.isArray(suite?.assertionResults) ? suite.assertionResults.flatMap((test: any) => Array.isArray(test?.failureMessages) ? test.failureMessages.map(String) : []) : []),
  ]);
  return {
    passed: Number(data?.numPassedTests ?? tests.filter((test: { status: string }) => test.status === "passed").length),
    failed: Number(data?.numFailedTests ?? tests.filter((test: { status: string }) => test.status === "failed").length),
    skipped: Number(data?.numPendingTests ?? 0),
    tests,
    output: `${data ? failures.join("\n\n") : stdout}\n${stderr}`.trim().slice(-20_000),
  };
}
export async function runTestFile(cwdValue: unknown, fileValue: unknown): Promise<TestRunResult> {
  const { cwd, relative } = await testFile(cwdValue, fileValue);
  if (!resolveProjectTrust(cwd).trusted) throw new BoundaryError("trust this project before running tests");
  if (running.has(cwd)) throw new BoundaryError("a test run is already active for this workspace");
  running.add(cwd);
  const started = Date.now();
  const reportFile = path.join(os.tmpdir(), `piweb-vitest-${randomUUID()}.json`);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const vitest = await fs.realpath(path.join(cwd, "node_modules", "vitest", "vitest.mjs")).catch(() => {
      throw new BoundaryError("local Vitest is not installed in this workspace");
    });
    if (!isPathInside(path.join(cwd, "node_modules"), vitest)) throw new BoundaryError("Vitest entry escapes node_modules");
    try {
      const result = await exec(process.execPath, [vitest, "run", relative, "--reporter=json", `--outputFile=${reportFile}`], {
        cwd, timeout: 180_000, maxBuffer: 2_000_000, windowsHide: true,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string };
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? String(error);
      exitCode = typeof failure.code === "number" ? failure.code : 1;
    }
    let data: any = null;
    try { data = JSON.parse(await fs.readFile(reportFile, "utf8")); } catch { /* preserve raw output below */ }
    return {
      file: relative,
      durationMs: Date.now() - started,
      success: exitCode === 0 && data?.success === true,
      ...summarizeVitestReport(data, stdout, stderr),
    };
  } finally {
    running.delete(cwd);
    await fs.rm(reportFile, { force: true }).catch(() => undefined);
  }
}
