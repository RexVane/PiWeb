// @vitest-environment jsdom
/**
 * 输入框 `@` 引用：打 @ 弹候选、边打边匹配、选中落成引用 chip。
 *
 * 候选清单按工作区缓存（模块级 Map），所以每个用例用**不同的 cwd**——
 * 否则第二个用例会拿到第一个用例的缓存列表，测出来的是缓存而不是逻辑。
 * 数据源只断言 HTTP 层：/api/files?index=1（服务端索引在 tests/files-service.test.ts）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/**
 * 输入：必须走 fireEvent.change（内部用原生 value setter，绕开 React 的值追踪）。
 * 直接抄 `textarea.value = ...` 会让 React 认为值没变、onChange 不触发——光标位置也就无从谈起。
 */
function type(textarea: HTMLElement, value: string, caret = value.length) {
	fireEvent.change(textarea, { target: { value } });
	// 赋值会把光标移到末尾；需要中间位置时再手动摆一次（当前用例都在末尾）
	if (caret !== value.length) (textarea as HTMLTextAreaElement).setSelectionRange(caret, caret);
}

const FILES = ["src/lib/fuzzy.ts", "src/components/ChatInput.tsx", "docs/state/progress.md", "README.md"];

function stubIndex(files: string[] = FILES, extra: { source?: "git" | "disk"; truncated?: boolean } = {}) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				json: async () => ({ success: true, data: { files, source: extra.source ?? "git", truncated: extra.truncated ?? false } }),
			};
		}),
	);
	return calls;
}

function renderInput(cwd = "/workspace-1") {
	const onSend = vi.fn(async () => ({ success: true }));
	render(
		<ChatInput
			isStreaming={false}
			cwd={cwd}
			model={{ provider: "test", id: "test-model", name: "Test Model" }}
			contextPercent={null}
			contextTokens={null}
			contextWindow={null}
			thinkingLevels={[]}
			models={[]}
			providerNames={{}}
			authByProvider={{}}
			queue={{ steering: [], followUp: [] }}
			onSend={onSend}
			onSteer={vi.fn(async () => ({ success: true }))}
			onAbort={vi.fn()}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
		/>,
	);
	return { onSend, textarea: screen.getByRole("textbox") };
}

describe("输入框 @ 引用", () => {
	it("打 @ 才拉候选清单，边打边过滤", async () => {
		const calls = stubIndex();
		const { textarea } = renderInput("/workspace-open");
		expect(calls).toHaveLength(0);

		type(textarea, "@");
		const menu = await screen.findByTestId("mention-menu");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/api/files?index=1");
		expect(menu.textContent).toContain("src/lib/fuzzy.ts");

		type(textarea, "@fuz");
		await waitFor(() => expect(screen.getByTestId("mention-menu").textContent).toContain("src/lib/fuzzy.ts"));
		expect(screen.getByTestId("mention-menu").textContent).not.toContain("ChatInput.tsx");
		// 和 pi 终端一样按字面匹配文件名：跳字母的 @fz 不算命中
		type(textarea, "@fz");
		await waitFor(() => expect(screen.getByTestId("mention-menu").textContent).toContain("没有匹配的文件"));
		// 过滤在本地算：整轮只拉了一次清单
		expect(calls).toHaveLength(1);
	});

	it("Enter 采纳为引用 chip，并把 @ 文本从正文里去掉", async () => {
		const calls = stubIndex();
		const { textarea } = renderInput("/workspace-enter");
		type(textarea, "看这个 @fuzzy");
		await screen.findByTestId("mention-menu");

		fireEvent.keyDown(textarea, { key: "Enter" });

		const chips = screen.getByTestId("composer-references");
		expect(chips.textContent).toContain("fuzzy.ts");
		expect(chips.querySelector("[title]")?.getAttribute("title")).toBe("src/lib/fuzzy.ts");
		expect((textarea as HTMLTextAreaElement).value).toBe("看这个 ");
		expect(screen.queryByTestId("mention-menu")).toBeNull();
		// 采纳不是发送
		expect(calls).toHaveLength(1);
	});

	it("Tab 同样采纳，且文件夹本身就能当引用", async () => {
		const calls = stubIndex();
		const { textarea } = renderInput("/workspace-folder");
		type(textarea, "@src/lib");
		const menu = await screen.findByTestId("mention-menu");
		// 和 pi 一样：名字（目录带尾斜杠）在前、路径在后
		const [first] = within(menu).getAllByRole("option");
		expect(first.textContent).toBe("lib/src/lib");
		expect(first.getAttribute("title")).toBe("src/lib/");

		fireEvent.keyDown(textarea, { key: "ArrowDown" });
		fireEvent.keyDown(textarea, { key: "ArrowUp" });
		fireEvent.keyDown(textarea, { key: "Tab" });

		const chip = screen.getByTestId("composer-references").querySelector("[title]");
		// 目录带尾斜杠存：chip 靠它显示成文件夹（lib/ + 文件夹图标）
		expect(chip?.getAttribute("title")).toBe("src/lib/");
		expect(chip?.textContent).toContain("lib/");
		expect((textarea as HTMLTextAreaElement).value).toBe("");
		expect(calls).toHaveLength(1);
	});

	it("点击候选也能引用", async () => {
		stubIndex();
		const { textarea } = renderInput("/workspace-click");
		type(textarea, "@readme");
		const menu = await screen.findByTestId("mention-menu");
		await waitFor(() => expect(menu.textContent).toContain("README.md"));
		fireEvent.click(screen.getByRole("option", { name: /README\.md/ }));
		expect(screen.getByTestId("composer-references").querySelector("[title]")?.getAttribute("title")).toBe("README.md");
	});

	it("Esc 关掉候选后 Enter 照常发送", async () => {
		stubIndex();
		const { textarea, onSend } = renderInput("/workspace-esc");
		// 光标必须落在 token 末尾（@ 后面还有字时本来也不该弹）
		type(textarea, "看一下 @fuzzy");
		await screen.findByTestId("mention-menu");

		fireEvent.keyDown(textarea, { key: "Escape" });
		expect(screen.queryByTestId("mention-menu")).toBeNull();

		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onSend).toHaveBeenCalledWith("看一下 @fuzzy", []));
	});

	it("没有候选时不拦 Enter：`@某人` 这种文字能直接发出去", async () => {
		stubIndex([]);
		const { textarea, onSend } = renderInput("/workspace-nomatch");
		type(textarea, "@某人");
		const menu = await screen.findByTestId("mention-menu");
		await waitFor(() => expect(menu.textContent).toContain("没有匹配的文件"));

		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onSend).toHaveBeenCalledWith("@某人", []));
	});

	it("邮箱里的 @ 不触发候选", async () => {
		const calls = stubIndex();
		const { textarea } = renderInput("/workspace-email");
		type(textarea, "发给 someone@example.com");
		expect(screen.queryByTestId("mention-menu")).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("候选被截断时在菜单里说明，不静默少候选", async () => {
		stubIndex(FILES, { truncated: true, source: "disk" });
		const { textarea } = renderInput("/workspace-truncated");
		type(textarea, "@");
		const menu = await screen.findByTestId("mention-menu");
		await waitFor(() => expect(menu.textContent).toContain("候选已截断"));
		expect(menu.textContent).toContain("目录遍历");
	});
});
