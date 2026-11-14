/**
 * 组件测试的 DOM 垫片：jsdom 未实现的浏览器 API（仅在 jsdom 环境下生效，node 测试无影响）。
 */
import { configure } from "@testing-library/dom";
import { beforeEach, vi } from "vitest";

// Session location belongs to one browser tab. Start each DOM test with a fresh
// tab; restoration tests can populate its URL/storage in their own setup.
beforeEach(() => {
	if (typeof window === "undefined") return;
	sessionStorage.clear();
	if (window.location.origin !== "null") window.history.replaceState({}, "", "/");
});

// Real resource loads and UI updates can exceed one second when the suite is parallel.
configure({ asyncUtilTimeout: 5_000 });
const waitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback, options) => waitFor(callback, typeof options === "number" ? options : { timeout: 5_000, ...options })) as typeof vi.waitFor;

if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = function scrollIntoView() {};
}

if (typeof window !== "undefined" && !window.matchMedia) {
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	})) as typeof window.matchMedia;
}

if (typeof globalThis.ResizeObserver === "undefined") {
	class ResizeObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}
