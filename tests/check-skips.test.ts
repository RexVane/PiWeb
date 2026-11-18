import path from "node:path";
import { describe, expect, it } from "vitest";
import { unexpectedSkips } from "../scripts/testing/check-skips.mjs";

function report(file: string, title: string) { return { numTotalTests: 1, numPendingTests: 1, testResults: [{ name: path.resolve(file), assertionResults: [{ title, status: "pending" }] }] }; }
describe("CI skipped test guard", () => {
	it("allows known OS-specific skips only on the unsupported platform", () => {
		const sample = report("tests/npm-install-transaction.test.ts", "pins Windows npm ancestors during both asynchronous copy and package execution");
		expect(unexpectedSkips(sample, { platform: "linux" }).unexpected).toEqual([]);
		expect(unexpectedSkips(sample, { platform: "win32" }).unexpected).toHaveLength(1);
	});
	it("rejects new skips even in a file containing approved platform skips", () => {
		expect(unexpectedSkips(report("tests/npm-install-transaction.test.ts", "new unsafe skipped test"), { platform: "linux" }).unexpected).toHaveLength(1);
	});
	it("accepts the current Windows-only regression titles on Linux and rejects obsolete skips", () => {
		for (const [file, title] of [
			["tests/npm-install-transaction.test.ts", "pins Windows npm ancestors during both asynchronous copy and package execution"],
			["tests/project-settings-boundary.test.ts", "pins Windows project settings ancestors through the synchronous commit"],
			["tests/update-service-process.test.ts", "reports a failed process-tree termination instead of claiming every descendant stopped"],
		]) expect(unexpectedSkips(report(file, title), { platform: "linux" }).unexpected).toEqual([]);
		expect(unexpectedSkips(report("tests/npm-install-transaction.test.ts", "bounds total pipe output and kills a noisy command"), { platform: "linux" }).unexpected).toHaveLength(1);
		for (const platform of ["win32", "linux"] as const) expect(unexpectedSkips(report("tests/npm-install-transaction.test.ts", "obsolete skipped test"), { platform }).unexpected).toHaveLength(1);
	});
	it("allows the Windows-only PowerShell encoding case on non-Windows runners", () => {
		const sample = report("tests/powershell-encoding.test.ts", "decodes multilingual output without replacement characters");
		expect(unexpectedSkips(sample, { platform: "linux" }).unexpected).toEqual([]);
		expect(unexpectedSkips(sample, { platform: "win32" }).unexpected).toHaveLength(1);
	});
	it("allows the case-insensitive trust decision regression on non-Windows runners", () => {
		const sample = report("tests/agent-resource-isolation.test.ts", "finds a remembered trust decision whatever case pi wrote the key in");
		expect(unexpectedSkips(sample, { platform: "linux" }).unexpected).toEqual([]);
		expect(unexpectedSkips(sample, { platform: "win32" }).unexpected).toHaveLength(1);
		expect(unexpectedSkips(report("tests/agent-resource-isolation.test.ts", "unregistered new platform skip"), { platform: "linux" }).unexpected).toHaveLength(1);
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
