import { describe, expect, it } from "vitest";
import { resolveDeniedAction } from "@/lib/agent-manager";
import { formatAclProbeFailure, selectAppContainerDesktop } from "@/lib/sandbox/windows-acl";

describe("Windows AppContainer desktop selection and probe diagnostics", () => {
	it("switches to WinSta0\\Default when running on a restricted WinSta0 sub-desktop and Default is openable", () => {
		expect(
			selectAppContainerDesktop({
				stationName: () => "WinSta0",
				threadDesktopName: () => "exebox-3MHWRWB55R5KCQQ2RSS2GRQDLS",
				canOpenDesktop: (name) => name === "Default",
			}),
		).toBe("WinSta0\\Default");
	});

	it("returns null when already on WinSta0\\Default or outside WinSta0 or when Default cannot be opened", () => {
		expect(
			selectAppContainerDesktop({
				stationName: () => "WinSta0",
				threadDesktopName: () => "Default",
				canOpenDesktop: () => true,
			}),
		).toBeNull();

		expect(
			selectAppContainerDesktop({
				stationName: () => "Service-0x0-3e7$",
				threadDesktopName: () => "Default",
				canOpenDesktop: () => true,
			}),
		).toBeNull();

		expect(
			selectAppContainerDesktop({
				stationName: () => "WinSta0",
				threadDesktopName: () => "exebox-isolated",
				canOpenDesktop: () => false,
			}),
		).toBeNull();
	});

	it("includes exit code and NTSTATUS hex formatting when probe output is empty or present", () => {
		const silentCrash = formatAclProbeFailure({ exitCode: 3221225794, output: "   " });
		expect(silentCrash).toContain("3221225794");
		expect(silentCrash).toContain("0xC0000142");

		const nullExit = formatAclProbeFailure({ exitCode: null, output: "" });
		expect(nullExit).toContain("unknown exit code");

		const withOutput = formatAclProbeFailure({ exitCode: 1, output: "  access denied \n" });
		expect(withOutput).toContain("access denied");
		expect(withOutput).toContain("exit code 1");
	});
});

describe("resolveDeniedAction fallback", () => {
	interface MockAction {
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}

	const firstBash: MockAction = { toolName: "bash", toolCallId: "call_bash_1", input: { command: "echo 1" } };
	const writeOut: MockAction = { toolName: "write", toolCallId: "call_write_1", input: { path: "D:/outside.txt" } };
	const latestBash: MockAction = { toolName: "bash", toolCallId: "call_bash_2", input: { command: "npm test" } };

	const state: { lastDeniedAction?: MockAction; deniedActions: Map<string, MockAction> } = {
		lastDeniedAction: writeOut,
		deniedActions: new Map<string, MockAction>([
			["call_bash_1", firstBash],
			["call_bash_2", latestBash],
			["call_write_1", writeOut],
		]),
	};

	it("prefers an exact call ID match", () => {
		expect(resolveDeniedAction(state, "call_bash_1")).toBe(firstBash);
	});

	it("falls back to the newest denied action matching a tool name such as \"bash\"", () => {
		expect(resolveDeniedAction(state, "bash")).toBe(latestBash);
		expect(resolveDeniedAction(state, " write ")).toBe(writeOut);
	});

	it("falls back to lastDeniedAction when id is omitted or blank", () => {
		expect(resolveDeniedAction(state, undefined)).toBe(writeOut);
		expect(resolveDeniedAction(state, "   ")).toBe(writeOut);
	});

	it("returns undefined for an unknown non-matching id so bogus IDs cannot approve unrelated actions", () => {
		expect(resolveDeniedAction(state, "call_nonexistent")).toBeUndefined();
	});
});
