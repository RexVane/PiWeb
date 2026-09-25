import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { BoundaryError } from "../src/lib/path-security";
import { listTestFiles, readTestFile, runTestFile, summarizeVitestReport } from "../src/lib/test-run-service";
import { getSwarm, resolveSwarmToolPath, startSwarm } from "../src/lib/swarm-service";

describe("frontend backend bridge", () => {
  const cwd = process.cwd();

  it("discovers and reads only test files inside the workspace", async () => {
    const files = await listTestFiles(cwd);
    expect(files).toContain("tests/semver.test.ts");
    const source = await readTestFile(cwd, "tests/semver.test.ts");
    expect(source.file).toBe("tests/semver.test.ts");
    expect(source.content).toContain("describe");
    await expect(readTestFile(cwd, "../outside.test.ts")).rejects.toBeInstanceOf(BoundaryError);
    await expect(readTestFile(cwd, "src/lib/pi.ts")).rejects.toBeInstanceOf(BoundaryError);
    await expect(readTestFile(cwd, path.join(cwd, "src", "lib", "pi.ts"))).rejects.toBeInstanceOf(BoundaryError);
  });

  it("rejects unbounded swarm requests before starting workers", async () => {
    await expect(startSwarm(cwd, [])).rejects.toBeInstanceOf(BoundaryError);
    await expect(startSwarm(cwd, [{ title: "", instruction: "x" }])).rejects.toBeInstanceOf(BoundaryError);
    await expect(startSwarm(cwd, Array.from({ length: 4 }, () => ({ title: "x", instruction: "x" })))).rejects.toBeInstanceOf(BoundaryError);
    await expect(getSwarm("../../secret")).rejects.toBeInstanceOf(BoundaryError);
  });

  it("keeps worker file tools inside their isolated root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-tool-boundary-"));
    try {
      expect(await resolveSwarmToolPath(root, "src/new.ts")).toBe(path.join(root, "src", "new.ts"));
      await expect(resolveSwarmToolPath(root, "../outside.ts")).rejects.toBeInstanceOf(BoundaryError);
      await expect(resolveSwarmToolPath(root, ".git/config")).rejects.toBeInstanceOf(BoundaryError);
      await expect(resolveSwarmToolPath(root, "node_modules/pkg/index.js")).rejects.toBeInstanceOf(BoundaryError);
    } finally {
      const base = path.resolve(os.tmpdir());
      if (root.startsWith(`${base}${path.sep}`)) await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs a selected Vitest file and returns real assertions", async () => {
    const result = await runTestFile(cwd, "tests/semver.test.ts");
    expect(result.success).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(0);
    expect(result.tests.length).toBe(result.passed);
  }, 60_000);

  it("allows only one test run per workspace", async () => {
    const results = await Promise.allSettled([
      runTestFile(cwd, "tests/semver.test.ts"),
      runTestFile(cwd, "tests/semver.test.ts"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toContain("already active");
  }, 60_000);

  it("includes suite-level loading errors in the test output", () => {
    const result = summarizeVitestReport({
      numPassedTests: 0,
      numFailedTests: 0,
      testResults: [{ status: "failed", message: "Cannot load module", assertionResults: [] }],
    }, "", "");
    expect(result.output).toContain("Cannot load module");
  });
});
