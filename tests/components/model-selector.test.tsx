// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ModelSelector, type ModelChoice } from "@/components/ModelSelector";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const models: ModelChoice[] = [
	{ provider: "anthropic", id: "claude-work", name: "Claude Work", reasoning: true, contextWindow: 200_000 },
	{ provider: "openai", id: "gpt-mini", name: "GPT Mini", reasoning: true, contextWindow: 128_000 },
	{ provider: "openai", id: "gpt-code", name: "GPT Code", reasoning: true, contextWindow: 200_000 },
	{ provider: "private", id: "secret-code", name: "Private Model", reasoning: false, contextWindow: 32_000 },
	{ provider: "local-lab", id: "local-24", name: "Local Coder", reasoning: false, contextWindow: 32_000 },
];

function props(overrides: Partial<ComponentProps<typeof ModelSelector>> = {}): ComponentProps<typeof ModelSelector> {
	return {
		model: { provider: "openai", id: "gpt-code", name: "GPT Code" },
		thinkingLevel: "medium", thinkingLevels: ["off", "medium", "high"], models,
		providerNames: { openai: "OpenAI", anthropic: "Anthropic", "local-lab": "Local Lab" },
		authByProvider: { private: false }, onSelectModel: vi.fn(), onSelectLevel: vi.fn(), ...overrides,
	};
}
function open() {
	fireEvent.click(screen.getByRole("button", { name: "OpenAI/GPT Code · medium" }));
	return screen.getByRole("combobox") as HTMLInputElement;
}
const options = () => within(screen.getByRole("listbox")).queryAllByRole("option");

