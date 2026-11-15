/** Keep unsupported-platform skips visible; missing Git/Windows isolation must fail CI. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windowsOnly = new Map([
	["tests/npm-install-transaction.test.ts", ["pins Windows npm ancestors during both asynchronous copy and package execution"]],
	["tests/project-settings-boundary.test.ts", ["pins Windows project settings ancestors through the synchronous commit"]],
	["tests/update-service-process.test.ts", ["reports a failed process-tree termination instead of claiming every descendant stopped"]],
	["tests/lib/sandbox/windows-acl.test.ts", [
		"writes an allowed file with the actual isolated Node runtime",
		"starts its private Node helper independently of inherited launcher preloads",
		"pins an authorized root until its own ACL is revoked",
		"honors timeouts while a command continuously fills its output pipes",
		"blocks shell and Node writes to existing user-owned outside files",
		"reads an explicitly allowed root without granting write access",
		"streams shell output and transports literal/large environments",
		"does not expose API keys, credentials, PiWeb auth or internal locks through inherited or overridden environments",
		"uses different SIDs for different sessions even on formerly Low roots",
		"cannot gain outside write rights by changing an outside DACL as its owner",
		"does not grant a junction's external target during creation",
		"fails closed for an existing hard link without changing the external object ACL",
		"cannot create a writable hard link to a readable external object",
		"preserves original labels and other active sandbox SID grants on disposal",
		"terminates detached descendants on timeout", "terminates detached descendants on abort", "terminates detached descendants on dispose", "terminates detached descendants on shell-exit",
		"stops forwarding output past the limit but lets the command finish",
		"cleans staged scripts after spawner failure and handles an already-aborted signal",
		"fails closed for a missing or nonphysical writable root",
		"supports a writable private temp without letting readonly use it",
		"fails closed for a native Bash runtime instead of weakening global object isolation",
	]],
	["tests/lib/sandbox/readonly-mode.test.ts", ["still runs read-only commands", "refuses writes inside the workspace too", "refuses writes outside and outside temp usage", "reads explicitly allowed files", "cannot write a root that another workspace sandbox has made writable"]],
	["tests/lib/sandbox/manager.test.ts", ["probes actual runtime support and reports a reason when unavailable", "reuses only an identical session/cwd/roots/shell configuration", "gives readonly its readable workspace while denying file writes", "does not remove a replacement instance's scratch while an older release finishes", "disposes a creation that was invalidated while it was pending", "awaits an already-started release after its holder has left the pool"]],
	["tests/atomic-confined-file-operations.test.ts", ["pins Windows directories while creating and replacing files without a shell backend", "edits source in a pnpm-style hard-linked workspace without changing dependency ACLs", "prevents ancestor replacement during an in-flight Windows write", "rejects readonly and outside junction writes without starting a Windows command", "keeps the original file when permission is lowered before atomic replacement"]],
	["tests/agent-resource-isolation.test.ts", [
		"runs workspace-tier bash through the OS sandbox: inside writes land, outside writes are refused",
		"finds a remembered trust decision whatever case pi wrote the key in",
	]],
	["tests/powershell-encoding.test.ts", ["decodes multilingual output without replacement characters"]],
	["tests/lib/permission-gate.test.ts", ["treats a differently cased drive/path as the same location on Windows"]],
]);
export function unexpectedSkips(report, { platform = process.platform, nodeVersion = process.versions.node, cwd = process.cwd(), tunnelEnabled = process.env.PIWEB_TEST_TUNNEL === "1", ci = /^(1|true)$/i.test(process.env.CI ?? "") } = {}) {
	if (!report || !Array.isArray(report.testResults) || !(report.numTotalTests > 0)) throw new Error("Missing or empty Vitest report");
	const [major, minor] = nodeVersion.split(".").map(Number);
	const envProxySupported = major >= 24 || (major === 22 && minor >= 21);
	const unexpected = [];
	const skipped = [];
	for (const suite of report.testResults) {
		if (!Array.isArray(suite.assertionResults)) throw new Error("Invalid test assertions in Vitest report");
		const file = path.relative(cwd, suite.name).replaceAll("\\", "/");
		for (const test of suite.assertionResults) {
			if (!["pending", "skipped", "todo"].includes(test.status)) continue;
			const title = test.title;
			const label = `${file}: ${title}`;
			skipped.push(label);
			const allowed = test.status !== "todo" && (
				(platform !== "win32" && windowsOnly.get(file)?.includes(title))
				// remote-e2e.yml executes this exact case on both platforms with
				// PIWEB_TEST_TUNNEL=1; an enabled network run must never skip it.
				|| (!tunnelEnabled && file === "tests/remote-tunnel.integration.test.ts" && title === "serves the LAN entry through a public https URL with the mobile CSS injected")
				|| (platform === "win32" && file === "tests/growth-service.test.ts" && title === "force-removes tracked paths replaced by symbolic links")
				|| (!ci && file === "tests/mention-parity.test.ts" && title === "各类查询逐条相等：空查询、文件名、限定目录、整条路径、smart case、正则字符")
				|| (!envProxySupported && file === "tests/system-proxy.test.ts" && title === "routes a real fetch through the detected proxy without external network access")
				|| (!envProxySupported && file === "tests/proxy-status.test.ts" && title === "uses the real probe to report a closed local proxy instead of reaching the target directly")
			);
			if (!allowed) unexpected.push(label);
		}
	}
	if (skipped.length !== report.numPendingTests) throw new Error("Skipped test count does not match Vitest assertions");
	return { unexpected, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const file = process.env.PIWEB_TEST_REPORT;
	if (!file) throw new Error("PIWEB_TEST_REPORT must identify the complete CI test report");
	const result = unexpectedSkips(JSON.parse(fs.readFileSync(file, "utf8")));
	for (const skipped of result.skipped) console.log(`[skipped] ${skipped}`);
	if (result.unexpected.length) throw new Error(`Unexpected skipped tests:\n${result.unexpected.join("\n")}`);
	console.log(`[ci] ${result.skipped.length} approved platform/capability skips; all other tests executed`);
}
