// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelSelector, type ModelChoice } from "@/components/ModelSelector";
import type { ModelDefaults } from "@/lib/models/thinking";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const levels = ["off", "minimal", "low", "medium", "high"];
const choices: ModelChoice[] = [
	{ provider: "p", id: "fast", name: "Fast", reasoning: true, thinkingLevels: levels, contextWindow: 1000 },
	{ provider: "p", id: "deep", name: "Deep", reasoning: true, thinkingLevels: levels, contextWindow: 1000 },
];

function selector(props: Partial<Parameters<typeof ModelSelector>[0]> = {}) {
	const onSaveDefault = vi.fn(async () => true);
	const defaults: ModelDefaults = { provider: "p", modelId: "fast", thinkingLevel: "low", modelThinkingLevels: { "p/deep": "minimal" } };
	render(
		<ModelSelector
			model={{ provider: "p", id: "deep", name: "Deep" }}
			thinkingLevel="high"
			thinkingLevels={levels}
			models={choices}
			providerNames={{ p: "Prov" }}
			authByProvider={{ p: true }}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
			defaults={defaults}
			onSaveDefault={onSaveDefault}
			{...props}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: /^Prov\/Deep/ }));
	return { onSaveDefault };
}

describe("model selector marks pi's defaults and saves new ones", () => {
	it("tags the default model and the level a new session would use, and saves the current pick", async () => {
		const { onSaveDefault } = selector();
		expect(within(screen.getByRole("menuitemradio", { name: /Fast/ })).getByText("默认")).toBeTruthy();
		expect(within(screen.getByRole("menuitemradio", { name: /Deep/ })).queryByText("默认")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
		await waitFor(() => expect(onSaveDefault).toHaveBeenCalledWith("p", "deep", "high"));

		// 思考子页：deep 有单独设置 minimal，优先于全局 low；每档带说明
		fireEvent.click(screen.getByRole("button", { name: /思考/ }));
		const minimal = screen.getByRole("menuitemradio", { name: /minimal/ });
		expect(within(minimal).getByText("默认")).toBeTruthy();
		expect(within(minimal).getByText("极简，约 1k tokens")).toBeTruthy();
		expect(within(screen.getByRole("menuitemradio", { name: /^low/ })).queryByText("默认")).toBeNull();
	});

	it("shows the pick as already default when model and level both match", () => {
		selector({ thinkingLevel: "minimal", defaults: { provider: "p", modelId: "deep", thinkingLevel: null, modelThinkingLevels: { "p/deep": "minimal" } } });
		expect(screen.queryByRole("button", { name: "设为默认" })).toBeNull();
		expect(screen.getByText("已是默认")).toBeTruthy();
	});

	it("does not send a level for a model that only has off", async () => {
		const { onSaveDefault } = selector({ thinkingLevel: "off", thinkingLevels: ["off"], defaults: null });
		fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
		await waitFor(() => expect(onSaveDefault).toHaveBeenCalledWith("p", "deep", undefined));
	});
});
