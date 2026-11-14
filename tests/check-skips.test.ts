import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { unexpectedSkips } from "../scripts/testing/check-skips.mjs";

function report(file: string, title: string) { return { numTotalTests: 1, numPendingTests: 1, testResults: [{ name: path.resolve(file), assertionResults: [{ title, status: "pending" }] }] }; }
describe("CI skipped test guard", () => {
	it("allows known OS-specific skips only on the unsupported platform", () => {
		const sample = report("tests/atomic-confined-file-operations.test.ts", "pins Windows directories while creating and replacing files without a shell backend");
		expect(unexpectedSkips(sample, { platform: "linux" }).unexpected).toEqual([]);
		expect(unexpectedSkips(sample, { platform: "win32" }).unexpected).toHaveLength(1);
	});
	it("rejects new skips even in a file containing approved platform skips", () => {
		expect(unexpectedSkips(report("tests/lib/sandbox/windows-acl.test.ts", "new unsafe skipped test"), { platform: "linux" }).unexpected).toHaveLength(1);
	});
	it("accepts the current Windows-only regression titles on Linux and rejects obsolete or shell-fixture skips", () => {
		for (const [file, title] of [
			["tests/npm-install-transaction.test.ts", "pins Windows npm ancestors during both asynchronous copy and package execution"],
			["tests/lib/sandbox/windows-acl.test.ts", "does not expose API keys, credentials, PiWeb auth or internal locks through inherited or overridden environments"],
			["tests/lib/sandbox/windows-acl.test.ts", "stops forwarding output past the limit but lets the command finish"],
			["tests/lib/sandbox/manager.test.ts", "awaits an already-started release after its holder has left the pool"],
		]) expect(unexpectedSkips(report(file, title), { platform: "linux" }).unexpected).toEqual([]);
		expect(unexpectedSkips(report("tests/lib/sandbox/windows-acl.test.ts", "bounds total pipe output and kills a noisy command"), { platform: "linux" }).unexpected).toHaveLength(1);
		for (const platform of ["win32", "linux"] as const) expect(unexpectedSkips(report("tests/lib/sandbox/shell-selection.test.ts", "uses a native bash through a script file"), { platform }).unexpected).toHaveLength(1);
	});
	it("keeps literal titles in the wholly Windows-only suites synchronized without blanket file exemptions", () => {
		for (const file of ["tests/lib/sandbox/windows-acl.test.ts", "tests/lib/sandbox/manager.test.ts", "tests/lib/sandbox/readonly-mode.test.ts", "tests/atomic-confined-file-operations.test.ts"]) {
			const titles = [...fs.readFileSync(file, "utf8").matchAll(/\bit(?:\.skipIf\([^\n]*?\))?\("([^"]+)"/g)].map((match) => match[1]);
			expect(titles.length).toBeGreaterThan(0);
			for (const title of titles) expect(unexpectedSkips(report(file, title), { platform: "linux" }).unexpected, `${file}: ${title}`).toEqual([]);
		}
	});
	it("requires the prepared SDK search parity case in CI", () => {
		const sample = report("tests/mention-parity.test.ts", "各类查询逐条相等：空查询、文件名、限定目录、整条路径、smart case、正则字符");
		expect(unexpectedSkips(sample, { ci: true }).unexpected).toHaveLength(1);
		expect(unexpectedSkips(sample, { ci: false }).unexpected).toEqual([]);
	});
	it("requires the cross-platform native picker cases to execute on Windows", () => {
		expect(unexpectedSkips(report("tests/api/workspace-picker.test.ts", "registers a directory returned by the native process"), { platform: "win32" }).unexpected).toHaveLength(1);
	});
	it("allows only the dedicated remote job's case outside enabled network runs", () => {
		const sample = report("tests/remote-tunnel.integration.test.ts", "serves the LAN entry through a public https URL with the mobile CSS injected");
		expect(unexpectedSkips(sample, { tunnelEnabled: false }).unexpected).toEqual([]);
		expect(unexpectedSkips(sample, { tunnelEnabled: true }).unexpected).toHaveLength(1);
		expect(unexpectedSkips(report("tests/remote-tunnel.integration.test.ts", "unexecuted new network case"), { tunnelEnabled: false }).unexpected).toHaveLength(1);
	});
	it("rejects missing Git coverage and a mismatched report total", () => {
		const sample = report("tests/growth-service.test.ts", "never creates a repository just to read");
		expect(unexpectedSkips(sample).unexpected).toHaveLength(1);
		expect(() => unexpectedSkips({ ...sample, numPendingTests: 0 })).toThrow("count");
	});
	it("permits env-proxy capability skips on older supported Node versions", () => {
		const sample = report("tests/system-proxy.test.ts", "routes a real fetch through the detected proxy without external network access");
		expect(unexpectedSkips(sample, { nodeVersion: "22.19.0" }).unexpected).toEqual([]);
		expect(unexpectedSkips(sample, { nodeVersion: "24.0.0" }).unexpected).toHaveLength(1);
	});
});
