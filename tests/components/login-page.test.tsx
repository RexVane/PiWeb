// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LoginPage from "../../src/app/login/page";

const { router } = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
const { replace } = router;
vi.mock("next/navigation", () => ({
	useRouter: () => router,
	useSearchParams: () => new URLSearchParams("next=%2F%3Fsession%3Dreview"),
}));

beforeEach(() => {
	replace.mockReset();
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ success: true, data: { enabled: true, authenticated: false } }) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("leaves anonymous users on the login form and follows a successful login", async () => {
	render(<LoginPage />);
	const input = screen.getByPlaceholderText("密码");
	await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/web-auth"));
	expect(replace).not.toHaveBeenCalled();
	vi.mocked(fetch).mockResolvedValueOnce({ status: 200, json: async () => ({ success: true, data: { next: "/?session=review" } }) } as Response);
	fireEvent.change(input, { target: { value: "test-password" } });
	fireEvent.click(screen.getByRole("button", { name: "登录" }));
	await waitFor(() => expect(replace).toHaveBeenCalledWith("/?session=review"));
});

it("does not accept an external redirect returned by the login endpoint", async () => {
	render(<LoginPage />);
	await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/web-auth"));
	vi.mocked(fetch).mockResolvedValueOnce({ status: 200, json: async () => ({ success: true, data: { next: "https://outside.example" } }) } as Response);
	fireEvent.change(screen.getByPlaceholderText("密码"), { target: { value: "test-password" } });
	fireEvent.click(screen.getByRole("button", { name: "登录" }));
	await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
});
