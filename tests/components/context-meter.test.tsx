// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMeter } from "@/components/ContextMeter";

afterEach(cleanup);

const breakdown = {
	systemPrompt: 400,
	systemTools: 200,
	customTools: 100,
	memory: 100,
	skills: 0,
	compacted: 0,
	autoCompactBuffer: 50,
};

describe("ContextMeter", () => {
	it("uses Pi's total rather than category estimates for free space", () => {
		render(<ContextMeter percent={10} tokens={100} contextWindow={1000} source={{ systemChars: 0, messages: [], breakdown }} />);
		fireEvent.click(screen.getByTitle("10% 上下文已用"));
		expect(screen.getByText("剩余空间").parentElement?.textContent).toContain("~900");
		expect(screen.getByText("自动压缩预留（非占用）").parentElement?.textContent).toContain("50");
		expect(screen.getByText(/下方分类按字符估算，不可相加/)).toBeTruthy();
	});

	it("does not invent free space when usage is unknown", () => {
		render(<ContextMeter percent={null} tokens={null} contextWindow={1000} source={{ systemChars: 0, messages: [], breakdown }} />);
		fireEvent.click(screen.getByTitle("上下文用量未知"));
		expect(screen.getByText("剩余空间").parentElement?.textContent).toContain("—");
	});
});
