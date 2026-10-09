// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { ModelCatalog, type BuiltinModelDefinition } from "@/components/ProviderSetupModal";
import { modelDraftFromConfig, serializeModelDraft, type ModelDraft } from "@/lib/models/model-draft";

afterEach(cleanup);

/** 有状态的外壳：把当前草稿序列化结果暴露给断言 */
function Harness({ initial, builtinModels, onState, discover }: {
	initial: ModelDraft[];
	builtinModels?: BuiltinModelDefinition[];
	onState: (models: ModelDraft[]) => void;
	discover?: (allowPrivate: boolean) => Promise<ModelDraft[]>;
}) {
	const [models, setModels] = useState(initial);
	onState(models);
	return (
		<ModelCatalog
			models={models}
			setModels={setModels}
			updateModel={(index, patch) => setModels((current) => current.map((model, at) => (at === index ? { ...model, ...patch } : model)))}
			inheritedCount={builtinModels ? 3 : undefined}
			builtinModels={builtinModels}
			discover={discover}
		/>
	);
}

function setup(initial: ModelDraft[], extra: Partial<Parameters<typeof Harness>[0]> = {}) {
	let latest: ModelDraft[] = initial;
	render(<Harness initial={initial} onState={(models) => { latest = models; }} {...extra} />);
	return { saved: () => latest.map(serializeModelDraft) };
}

const deepseekReasoner: BuiltinModelDefinition = {
	id: "deepseek-reasoner", name: "DeepSeek Reasoner", reasoning: true, thinkingLevelMap: { off: null, xhigh: "high" },
	input: ["text"], contextWindow: 128000, maxTokens: 64000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { thinkingFormat: "deepseek" },
};

describe("model capabilities in the catalog (pi reasoning / thinkingLevelMap / input)", () => {
	it("turns on thinking, edits levels and provider values, and enables image input", () => {
		const { saved } = setup([modelDraftFromConfig({ id: "qwen3", name: "Qwen 3", headers: { "x-a": "b" } })]);
		fireEvent.click(screen.getByRole("button", { name: "容量与能力" }));
		expect(screen.queryByRole("group", { name: "可用档位" })).toBeNull();

		fireEvent.click(screen.getByRole("checkbox", { name: "支持思考" }));
		const levels = screen.getByRole("group", { name: "可用档位" });
		expect(within(levels).getAllByRole("button").filter((chip) => chip.getAttribute("aria-pressed") === "true").map((chip) => chip.textContent))
			.toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(screen.getByText("思考菜单：off · minimal · low · medium · high")).toBeTruthy();

		fireEvent.click(within(levels).getByRole("button", { name: "minimal" }));
		fireEvent.click(within(levels).getByRole("button", { name: "xhigh" }));
		fireEvent.change(screen.getByRole("textbox", { name: "low 的发送值" }), { target: { value: " light " } });
		// xhigh 开着时输入框可以清空重填，保存时留空的 xhigh 用档位名
		fireEvent.change(screen.getByRole("textbox", { name: "xhigh 的发送值" }), { target: { value: "" } });
		fireEvent.click(screen.getByRole("checkbox", { name: "支持图片输入" }));
		expect(screen.getByText("思考菜单：off · low · medium · high · xhigh")).toBeTruthy();

		expect(saved()).toEqual([{
			id: "qwen3", name: "Qwen 3", headers: { "x-a": "b" },
			reasoning: true, thinkingLevelMap: { minimal: null, low: "light", xhigh: "xhigh" }, input: ["text", "image"],
		}]);

		// 关掉思考与看图：删键回到 pi 默认，未动的档位映射原样保留
		fireEvent.click(screen.getByRole("checkbox", { name: "支持思考" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "支持图片输入" }));
		expect(saved()[0]).not.toHaveProperty("reasoning");
		expect(saved()[0]).not.toHaveProperty("input");
	});

	it("keeps at least one level enabled", () => {
		setup([modelDraftFromConfig({ id: "m", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } })]);
		fireEvent.click(screen.getByRole("button", { name: "容量与能力" }));
		const levels = screen.getByRole("group", { name: "可用档位" });
		fireEvent.click(within(levels).getByRole("button", { name: "high" }));
		expect(within(levels).getByRole("button", { name: "high" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("marks built-in models among discovered candidates, leaves them unchecked and prefills their capabilities", async () => {
		const discover = vi.fn(async () => [{ id: "deepseek-reasoner", name: "" }, { id: "my-finetune", name: "Mine" }]);
		const { saved } = setup([], { builtinModels: [deepseekReasoner], discover });
		fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
		const dialog = await screen.findByRole("dialog");
		const rows = within(dialog).getAllByRole("checkbox").filter((box) => box.closest("label")?.textContent?.includes("-"));
		const reasoner = rows.find((box) => box.closest("label")!.textContent!.includes("deepseek-reasoner"))!;
		expect(reasoner.closest("label")!.textContent).toContain("已内置");
		expect((reasoner as HTMLInputElement).checked).toBe(false);
		fireEvent.click(reasoner);
		fireEvent.click(within(dialog).getByRole("button", { name: "添加 2 个" }));
		const reasonerSaved = saved().find((model) => model.id === "deepseek-reasoner");
		expect(reasonerSaved).toEqual(deepseekReasoner);
		expect(saved().find((model) => model.id === "my-finetune")).toEqual({ id: "my-finetune", name: "Mine" });
		expect(screen.getByText(/与内置模型同 ID 的条目会整条替换内置定义/)).toBeTruthy();
	});

	it("prefills a freshly typed built-in ID and restores capabilities on an old replacement entry", () => {
		const { saved } = setup([modelDraftFromConfig({ id: "deepseek-reasoner", contextWindow: 64000 })], { builtinModels: [deepseekReasoner] });
		// 以前存过的替换条目：能力丢了，点「用内置能力」补回（已填的容量保留）
		fireEvent.click(screen.getByRole("button", { name: "容量与能力" }));
		fireEvent.click(screen.getByRole("button", { name: "用内置能力" }));
		expect(saved()[0]).toEqual({
			id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 64000, maxTokens: 64000,
			reasoning: true, thinkingLevelMap: { off: null, xhigh: "high" }, cost: deepseekReasoner.cost, compat: deepseekReasoner.compat,
		});

		// 新加一行、填入内置 ID 后离开输入框：整条用内置定义
		fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
		const ids = screen.getAllByPlaceholderText("模型 ID");
		fireEvent.change(ids[1], { target: { value: "deepseek-reasoner " } });
		fireEvent.blur(ids[1]);
		expect(saved()[1]).toEqual(deepseekReasoner);
	});
});
