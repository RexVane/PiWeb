// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

vi.mock("next/dynamic", () => ({ default: () => ({ text }: { text: string }) => <div>{text}</div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const path = "/historical/deleted/skills/probe/SKILL.md";
const content = "# Historical skill\n\nPrivate instructions from that turn.";
const envelope = `<skill name="probe" location="${path}">\n${content}\n</skill>`;
const message = (text: string, index = 0): WebMessage => ({ id: `user-${index}`, role: "user", content: [{ type: "text", text }], timestamp: index });

describe("sent skill presentation", () => {
	it("shows only the highlighted skill and user text, opening the embedded document without a disk request", () => {
		const onOpen = vi.fn();
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const text = `${envelope}\n\nActual question\nSecond line`;
		const messages = [message(text)];
		const { container } = render(<ChatWindow messages={messages} tools={{}} onOpenFileContent={onOpen} />);
		expect(screen.getByText(/Actual question\s+Second line/)).toBeTruthy();
		expect(container.textContent).not.toContain(content);
		expect(container.textContent).not.toContain("<skill name=");
		fireEvent.click(screen.getByRole("button", { name: "/skill:probe" }));
		expect(onOpen).toHaveBeenCalledWith(path, content);
		expect(fetcher).not.toHaveBeenCalled();
		expect(messages[0].content).toEqual([{ type: "text", text }]);
	});

	it("still renders a skill-only message without dumping its instructions", () => {
		const { container } = render(<ChatWindow messages={[message(envelope)]} tools={{}} onOpenFileContent={vi.fn()} />);
		expect(screen.getByRole("button", { name: "/skill:probe" })).toBeTruthy();
		expect(container.textContent).not.toContain("Historical skill");
	});

	it("keeps old, lazy-rendered turns compact and clickable too", () => {
		const onOpen = vi.fn();
		const messages = [message(`${envelope}\n\nOld question`), ...Array.from({ length: 10 }, (_, index) => message(`Question ${index}`, index + 1))];
		const { container } = render(<ChatWindow messages={messages} tools={{}} onOpenFileContent={onOpen} />);
		expect(container.textContent).not.toContain(content);
		fireEvent.click(screen.getByRole("button", { name: "/skill:probe" }));
		expect(onOpen).toHaveBeenCalledWith(path, content);
	});

	it("does not fold quoted skill examples or code fences in ordinary messages", () => {
		const text = `Example:\n\`\`\`xml\n${envelope}\n\`\`\``;
		const { container } = render(<ChatWindow messages={[message(text)]} tools={{}} onOpenFileContent={vi.fn()} />);
		expect(screen.queryByRole("button", { name: "/skill:probe" })).toBeNull();
		expect(container.textContent).toContain(content);
	});
});
