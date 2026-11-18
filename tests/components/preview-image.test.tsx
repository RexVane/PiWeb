// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreviewImage } from "@/components/PreviewImage";
import { ChatWindow } from "@/components/ChatWindow";

vi.mock("@/components/MarkdownBlock", () => ({ MarkdownBlock: ({ text }: { text: string }) => <div>{text}</div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
