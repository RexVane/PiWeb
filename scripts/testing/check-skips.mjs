/** Keep unsupported-platform skips visible; missing Git/Windows isolation must fail CI. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windowsOnly = new Map([
	["tests/npm-install-transaction.test.ts", ["pins Windows npm ancestors during both asynchronous copy and package execution"]],
	["tests/project-settings-boundary.test.ts", ["pins Windows project settings ancestors through the synchronous commit"]],
	["tests/update-service-process.test.ts", ["reports a failed process-tree termination instead of claiming every descendant stopped"]],
	["tests/agent-resource-isolation.test.ts", [
		"finds a remembered trust decision whatever case pi wrote the key in",
	]],
	["tests/powershell-encoding.test.ts", ["decodes multilingual output without replacement characters"]],
]);
const posixOnly = new Map([
	["tests/recycle-bin.test.ts", [
		"creates restorable freedesktop metadata in an isolated XDG Trash",
		"recycles a long filename without overflowing the Trash metadata filename",
		"rejects a linked or public Linux Trash directory and retains the source",
	]],
]);
// 反向：只在 macOS 上成立的真实回收站用例，其他平台必须跳过。
const darwinOnly = new Map([
	["tests/integration/native-trash.test.ts", [
		"puts a file into the real Trash without a backup or body changes",
		"puts only a file link in Trash and retains the external target",
		"recycles a directory link itself rather than coercing it to its target",
		"recycles a skill directory intact, including its link rather than the link target",
	]],
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
				|| (platform === "win32" && posixOnly.get(file)?.includes(title))
				|| (platform !== "darwin" && darwinOnly.get(file)?.includes(title))
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
