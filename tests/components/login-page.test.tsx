// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(auth({ enabled: true, authenticated: false })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows only the launch-token hint to anonymous users", async () => {
	render(<LoginPage />);
	await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/web-auth"));
	await screen.findByText("这个实例用启动令牌登录");
	// 密码登录已移除：这里不该再有任何凭据输入或提交按钮
	expect(screen.queryByPlaceholderText("密码")).toBeNull();
	expect(screen.queryByRole("button", { name: "登录" })).toBeNull();
	expect(document.querySelector("input")).toBeNull();
	expect(replace).not.toHaveBeenCalled();
});

it("leaves for the next target when the session is already valid", async () => {
	vi.mocked(fetch).mockResolvedValue(auth({ enabled: true, authenticated: true }));
	render(<LoginPage />);
	await waitFor(() => expect(replace).toHaveBeenCalledWith("/?session=review"));
});

it("leaves when authentication is not enabled", async () => {
	vi.mocked(fetch).mockResolvedValue(auth({ enabled: false, authenticated: true }));
	render(<LoginPage />);
	await waitFor(() => expect(replace).toHaveBeenCalledWith("/?session=review"));
});
