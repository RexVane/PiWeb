import { afterEach, describe, expect, it, vi } from "vitest";
import { sideChatId } from "../../src/lib/side-chat/types";

/**
 * 手机经「远程连接」走的是局域网 http —— 非安全上下文里 `crypto.randomUUID` 不存在。
 * 以前旁聊 store 直接调它,面板一打开就抛错,整块显示不出来(用户报的「手机端旁聊加载有问题」)。
 */
describe("旁聊的本地 id 生成", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("安全上下文里仍用 randomUUID", () => {
		const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
		vi.stubGlobal("crypto", { randomUUID, getRandomValues: (array: Uint8Array) => array });
		expect(sideChatId()).toBe("11111111-2222-4333-8444-555555555555");
		expect(randomUUID).toHaveBeenCalledTimes(1);
	});

	it("非安全上下文(局域网 http)退回 getRandomValues,拼出合法 UUID v4", () => {
		vi.stubGlobal("crypto", {
			getRandomValues: (array: Uint8Array) => {
				for (let i = 0; i < array.length; i += 1) array[i] = i;
				return array;
			},
		});
		const id = sideChatId();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		// 生成的 id 必须能通过 store 自己的校验,否则刷新后整份历史被当成损坏丢掉
		expect(id).toMatch(/^[a-zA-Z0-9_-]{8,80}$/);
	});

	it("两个都不可用时也不抛错,退到最后一段随机串", () => {
		vi.stubGlobal("crypto", undefined);
		const id = sideChatId();
		expect(id).toMatch(/^sc-/);
		expect(id).toMatch(/^[a-zA-Z0-9_-]{8,80}$/);
	});
});