describe("searchable model selector", () => {
	it.each([false, true])("clamps horizontally on a narrow viewport and realigns on resize (modelOnly=%s)", (modelOnly) => {
		vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(390);
		let naturalLeft = -56.4;
		const getRect = HTMLElement.prototype.getBoundingClientRect;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.getAttribute("role") !== "dialog") return getRect.call(this);
			return { x: naturalLeft, y: 200, left: naturalLeft, right: naturalLeft + 340,
				top: 200, bottom: 600, width: 340, height: 400, toJSON: () => ({}) };
		});
		render(<ModelSelector {...props({ modelOnly })} />);
		fireEvent.click(screen.getByRole("button", { name: /^OpenAI\/GPT Code/ }));
		const menu = screen.getByRole("dialog");
		expect(menu.style.getPropertyValue("--model-menu-offset")).toBe("68.4px");
		naturalLeft = 190;
		fireEvent(window, new Event("resize"));
		expect(menu.style.getPropertyValue("--model-menu-offset")).toBe("-152px");
		fireEvent(window, new Event("resize"));
		expect(menu.style.getPropertyValue("--model-menu-offset")).toBe("-152px");
		naturalLeft = 16;
		fireEvent(window, new Event("resize"));
		expect(menu.style.getPropertyValue("--model-menu-offset")).toBe("0px");
		expect(document.activeElement).toBe(screen.getByRole("combobox"));
	});

	it("groups authorized models with the existing provider logos and custom-provider fallback", () => {
		const { container } = render(<ModelSelector {...props()} />);
		const search = open();
		expect(document.activeElement).toBe(search);
		expect(options()).toHaveLength(4);
		expect(screen.queryByRole("option", { name: /Private Model/ })).toBeNull();
		expect(screen.getAllByRole("group")[0].getAttribute("aria-labelledby")).toBeTruthy();
		expect(screen.getByRole("group", { name: "OpenAI" })).toBeTruthy();
		expect(container.querySelector('img[src="/provider-icons/openai.svg"]')).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "Local Lab" })).getByText("LL")).toBeTruthy();
		expect(screen.getByRole("option", { name: /^GPT Code/ }).getAttribute("aria-selected")).toBe("true");
	});

	it("matches all search words across names, IDs and provider names without exposing blocked providers", () => {
		render(<ModelSelector {...props()} />);
		const search = open();
		fireEvent.change(search, { target: { value: "  OPENAI  mini " } });
		expect(options()).toHaveLength(1);
		expect(options()[0].textContent).toContain("GPT Mini");
		fireEvent.change(search, { target: { value: "claude-work" } });
		expect(options()).toHaveLength(1);
		expect(options()[0].textContent).toContain("Claude Work");
		fireEvent.change(search, { target: { value: "lab local-24" } });
		expect(options()).toHaveLength(1);
		expect(options()[0].textContent).toContain("Local Coder");
		fireEvent.change(search, { target: { value: "private" } });
		expect(options()).toHaveLength(0);
		expect(screen.getByRole("status").textContent).toContain("没有匹配的模型");
		fireEvent.change(search, { target: { value: "" } });
		expect(options()).toHaveLength(4);
	});

	it("starts provider groups expanded and toggles only the clicked group without choosing a model", () => {
		const config = props();
		render(<ModelSelector {...config} />);
		open();
		const group = screen.getByRole("button", { name: "OpenAI" });
		expect(group.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(group);
		expect(group.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("option", { name: /^GPT/ })).toBeNull();
		expect(screen.getByRole("option", { name: /^Claude Work/ })).toBeTruthy();
		expect(config.onSelectModel).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeTruthy();
		fireEvent.click(group);
		expect(group.getAttribute("aria-expanded")).toBe("true");
		expect(options()).toHaveLength(4);
	});

	it("skips collapsed models in keyboard selection and expands matching groups for a new search", () => {
		const config = props();
		render(<ModelSelector {...config} />);
		const search = open();
		fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
		for (let i = 0; i < 4; i += 1) {
			fireEvent.keyDown(search, { key: "ArrowDown" });
			const option = document.getElementById(search.getAttribute("aria-activedescendant")!);
			expect(option?.textContent).not.toMatch(/GPT/);
		}
		fireEvent.change(search, { target: { value: "gpt mini" } });
		expect(screen.getByRole("button", { name: "OpenAI" }).getAttribute("aria-expanded")).toBe("true");
		expect(options()).toHaveLength(1);
		fireEvent.keyDown(search, { key: "Enter" });
		expect(config.onSelectModel).toHaveBeenCalledExactlyOnceWith("openai", "gpt-mini");
	});

	it("keeps provider headings available when every group is collapsed", () => {
		const config = props();
		render(<ModelSelector {...config} />);
		const search = open();
		for (const label of ["OpenAI", "Anthropic", "Local Lab"]) fireEvent.click(screen.getByRole("button", { name: label }));
		expect(options()).toHaveLength(0);
		expect(screen.queryByRole("status")).toBeNull();
		expect(search.getAttribute("aria-activedescendant")).toBeNull();
		fireEvent.keyDown(search, { key: "Enter" });
		expect(config.onSelectModel).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("keeps search focused while arrows move the candidate and Enter selects it, then restores the trigger", () => {
		const config = props();
		render(<ModelSelector {...config} />);
		const trigger = screen.getByRole("button", { name: "OpenAI/GPT Code · medium" });
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		const search = screen.getByRole("combobox");
		const selectedId = search.getAttribute("aria-activedescendant");
		expect(document.getElementById(selectedId!)?.textContent).toContain("GPT Code");
		fireEvent.keyDown(search, { key: "ArrowDown" });
		expect(document.activeElement).toBe(search);
		expect(document.getElementById(search.getAttribute("aria-activedescendant")!)?.textContent).toContain("GPT Mini");
		expect(config.onSelectModel).not.toHaveBeenCalled();
		fireEvent.keyDown(search, { key: "Enter" });
		expect(config.onSelectModel).toHaveBeenCalledExactlyOnceWith("openai", "gpt-mini");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("ignores IME confirmation and makes no selection when a search has no results", () => {
		const config = props();
		render(<ModelSelector {...config} />);
		const search = open();
		const activeId = search.getAttribute("aria-activedescendant");
		fireEvent.keyDown(search, { key: "ArrowDown", isComposing: true });
		expect(search.getAttribute("aria-activedescendant")).toBe(activeId);
		fireEvent.keyDown(search, { key: "Enter", isComposing: true });
		expect(config.onSelectModel).not.toHaveBeenCalled();
		fireEvent.change(search, { target: { value: "does not exist" } });
		fireEvent.keyDown(search, { key: "ArrowDown" });
		fireEvent.keyDown(search, { key: "Enter" });
		expect(config.onSelectModel).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("closes with Escape without reaching other panels, and clears the old search on reopening", () => {
		render(<ModelSelector {...props()} />);
		const search = open();
		fireEvent.change(search, { target: { value: "mini" } });
		const outer = vi.fn();
		document.addEventListener("keydown", outer);
		fireEvent.keyDown(search, { key: "Escape" });
		document.removeEventListener("keydown", outer);
		expect(outer).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(open().value).toBe("");
		expect(options()).toHaveLength(4);
	});

	it("preserves thinking navigation, keyboard selection and the current search when returning", () => {
		const config = props();
		render(<ModelSelector {...config} />);
		const search = open();
		fireEvent.change(search, { target: { value: "gpt" } });
		fireEvent.click(screen.getByRole("button", { name: "思考: medium" }));
		expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "medium" }));
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("gpt");
		expect(document.activeElement).toBe(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("button", { name: "思考: medium" }));
		fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
		expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "high" }));
		fireEvent.keyDown(document.activeElement!, { key: "Enter" });
		expect(config.onSelectLevel).toHaveBeenCalledExactlyOnceWith("high");
		expect(config.onSelectModel).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("retains a selectable default option and the compact model-only variant", () => {
		const onDefault = vi.fn();
		const config = props({ modelOnly: true, defaultOption: { label: "默认模型", selected: true, onSelect: onDefault } });
		render(<ModelSelector {...config} />);
		fireEvent.click(screen.getByRole("button", { name: "默认模型 · OpenAI/GPT Code" }));
		expect(screen.getByRole("option", { name: "默认模型" }).getAttribute("aria-selected")).toBe("true");
		expect(screen.getByRole("option", { name: /^GPT Code/ }).getAttribute("aria-selected")).toBe("false");
		expect(screen.queryByText("思考")).toBeNull();
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(onDefault).toHaveBeenCalledTimes(1);
		expect(config.onSelectModel).not.toHaveBeenCalled();
	});

	it("supports controlled opening and closing without mutating the parent's value", () => {
		const onOpenChange = vi.fn();
		const config = props({ open: false, onOpenChange });
		const view = render(<ModelSelector {...config} />);
		fireEvent.click(screen.getByRole("button", { name: "OpenAI/GPT Code · medium" }));
		expect(onOpenChange).toHaveBeenLastCalledWith(true);
		expect(screen.queryByRole("dialog")).toBeNull();
		view.rerender(<ModelSelector {...config} open />);
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
		expect(screen.getByRole("dialog")).toBeTruthy();
		view.rerender(<ModelSelector {...config} open={false} />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes on outside pointer or keyboard focus without trapping the next field", () => {
		render(<><ModelSelector {...props()} /><button>next control</button></>);
		open();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("dialog")).toBeNull();
		open();
		act(() => screen.getByRole("button", { name: "next control" }).focus());
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "next control" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("retains the unavailable-thinking explanation and respects disabled state", () => {
		const config = props({ thinkingLevels: ["off"] });
		const view = render(<ModelSelector {...config} />);
		open();
		expect(screen.getByText("此模型不支持")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^思考 / })).toBeNull();
		view.rerender(<ModelSelector {...config} disabled open />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect((screen.getByRole("button", { name: "OpenAI/GPT Code · medium" }) as HTMLButtonElement).disabled).toBe(true);
	});
});
