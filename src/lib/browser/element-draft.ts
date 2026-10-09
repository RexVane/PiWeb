/**
 * 截图上点选的元素在输入卡里的形态（元素芯片），以及发送时拼进正文的描述。
 * 纯数据与纯函数：客户端组件与测试共用，不依赖浏览器或服务端模块。
 */
import type { ImageAttachment } from "../types";

export interface DraftElement {
	/** 芯片标识：同一个元素点两次也是两枚芯片 */
	key: string;
	/** <button#save> “保存” */
	label: string;
	/** DOM 路径，如 main > div.card > button.save */
	selector: string;
	pageUrl: string;
	component?: string;
	/** 源码候选（最多 3 条；第一条显示在芯片上） */
	locations: Array<{ path: string; line: number }>;
	/** 元素裁剪图：当前模型能看图时随消息附上 */
	crop?: ImageAttachment;
}

export interface ElementPromptTemplates {
	elementPromptHeader: string;
	elementPromptPage: string;
	elementPromptPath: string;
	elementPromptSource: string;
	elementPromptComponent: string;
	elementPromptImage: string;
}

/** 单条消息的图片上限（与服务端命令校验一致） */
export const MAX_MESSAGE_IMAGES = 20;

/**
 * 行内代码：标签、选择器、路径里的 * _ < 等不会被用户气泡的 Markdown 吃掉；
 * 内容自带反引号时按 CommonMark 规则换更长的围栏。
 */
function code(value: string): string {
	const flat = value.replace(/\s+/g, " ");
	const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
	return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * 发送时拼进正文的元素描述：每个元素一个标题行 + Markdown 列表（模型读得懂，用户气泡也排得整齐），
 * 元素之间空一行。images 给出时（模型能看图）附上裁剪图：
 * 编号从 firstNumber 起（排在用户自己的图片之后），最多 max 张，超出的只发文字。
 */
export function describeElements(
	elements: DraftElement[],
	t: ElementPromptTemplates,
	images?: { firstNumber: number; max: number },
): { text: string; crops: ImageAttachment[] } {
	const crops: ImageAttachment[] = [];
	const blocks = elements.map((element) => {
		const lines = [t.elementPromptHeader.replace("{label}", () => code(element.label))];
		if (element.pageUrl) lines.push(t.elementPromptPage.replace("{url}", () => element.pageUrl));
		if (element.selector) lines.push(t.elementPromptPath.replace("{selector}", () => code(element.selector)));
		if (element.locations.length) {
			lines.push(t.elementPromptSource.replace("{locations}", () => element.locations.map((l) => code(`${l.path}:${l.line}`)).join(", ")));
		}
		if (element.component) lines.push(t.elementPromptComponent.replace("{component}", () => code(element.component!)));
		if (images && element.crop && crops.length < images.max) {
			crops.push(element.crop);
			lines.push(t.elementPromptImage.replace("{n}", String(images.firstNumber + crops.length - 1)));
		}
		return lines.join("\n");
	});
	return { text: blocks.join("\n\n"), crops };
}
