/**
 * 截图上点选元素（B3）的服务端流程：只操作 pi 这个会话已经打开的标签页，不新开、不导航。
 * capture：给当前页面重新截一张图（对话里那张可能已经过时），用户在这张图上点；
 * pick：取该点的元素 → 交给 locateSource 找源码 → 附一张元素裁剪图（模型能看图时随消息发出）。
 */
import { locateSource, type SourceHit } from "../dev-inspect-service";
import { BoundaryError } from "../path-security";
import { elementLabel, locateAttrsFromHints, type PickedElementInfo } from "./inspect";
import { DEVICES, peekBrowserTab, type BrowserTab, type Device } from "./manager";

/** 随元素一起返回的源码候选上限（芯片只显示第一条，正文最多带 3 条） */
const MAX_LOCATIONS = 5;

export class NoBrowserPageError extends Error {
	constructor() {
		super("pi has no page open in its browser for this session");
		this.name = "NoBrowserPageError";
	}
}

export class NoElementError extends Error {
	constructor() {
		super("no element at that point");
		this.name = "NoElementError";
	}
}

export interface CaptureResult {
	image: { data: string; mimeType: "image/jpeg" };
	/** 截图对应的视口尺寸（CSS 像素），前端按它把点击位置换算回页面坐标 */
	width: number;
	height: number;
	device: Device;
	url: string;
	title: string;
}

export interface PickResult {
	element: PickedElementInfo & { label: string };
	locations: SourceHit[];
	/** 工作区太大，搜索没走完 */
	truncated?: boolean;
	crop: { data: string; mimeType: "image/jpeg" } | null;
}

async function openPage(sessionKey: string): Promise<BrowserTab> {
	const tab = await peekBrowserTab(sessionKey);
	if (!tab || !tab.hasPage) throw new NoBrowserPageError();
	return tab;
}

export async function captureForPicking(sessionKey: string): Promise<CaptureResult> {
	const tab = await openPage(sessionKey);
	const shot = await tab.screenshot({ quality: 80 });
	const info = await tab.info();
	return { image: { data: shot.data, mimeType: "image/jpeg" }, width: shot.width, height: shot.height, device: tab.device, url: info.url, title: info.title };
}

export async function pickElementAt(sessionKey: string, cwd: string, x: number, y: number): Promise<PickResult> {
	const tab = await openPage(sessionKey);
	const view = DEVICES[tab.device];
	if (!(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= view.width && y <= view.height)) {
		throw new BoundaryError("point is outside the page viewport");
	}
	const element = await tab.elementAt(x, y);
	if (!element) throw new NoElementError();

	let locations: SourceHit[] = [];
	let truncated: boolean | undefined;
	try {
		const located = await locateSource(cwd, { text: element.text, attrs: { ...element.attrs, ...locateAttrsFromHints(element.hints) } });
		locations = located.results.slice(0, MAX_LOCATIONS);
		truncated = located.truncated;
	} catch (error) {
		// 没有可搜的文本 / 线索，或工作区已不存在：照样返回元素，只是不带源码位置
		if (!(error instanceof BoundaryError)) throw error;
	}

	let crop: PickResult["crop"] = null;
	try {
		const shot = await tab.screenshot({ region: { box: element.box, scroll: element.scroll }, quality: 80 });
		crop = { data: shot.data, mimeType: "image/jpeg" };
	} catch {
		// 元素在视口外或尺寸为 0：没有裁剪图
	}
	return { element: { ...element, label: elementLabel(element) }, locations, truncated, crop };
}
