import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The SDK's ESM-only exports cannot be resolved through require.resolve(package). */
export function resolveHostSdkPackage(hostSourceRoot, name) {
	const requireFromHost = createRequire(path.join(hostSourceRoot, "lib", "pi.ts"));
	for (const searchPath of requireFromHost.resolve.paths(name) ?? []) {
		const manifestPath = path.join(searchPath, name, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest.name !== name) throw new Error(`Unexpected SDK package at ${manifestPath}`);
		const exported = manifest.exports?.["."];
		const entry = typeof exported === "string" ? exported : exported?.import ?? manifest.main;
		if (typeof entry !== "string") throw new Error(`The SDK package has no ESM entry: ${name}`);
		return { root: realpathSync(path.dirname(manifestPath)), entry: realpathSync(path.resolve(path.dirname(manifestPath), entry)), version: manifest.version };
	}
	throw new Error(`The actual host has no installed SDK package: ${name}`);
}

/** Deterministic model only: the host still loads and runs its actual SDK and tools. */
export default async function verificationProvider(pi) {
	const hostSourceRoot = process.env.PIWEB_TEST_HOST_ROOT;
	if (!hostSourceRoot || !path.isAbsolute(hostSourceRoot)) throw new Error("PIWEB_TEST_HOST_ROOT must name the actual host's absolute src directory.");
	const { createAssistantMessageEventStream, getCurrentTools } = await import(pathToFileURL(resolveHostSdkPackage(hostSourceRoot, "@earendil-works/pi-ai").entry).href);
	const model = {
		id: "fixture", name: "PiWeb verification fixture", reasoning: false, input: ["text"],
		contextWindow: 65_536, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	pi.registerProvider("piweb-verification", {
		name: "PiWeb verification", api: "piweb-verification", baseUrl: "https://piweb-verification.invalid", apiKey: "piweb-verification-dummy-key",
		models: [model],
		streamSimple(selectedModel, context, options) {
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant", content: [], api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			void (async () => {
				let payload = { messages: context.messages };
				payload = await options?.onPayload?.(payload, selectedModel) ?? payload;
				await options?.onResponse?.({ status: 200, headers: { "x-piweb-verification": "fixture" } }, selectedModel);
				if (options?.signal?.aborted) throw new Error("Verification stream aborted");
				if (!Array.isArray(payload.messages)) throw new Error("Verification payload must retain messages");
				const messages = payload.messages;
				const last = messages.findLast((entry) => entry.role !== "system");
				if (last?.role === "toolResult") {
					message.content = [{ type: "text", text: "Recorded" }];
				} else if (getCurrentTools(messages).some((tool) => tool.name === "ask_user_question")) {
					const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(" ");
					const count = (name, fallback, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(text.match(new RegExp("\\b" + name + "=(\\d+)", "i"))?.[1] ?? fallback)));
					const questionCount = count("questions", 1, 1, 4);
					const optionCount = count("options", 2, 2, 4);
					const multi = text.match(/\bmulti=(all|[1-4])\b/i)?.[1];
					const questions = Array.from({ length: questionCount }, (_, index) => ({
						question: `Which option should be used for question ${index + 1}?`, header: `Question ${index + 1}`,
						options: Array.from({ length: optionCount }, (_, option) => ({ label: option === 0 ? "A (Recommended)" : String.fromCharCode(65 + option), description: `Use option ${String.fromCharCode(65 + option)} for this verification.` })),
						...(multi?.toLowerCase() === "all" || Number(multi) === index + 1 ? { multiSelect: true } : {}),
					}));
					message.content = [{ type: "toolCall", id: randomUUID(), name: "ask_user_question", arguments: { questions } }];
					message.stopReason = "toolUse";
				} else {
					message.content = [{ type: "text", text: "Which option should be used? A (Recommended) or B?" }];
				}
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: message.stopReason, message });
			})().catch((error) => {
				const reason = options?.signal?.aborted ? "aborted" : "error";
				stream.push({ type: "error", reason, error: { ...message, stopReason: reason, errorMessage: String(error?.message ?? error) } });
			});
			return stream;
		},
	});
}
