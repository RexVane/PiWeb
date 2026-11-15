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
const auth = (data: Record<string, unknown>, ok = true, status = 200) =>
	({ ok, status, json: async () => ({ success: ok, ...(ok ? { data } : data) }) }) as unknown as Response;

beforeEach(() => {
	replace.mockReset();
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(auth({ enabled: true, authenticated: false })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows the launch-token / pair-code form (and no legacy password field) to anonymous users", async () => {
	render(<LoginPage />);
	await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/web-auth"));
	await screen.findByText("这个实例用启动令牌登录");
	expect(screen.queryByPlaceholderText("密码")).toBeNull();
	expect(screen.getByLabelText("启动令牌或配对码")).toBeTruthy();
	expect(screen.getByRole("button", { name: "验证并登录" })).toBeTruthy();
	expect(replace).not.toHaveBeenCalled();
});

it("submits credential via POST /api/web-auth and redirects on success", async () => {
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") return auth({ authenticated: true });
		return auth({ enabled: true, authenticated: false });
	});
	vi.stubGlobal("fetch", fetchMock);
	render(<LoginPage />);
	const input = await screen.findByLabelText("启动令牌或配对码");
	fireEvent.change(input, { target: { value: "tok-12345" } });
	fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
	await waitFor(() => expect(replace).toHaveBeenCalledWith("/?session=review"));
	const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
	expect(postCall?.[0]).toBe("/api/web-auth");
	expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ credential: "tok-12345" });
});

it("shows an error alert and stays on the page when credential verification fails", async () => {
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") return auth({ error: "invalid credential" }, false, 401);
		return auth({ enabled: true, authenticated: false });
	});
	vi.stubGlobal("fetch", fetchMock);
	render(<LoginPage />);
	const input = await screen.findByLabelText("启动令牌或配对码");
	fireEvent.change(input, { target: { value: "bad-token" } });
	fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("凭据无效或已过期");
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
