// @vitest-environment jsdom
/** 输入框里还没发出去的附件卡：点一下用页内文件查看器预览，删除按钮只管移除 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerFiles } from "@/components/composer/ComposerFiles";
import { I18nProvider } from "@/i18n";

const file = { name: "notes.md", path: "C:\\Users\\me\\.pi\\agent\\web-uploads\\notes.md", size: 12 };

afterEach(cleanup);

function setup() {
	const onOpen = vi.fn();
	const onRemove = vi.fn();
	render(
		<I18nProvider initialLang="zh">
			<ComposerFiles files={[file]} onOpen={onOpen} onRemove={onRemove} />
		</I18nProvider>,
	);
	const card = screen.getByText("notes.md").closest(".pw-file-card") as HTMLElement;
	return { onOpen, onRemove, card };
}

describe("输入框附件卡预览", () => {
	it("点击文件卡调用文件查看器", () => {
		const { onOpen, card } = setup();
		fireEvent.click(card);
		expect(onOpen).toHaveBeenCalledWith(file);
	});

	it("Enter 和空格也能打开（键盘可达）", () => {
		const { onOpen, card } = setup();
		expect(card.getAttribute("role")).toBe("button");
		fireEvent.keyDown(card, { key: "Enter" });
		fireEvent.keyDown(card, { key: " " });
		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it("删除按钮只移除附件，不触发预览", () => {
		const { onOpen, onRemove } = setup();
		fireEvent.click(screen.getByLabelText(/notes\.md/));
		expect(onRemove).toHaveBeenCalledWith(0);
		expect(onOpen).not.toHaveBeenCalled();
	});
});
