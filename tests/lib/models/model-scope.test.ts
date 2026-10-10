import { describe, expect, it, vi } from "vitest";
import { filterModelsByPiScope, type ModelScopeRuntime } from "@/lib/models/model-scope";

describe("PiWeb model scope", () => {
	it("uses Pi model patterns to filter picker models", async () => {
		const models = [
			{ provider: "openai-codex", id: "gpt-5.6-luna" },
			{ provider: "openai-codex", id: "gpt-6-astra" },
			{ provider: "openai-codex", id: "gpt-6-luna" },
			{ provider: "openai-codex", id: "gpt-6-sol" },
			{ provider: "openai-codex", id: "gpt-6.1-sol" },
		];
		const runtime = {
			getAvailable: vi.fn(async () => models),
		} as unknown as ModelScopeRuntime;

		const result = await filterModelsByPiScope(models, [
			"openai-codex/gpt-6-astra",
			"openai-codex/gpt-6-luna",
			"openai-codex/gpt-6.1-sol",
		], runtime);

		expect(result.map(({ id }) => id)).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
		expect(runtime.getAvailable).toHaveBeenCalledOnce();
	});

	it("leaves the catalog unchanged when no scope is configured", async () => {
		const models = [{ provider: "openai-codex", id: "gpt-5.6-luna" }];
		const runtime = { getAvailable: vi.fn() } as unknown as ModelScopeRuntime;
		expect(await filterModelsByPiScope(models, [], runtime)).toEqual(models);
		expect(runtime.getAvailable).not.toHaveBeenCalled();
	});
});
