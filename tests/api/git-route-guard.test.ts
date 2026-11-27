/**
 * F2：/api/git 的 GET 会起 Git 子进程并返回本地仓库信息，因此只读方法也要过跨站校验。
 * 浏览器跨站请求必带 Origin 或 Sec-Fetch-Site: cross-site；curl/服务端调用无 Origin 照旧放行。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ info: vi.fn(), diff: vi.fn(), show: vi.fn(), home: vi.fn(), consent: vi.fn() }));
vi.mock("@/lib/git-service", () => ({ gitInfo: deps.info, gitDiff: deps.diff, gitShow: deps.show }));
vi.mock("@/lib/workspace-store", () => ({ isHomeWorkspace: deps.home, getGrowthInitConsent: deps.consent }));

import { GET } from "@/app/api/git/route";

const HOST = "127.0.0.1:30141";

function request(path = "/api/git?cwd=%2Fproject", headers: Record<string, string> = {}): Request {
	return new Request(`http://${HOST}${path}`, { headers });
}

beforeEach(() => {
	vi.resetAllMocks();
	deps.info.mockResolvedValue({ available: true, isRepo: true, root: "/project" });
	deps.diff.mockResolvedValue("");
	deps.show.mockResolvedValue("");
});

describe("/api/git GET cross-site protection", () => {
	it("rejects a cross-origin Origin before running git", async () => {
		const response = await GET(request(undefined, { origin: "https://evil.test" }));
		expect(response.status).toBe(403);
		expect(deps.info).not.toHaveBeenCalled();
	});

	it("rejects a browser-reported cross-site request even with a matching Origin", async () => {
		const response = await GET(request(undefined, { origin: `http://${HOST}`, "sec-fetch-site": "cross-site" }));
		expect(response.status).toBe(403);
		expect(deps.info).not.toHaveBeenCalled();
	});

	it("rejects a same-host Origin with a different scheme", async () => {
		const response = await GET(request(undefined, { origin: `https://${HOST}` }));
		expect(response.status).toBe(403);
		expect(deps.info).not.toHaveBeenCalled();
	});

	it("allows same-origin browser requests and requests without Origin", async () => {
		const sameOrigin = await GET(request(undefined, { origin: `http://${HOST}`, "sec-fetch-site": "same-origin" }));
		expect(sameOrigin.status).toBe(200);
		expect(deps.info).toHaveBeenCalledTimes(1);

		const nonBrowser = await GET(request());
		expect(nonBrowser.status).toBe(200);
		expect(deps.info).toHaveBeenCalledTimes(2);
		expect(nonBrowser.headers.get("Cache-Control")).toContain("no-store");
	});

	it.each(["1", "lines"])("skips the %s Git summary for home until recording is explicitly enabled", async (mode) => {
		deps.home.mockResolvedValue(true);
		deps.consent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const summary = () => request("/api/git?cwd=%2Fhome%2Fuser&summary=" + mode);
		expect(await (await GET(summary())).json()).toEqual({ success: true, data: null });
		expect(deps.info).not.toHaveBeenCalled();
		expect((await GET(summary())).status).toBe(200);
		expect(deps.info).toHaveBeenCalledWith("/home/user", mode === "lines" ? "lines" : true);
	});
});
