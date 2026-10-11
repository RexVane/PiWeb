import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exportSession: vi.fn() }));
vi.mock("@/lib/agent-manager", () => ({ getManaged: (sessionPath: string) => ({ sessionPath }), exportSession: mocks.exportSession }));
vi.mock("@/lib/path-security", () => ({ BoundaryError: class extends Error {}, resolveSessionPath: async (id: string) => `/sessions/${id}` }));

import { GET } from "../../src/app/api/sessions/[id]/export/route";

describe("session export download name", () => {
	it("sends the UTF-8 name in filename* with an ASCII fallback", async () => {
		// 回归：只写百分号编码的 filename= 时浏览器不解码，中文名下载下来是 %E9%87%8D%E6%9E%84…
		mocks.exportSession.mockResolvedValue({ filename: "重构 \"登录\"(1).jsonl", content: "{}\n", contentType: "application/jsonl" });
		const response = await GET(new Request("http://localhost/api/sessions/abc/export"), { params: Promise.resolve({ id: "abc" }) });
		const disposition = response.headers.get("Content-Disposition") ?? "";
		expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
		expect(disposition).not.toMatch(/filename="[^"]*%/);
		const encoded = /filename\*=UTF-8''(.+)$/.exec(disposition)![1];
		expect(encoded).not.toMatch(/['()*\s"]/);
		expect(decodeURIComponent(encoded)).toBe("重构 \"登录\"(1).jsonl");
	});
});
