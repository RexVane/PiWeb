// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionHistory } from "@/components/SessionHistory";
import { PreviewImage } from "@/components/PreviewImage";
import { ChatWindow } from "@/components/ChatWindow";
vi.mock("@/components/MarkdownBlock", () => ({ MarkdownBlock: ({ text }: { text: string }) => <div>{text}</div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const message = (id: string) => ({ id, role: "user", content: [{ type: "text", text: id }] });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status === 200, data }), { status });

it("replaces pages and can move earlier, newer, and back to the latest page", async () => {
	const fetch = vi.fn().mockResolvedValueOnce(reply({ messages: [message("latest")], total: 300, pageStart: 200, pageEnd: 300, olderBefore: 200 }))
		.mockResolvedValueOnce(reply({ messages: [message("earlier")], total: 300, pageStart: 100, pageEnd: 200, olderBefore: 100, newerAfter: 200 }))
		.mockResolvedValueOnce(reply({ messages: [message("newer")], total: 300, pageStart: 200, pageEnd: 300, olderBefore: 200 }))
		.mockResolvedValueOnce(reply({ messages: [message("latest-again")], total: 301, pageStart: 201, pageEnd: 301, olderBefore: 201 }));
	vi.stubGlobal("fetch", fetch);
	render(<SessionHistory sessionId="session" onClose={() => {}} />);
	await screen.findByText("latest"); fireEvent.click(screen.getByRole("button", { name: "更早一页" }));
	await screen.findByText("earlier"); expect(screen.queryByText("latest")).toBeNull();
	expect(String(fetch.mock.calls[1][0])).toContain("before=200");
	fireEvent.click(screen.getByRole("button", { name: "较新一页" })); await screen.findByText("newer");
	expect(String(fetch.mock.calls[2][0])).toContain("after=200"); expect(screen.queryByText("earlier")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "最新一页" })); await screen.findByText("latest-again");
	expect(String(fetch.mock.calls[3][0])).not.toMatch(/before=|after=/);
	expect(screen.getByText(/更早的消息仍然保存在会话中/)).toBeTruthy();
});
it("cancels an old session request and ignores its late page", async () => {
	let complete!: (response: Response) => void;
	const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }))
		.mockResolvedValueOnce(reply({ messages: [message("session-b")], total: 1, pageStart: 0, pageEnd: 1 }));
	vi.stubGlobal("fetch", fetch);
	const { rerender } = render(<SessionHistory sessionId="a" onClose={() => {}} />);
	rerender(<SessionHistory sessionId="b" onClose={() => {}} />);
	await screen.findByText("session-b");
	expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
	await act(async () => { complete(reply({ messages: [message("wrong-session")], total: 1, pageStart: 0, pageEnd: 1 })); });
	expect(screen.queryByText("wrong-session")).toBeNull();
});
it("keeps the current page visible when navigation fails and permits retry", async () => {
	const fetch = vi.fn().mockResolvedValueOnce(reply({ messages: [message("kept")], total: 200, pageStart: 100, pageEnd: 200, olderBefore: 100 }))
		.mockResolvedValueOnce(reply({}, 500)).mockResolvedValueOnce(reply({ messages: [message("recovered")], total: 200, pageStart: 0, pageEnd: 100, newerAfter: 100 }));
	vi.stubGlobal("fetch", fetch); render(<SessionHistory sessionId="s" onClose={() => {}} />);
	await screen.findByText("kept"); fireEvent.click(screen.getByRole("button", { name: "更早一页" }));
	await screen.findByRole("alert"); expect(screen.getByText("kept")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "重试" })); await screen.findByText("recovered");
});
it("loads a persisted image URL in both the thumbnail and viewer without base64 data", async () => {
	const image = { type: "image" as const, data: "", mimeType: "image/png", url: "/api/sessions/session/images?entry=e&part=0" };
	render(<PreviewImage image={image} />);
	expect(document.querySelector("img")?.getAttribute("src")).toBe(image.url);
	fireEvent.click(screen.getByRole("button", { name: "点击放大预览" }));
	await waitFor(() => expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toBe(image.url));
});
it("keeps persisted image URLs in user and assistant chat rendering", async () => {
	const first = { type: "image" as const, data: "", mimeType: "image/png", url: "/api/sessions/s/images?entry=u&part=1" };
	const second = { ...first, url: "/api/sessions/s/images?entry=a&part=1" };
	render(<ChatWindow messages={[{ id: "u", role: "user", content: [{ type: "text", text: "question" }, first] }, { id: "a", role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }, second] }]} tools={{}} isStreaming={false} />);
	await waitFor(() => expect([...document.querySelectorAll("img")].map((item) => item.getAttribute("src"))).toEqual(expect.arrayContaining([first.url, second.url])));
});
it("does not load external or executable URLs in persisted image previews", () => {
	render(<PreviewImage image={{ type: "image", data: "", mimeType: "image/png", url: "javascript:alert(1)" }} />);
	expect(document.querySelector("img")?.hasAttribute("src")).toBe(false);
	expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
});
it.each(["/\n/external.example/image.png", "/\t/external.example/image.png", "/\\external.example/image.png"])("rejects browser-normalized external image URLs: %j", (url) => {
	expect(new URL(url, "https://piweb.example").hostname).toBe("external.example");
	render(<PreviewImage image={{ type: "image", data: "", mimeType: "image/png", url }} />);
	expect(document.querySelector("img")?.hasAttribute("src")).toBe(false);
	expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
});
