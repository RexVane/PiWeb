import { DefaultResourceLoader, SessionManager, createAgentSession, defineTool, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentDir, getModelRuntime, getSettingsManager, TOOL_PRESETS, withResourceLock } from "./pi";

const MAX_TASKS = 3;
const TASK_TIMEOUT_MS = 120_000;
const MAX_REPORT_CHARS = 12_000;

const parameters = Type.Object({
	tasks: Type.Array(Type.Object({
		title: Type.String({ minLength: 1, maxLength: 80 }),
		instruction: Type.String({ minLength: 1, maxLength: 4_000 }),
	}), { minItems: 1, maxItems: MAX_TASKS }),
});

function reportOf(session: AgentSession): string {
	const answer = [...session.messages].reverse().find((message) => message.role === "assistant");
	if (!answer || answer.role !== "assistant") return "The subagent returned no assistant answer.";
	return answer.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, MAX_REPORT_CHARS) || "The subagent returned no text answer.";
}

async function runSubagent(cwd: string, parent: AgentSession, instruction: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new Error("Delegation cancelled");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager: getSettingsManager(cwd),
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPrompt: ["You are a read-only PiWeb subagent. Investigate the assigned task and return a concise, evidence-based report. Do not modify files or run commands. Do not delegate further."],
	});
	let child: AgentSession | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const abort = () => { void child?.abort().catch(() => undefined); };
	try {
		await withResourceLock(() => loader.reload());
		if (signal?.aborted) throw new Error("Delegation cancelled");
		const created = await createAgentSession({
			cwd,
			agentDir: getAgentDir(),
			sessionManager: SessionManager.inMemory(cwd),
			modelRuntime: await getModelRuntime(),
			model: parent.model ?? undefined,
			thinkingLevel: parent.thinkingLevel,
			settingsManager: getSettingsManager(cwd),
			resourceLoader: loader,
			tools: TOOL_PRESETS.readonly,
		});
		child = created.session;
		if (signal?.aborted) throw new Error("Delegation cancelled");
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => { timedOut = true; abort(); }, TASK_TIMEOUT_MS);
		await child.prompt(instruction, { source: "rpc", expandPromptTemplates: false });
		if (timedOut) throw new Error("Subagent timed out after two minutes");
		if (signal?.aborted) throw new Error("Delegation cancelled");
		return reportOf(child);
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		child?.dispose();
		loader.getExtensions().runtime.invalidate();
	}
}

export function createDelegationTool(cwd: string, parent: () => AgentSession | null): ToolDefinition {
	return defineTool({
		name: "piweb_delegate",
		label: "Delegate research",
		description: "Delegate one to three independent, read-only research or review tasks to temporary Pi subagents. They cannot edit files, run shell commands, or delegate further. Use only when parallel investigation is useful; summarize their findings yourself.",
		promptSnippet: "Delegate bounded, read-only research tasks to temporary subagents.",
		parameters,
		executionMode: "sequential",
		async execute(_id, { tasks }, signal, onUpdate) {
			const leader = parent();
			if (!leader) throw new Error("Parent session is unavailable");
			const reports: string[] = new Array(tasks.length);
			await Promise.all(tasks.map(async (task, index) => {
				try {
					const report = await runSubagent(cwd, leader, task.instruction, signal);
					reports[index] = `## ${task.title}\n${report}`;
				} catch (error) {
					reports[index] = `## ${task.title}\nFailed: ${String((error as Error)?.message ?? error)}`;
				}
				onUpdate?.({ content: [{ type: "text", text: reports.filter(Boolean).join("\n\n") }], details: undefined });
			}));
			if (signal?.aborted) throw new Error("Delegation cancelled");
			const text = reports.join("\n\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}
