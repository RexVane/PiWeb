import { describe, expect, it } from "vitest";
import { parseBashCommand } from "@/lib/chat/bash-command";

describe("! 命令的判定", () => {
	it("! 开头是命令，!! 开头的结果不进模型上下文", () => {
		expect(parseBashCommand("!git status")).toEqual({ command: "git status", excludeFromContext: false });
		expect(parseBashCommand("!  npm test  ")).toEqual({ command: "npm test", excludeFromContext: false });
		expect(parseBashCommand("!!cat .env")).toEqual({ command: "cat .env", excludeFromContext: true });
		// 多行脚本照样算一条命令
		expect(parseBashCommand("!cd src\nls")).toEqual({ command: "cd src\nls", excludeFromContext: false });
	});

	it("不是命令的照常当消息发", () => {
		expect(parseBashCommand("看一下 !important 这段")).toBeNull();
		// 只有感叹号
		expect(parseBashCommand("!")).toBeNull();
		expect(parseBashCommand("!!")).toBeNull();
		expect(parseBashCommand("!   ")).toBeNull();
		// 粘贴进来的 Markdown 图片
		expect(parseBashCommand("![截图](https://example.com/a.png) 这里报错了")).toBeNull();
		// 带了图片 / 文件 / 引用的是发给模型看的
		expect(parseBashCommand("!ls", true)).toBeNull();
	});
});
