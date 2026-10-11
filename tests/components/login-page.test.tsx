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

/** /api/web-auth 的响应外壳 */
const auth = (data: Record<string, unknown>) => ({ json: async () => ({ success: true, data }) }) as unknown as Response;

beforeEach(() => {
	replace.mockReset();
	// passwordConfigured 决定登录页给密码框还是给启动令牌提示
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(auth({ enabled: true, authenticated: false, passwordConfigured: true })));
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

it("shows the launch-token hint instead of a password form when no password is configured", async () => {
	// 认证只靠启动令牌打开时根本没有密码可输，摆密码框就是死表单：怎么填都错
	vi.mocked(fetch).mockResolvedValue(auth({ enabled: true, authenticated: false, passwordConfigured: false }));
	render(<LoginPage />);
	await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/web-auth"));
	await screen.findByText("这个实例用启动令牌登录");
	expect(screen.queryByPlaceholderText("密码")).toBeNull();
	expect(screen.queryByRole("button", { name: "登录" })).toBeNull();
	expect(replace).not.toHaveBeenCalled();
});
