import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { runToolCall, type AgentEvent, type AgentToolCall, type AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type Scope = { id: string; signal: AbortSignal; root: { active: boolean; calls: number }; depth: number; holdsQueue: boolean; parentId?: string };
const MAX_CALLS = 256;
const MAX_DEPTH = 16;

/** A user resource action uses the public SDK tool pipeline without creating model history. */
export function createResourceToolDispatcher(session: AgentSession, options: {
	isCurrent(): boolean;
	emit(event: AgentEvent & { parentToolCallId?: string }): void;
}) {
	const runner = session.extensionRunner;
	const local = new AsyncLocalStorage<Scope>();
	let nestedQueueTail = Promise.resolve();
	const createContext = runner.createContext.bind(runner);
	const createToolContext = runner.createToolContext.bind(runner);
	const current = (scope: Scope) => scope.root.active && !scope.signal.aborted && options.isCurrent();
	const errorOutcome = (id: string, name: string, args: unknown, message: string): AgentToolCallOutcome => ({
		toolCall: { id, type: "toolCall", name, arguments: args as AgentToolCall["arguments"] },
		isError: true, result: { content: [{ type: "text", text: message }], details: {} },
	});
	const uiFor = (ui: ExtensionUIContext, scope: Scope): ExtensionUIContext => {
		const withSignal = (value?: { signal?: AbortSignal }) => ({ ...value,
			signal: value?.signal ? AbortSignal.any([scope.signal, value.signal]) : scope.signal,
		});
		return new Proxy(ui, { get(target, property) {
			if (["select", "confirm", "input", "editor"].includes(String(property))) {
				return (...args: unknown[]) => {
					if (!current(scope)) throw new Error("Resource tool interaction cancelled or replaced");
					const fn = Reflect.get(target, property) as (...values: unknown[]) => unknown;
					return fn.call(target, args[0], args[1], withSignal(args[2] as { signal?: AbortSignal } | undefined));
				};
			}
			if (property === "resources") {
				const resources = Reflect.get(target, property) as Record<string, unknown> | undefined;
				if (!resources) return resources;
				return new Proxy(resources, { get(api, method) {
					if (method === "request") return (resourceId: string, viewId: string, data: unknown, requestOptions?: { signal?: AbortSignal }) => {
						if (!current(scope)) return Promise.resolve({ status: "cancelled" });
						return (api.request as Function).call(api, resourceId, viewId, data, withSignal(requestOptions));
					};
					const value = Reflect.get(api, method);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						if (!current(scope)) throw new Error("Resource tool interaction cancelled or replaced");
						if (method === "executeTool") return value.call(api, args[0], args[1], withSignal(args[2] as { signal?: AbortSignal } | undefined));
						return value.apply(api, args);
					};
				} });
			}
			const value = Reflect.get(target, property);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (!current(scope)) throw new Error("Resource tool interaction cancelled or replaced");
				return value.apply(target, args);
			};
		} });
	};
	const scoped = <T extends ExtensionContext>(context: T, scope: Scope, callId?: string): T => Object.defineProperties({}, {
		...Object.getOwnPropertyDescriptors(context),
		signal: { configurable: true, get: () => scope.signal },
		ui: { configurable: true, get: () => uiFor(context.ui, scope) },
		...(callId ? { executeTool: { configurable: true, value: (name: string, args: unknown, nestedOptions?: { signal?: AbortSignal; onUpdate?: Function }) => {
			const signal = nestedOptions?.signal ? AbortSignal.any([scope.signal, nestedOptions.signal]) : scope.signal;
			return dispatch({ ...scope, depth: scope.depth + 1, signal }, name, args, callId, nestedOptions?.onUpdate);
		} } } : {}),
	}) as T;
	// These documented public context factories are session-local. Calls from the model retain
	// the original SDK context and dispatcher; only this AsyncLocalStorage operation is adapted.
	runner.createContext = () => { const context = createContext(); const scope = local.getStore(); return scope ? scoped(context, scope) : context; };
	runner.createToolContext = (id, signal) => {
		const context = createToolContext(id, signal); const scope = local.getStore();
		return scope ? scoped(context, scope, id) : context;
	};
	const emitToolCall = runner.emitToolCall.bind(runner);
	const emitToolResult = runner.emitToolResult.bind(runner);
	runner.emitToolCall = event => { const parentId = local.getStore()?.parentId; return emitToolCall(parentId ? { ...event, parentToolCallId: parentId } : event); };
	runner.emitToolResult = event => { const parentId = local.getStore()?.parentId; return emitToolResult(parentId ? { ...event, parentToolCallId: parentId } : event); };
	const emit = async (event: AgentEvent & { parentToolCallId?: string }, scope: Scope) => {
		if (!options.isCurrent()) return;
		await runner.emit(event as never);
		if (options.isCurrent()) options.emit(event);
	};
	const dispatch = async (scope: Scope, name: string, args: unknown, parentId?: string, update?: Function): Promise<AgentToolCallOutcome> => local.run({ ...scope, parentId }, async () => {
		const id = parentId ? `${parentId}/${++scope.root.calls}` : scope.id;
		if (!current(scope)) return errorOutcome(id, name, args, "Resource tool execution cancelled or replaced");
		if (scope.depth > MAX_DEPTH || scope.root.calls > MAX_CALLS) return errorOutcome(id, name, args, "Resource tool nesting limit exceeded");
		const context: ExtensionToolContext = createToolContext(id, scope.signal);
		const tools = context.tools;
		const call = { id, type: "toolCall" as const, name, arguments: args as AgentToolCall["arguments"] };
		// runToolCall requires an issuer carrier. This is explicitly a user resource action,
		// never a past model reply, and neither it nor the result is added to session history.
		const issuer: AssistantMessage = { role: "assistant", api: "piweb-resource", provider: "piweb",
			model: "user-resource-action", content: [{ type: "text", text: "User-initiated PiWeb resource operation." }, call],
			stopReason: "toolUse", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const parent = parentId ? { parentToolCallId: parentId } : {};
		await emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args, ...parent }, scope);
		let release: (() => void) | undefined;
		if (parentId && !scope.holdsQueue && (session.agent.toolExecution === "sequential" || tools.find(tool => tool.name === name)?.executionMode === "sequential")) {
			const previous = nestedQueueTail;
			nestedQueueTail = new Promise<void>(resolve => { release = resolve; });
			await previous;
		}
		// Descendants inherit the lock so a sequential tool can await another tool without deadlocking.
		local.getStore()!.holdsQueue = scope.holdsQueue || !!release;
		try {
			const outcome = await runToolCall(call, { tools, assistantMessage: issuer,
				context: { ...session.agent.state, tools: [...tools] }, signal: scope.signal,
				beforeToolCall: async (callContext, signal) => {
					if (!current(scope)) return { block: true, reason: "Resource tool execution cancelled or replaced" };
					const result = await session.agent.beforeToolCall?.(callContext, signal);
					return current(scope) ? result : { block: true, reason: "Resource tool execution cancelled or replaced" };
				},
				afterToolCall: async (callContext, signal) => {
					if (!current(scope)) throw new Error("Resource tool execution cancelled or replaced");
					const result = await session.agent.afterToolCall?.(callContext, signal);
					if (!current(scope)) throw new Error("Resource tool execution cancelled or replaced");
					return result;
				},
				onUpdate: async (partialResult) => { if (!current(scope)) return; update?.(partialResult);
					await emit({ type: "tool_execution_update", toolCallId: id, toolName: name, args, partialResult, ...parent }, scope); },
			});
			await emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result: outcome.result, isError: outcome.isError,
				...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }), ...parent }, scope);
			return outcome;
		} finally { release?.(); }
	});
	return { runner, getSignal: () => local.getStore()?.signal, async execute(name: string, args: unknown, signal?: AbortSignal) {
		const controller = new AbortController();
		const scope: Scope = { id: `piweb-resource-${randomUUID()}`, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
			root: { active: true, calls: 0 }, depth: 0, holdsQueue: false };
		try { return await dispatch(scope, name, args); }
		finally { scope.root.active = false; controller.abort(); }
	} };
}
