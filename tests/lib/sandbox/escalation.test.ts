/**
 * 升权工具：批准 → 记一次授权；拒绝 / 无应答 → 什么都不给。
 *
 * 以及 bash 工具的执行决策：档位 + 升权 → 走本地、走 workspace 沙箱、还是走只读沙箱。
 * 后者用 mock 掉 sandboxFor 来断言"到底选了哪个模式"，不真起进程。
 */
import { describe, expect, it, vi } from "vitest";
import type { AskOutcome } from "@/lib/ask-user";

const sandboxFor = vi.fn(async (_sessionPath: string, _cwd: string, request: { mode: string; extraRoots?: string[] }) => ({
	sandbox: { exec: vi.fn(async () => ({ exitCode: 0 })) },
	tempDir: "C:\\tmp",
	...(request ? {} : {}),
}));
const readSandboxConfig = vi.fn(async () => ({ additionalWritableRoots: ["D:\\shared"] }));

vi.mock("@/lib/sandbox/manager", () => ({ sandboxFor, probeSandboxSupport: vi.fn(async () => true), sandboxSupported: () => true }));
vi.mock("@/lib/sandbox/config", () => ({ readSandboxConfig, writeSandboxConfig: vi.fn() }));

const { createPermissionRequestTool } = await import("@/lib/permission-request-tool");
const { createSandboxBashOperations } = await import("@/lib/sandbox/bash-operations");

const ask = (outcome: AskOutcome) => async () => outcome;
const approved = (label: string): AskOutcome => ({ status: "answered", answers: [{ selected: [label] }] });

describe("request_permission", () => {
	it("grants the requested scope only when the user approves", async () => {
		const grant = vi.fn();
		const record = vi.fn();
		const questionsSeen: { question: string }[][] = [];
		const tool = createPermissionRequestTool({
			ask: async (questions) => {
				questionsSeen.push(questions);
				return approved("允许一次（推荐）");
			},
			grant,
			record,
			preset: () => "workspace",
			deniedAction: () => ({ toolName: "bash", input: { command: "echo outside" }, toolCallId: "denied-1" }),
		});
		const result = await (tool.execute as any)("call-1", { reason: "需要写 .git", scope: "full" }, undefined);
		expect(questionsSeen[0][0].question).toContain("工作区内修改");
		expect(questionsSeen[0][0].question).not.toContain("「workspace」");
		expect(grant).toHaveBeenCalledWith("full", { toolName: "bash", input: { command: "echo outside" }, toolCallId: "denied-1" });
		expect(result.content[0].text).toContain('scope "full"');
		expect(result.details).toMatchObject({ granted: "full" });
		expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: "decision", outcome: "approved", scope: "full", preset: "workspace" }));
	});

	it("grants nothing when the user declines or never answers", async () => {
		for (const outcome of [approved("拒绝"), { status: "skipped" } as AskOutcome, { status: "timeout" } as AskOutcome, { status: "unavailable" } as AskOutcome]) {
			const grant = vi.fn();
			const record = vi.fn();
			const tool = createPermissionRequestTool({ ask: ask(outcome), grant, record, preset: () => "readonly", deniedAction: () => ({ toolName: "bash", input: { command: "echo outside" }, toolCallId: "denied-1" }) });
			const result = await (tool.execute as any)("call-1", { reason: "x", scope: "workspace" }, undefined);
			expect(grant).not.toHaveBeenCalled();
			expect(result.details).toMatchObject({ granted: null });
			expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: "decision", approved: false }));
		}
	});
});

describe("bash operations 的执行决策", () => {
	const run = async (preset: string, grant: "workspace" | "full" | null) => {
		sandboxFor.mockClear();
		readSandboxConfig.mockClear();
		const operations = createSandboxBashOperations({
			sessionPath: "s.jsonl",
			cwd: "C:\\ws",
			preset: () => preset as never,
			consumeGrant: () => grant,
		});
		// full 走本地执行，C:\ws 不存在会抛错——这里只关心"有没有进沙箱"，所以吞掉
		await operations.exec("echo hi", "C:\\ws", { onData: () => {} }).catch(() => undefined);
		return sandboxFor.mock.calls.at(-1)?.[2];
	};

	it("runs without the sandbox at the full preset", async () => {
		await run("full", null);
		expect(sandboxFor).not.toHaveBeenCalled();
	});

	it("uses the writable sandbox at the workspace preset and passes extra roots", async () => {
		const request = await run("workspace", null);
		expect(request).toMatchObject({ mode: "workspace", extraRoots: ["D:\\shared"] });
	});

	it("uses the read-only sandbox at the readonly preset", async () => {
		const request = await run("readonly", null);
		expect(request).toMatchObject({ mode: "readonly", extraRoots: [] });
	});

	it("lets a one-shot grant widen the current preset for exactly one command", async () => {
		expect(await run("readonly", "workspace")).toMatchObject({ mode: "workspace" });
		expect(await run("workspace", "full")).toBeUndefined(); // full 升权 = 绕开沙箱，直接本地执行
		expect(sandboxFor).not.toHaveBeenCalled();
	});
});

describe("bash operations 与 pi 的 BashOperations 约定", () => {
	const withResult = (result: Record<string, unknown>) => {
		const exec = vi.fn(async (_command: string, _options: { timeout?: number }) => result);
		sandboxFor.mockImplementationOnce(async () => ({ sandbox: { exec }, tempDir: "C:\\tmp" }) as never);
		const operations = createSandboxBashOperations({ sessionPath: "s.jsonl", cwd: "C:\\ws", preset: () => "workspace" });
		return { exec, operations };
	};

	it("converts pi's timeout in seconds to the sandbox's milliseconds", async () => {
		const { exec, operations } = withResult({ exitCode: 0 });
		await expect(operations.exec("echo hi", "C:\\ws", { onData: () => {}, timeout: 30 })).resolves.toEqual({ exitCode: 0 });
		expect(exec.mock.calls[0][1].timeout).toBe(30_000);
	});

	it("leaves the timeout unset when pi gives none", async () => {
		const { exec, operations } = withResult({ exitCode: 0 });
		await operations.exec("echo hi", "C:\\ws", { onData: () => {} });
		expect(exec.mock.calls[0][1].timeout).toBeUndefined();
	});

	it("reports abort and timeout with the messages pi's bash tool recognises", async () => {
		const aborted = withResult({ exitCode: null, aborted: true });
		await expect(aborted.operations.exec("x", "C:\\ws", { onData: () => {} })).rejects.toThrow(/^aborted$/);
		const timedOut = withResult({ exitCode: null, timedOut: true });
		await expect(timedOut.operations.exec("x", "C:\\ws", { onData: () => {}, timeout: 7 })).rejects.toThrow(/^timeout:7$/);
	});

	it("returns the real exit code when the sandbox stopped forwarding oversized output", async () => {
		const { operations } = withResult({ exitCode: 0, outputLimitExceeded: true });
		await expect(operations.exec("x", "C:\\ws", { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
	});

	it("honours settings.shellPath at the full preset", async () => {
		const operations = createSandboxBashOperations({ sessionPath: "s.jsonl", cwd: "C:\\ws", preset: () => "full", shellPath: "C:\\piweb-missing\\bash.exe" });
		await expect(operations.exec("echo hi", process.cwd(), { onData: () => {} })).rejects.toThrow("Custom shell path not found");
	});
});
