import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_SCAN_LIMIT, MAX_SCAN_LIMIT, MAX_IMPORT_SELECTION } from "@/lib/session-import/limits";

const mocks = vi.hoisted(() => ({ scan: vi.fn(), importSessions: vi.fn() }));
vi.mock("@/lib/pi", () => ({ getAgentDir: () => "/test-agent" }));
vi.mock("@/lib/workspace-store", () => ({ registerCwds: vi.fn() }));
vi.mock("@/lib/session-import", () => ({ scanAllSources: mocks.scan, importSessions: mocks.importSessions }));
vi.mock("@/lib/session-import/writer", () => ({ importedKey: (source: string, id: string) => `${source}:${id}` }));

import { GET, POST } from "@/app/api/sessions/import/route";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.scan.mockResolvedValue({
		summaries: [{ source: "claude", externalId: "one", title: "Example", location: "/private/source.jsonl" }],
		errors: [], imported: [], archived: [], hasMore: { claude: true },
	});
});

describe("导入扫描范围", () => {
	it("默认范围和是否还有更早会话由 API 返回，内部路径不泄露", async () => {
		const response = await GET(new Request("http://localhost/api/sessions/import"));
		expect(response.status).toBe(200);
		expect(mocks.scan).toHaveBeenCalledWith("/test-agent", { limit: INITIAL_SCAN_LIMIT });
		const body = await response.json();
		expect(body.data).toMatchObject({ limit: INITIAL_SCAN_LIMIT, hasMore: { claude: true } });
		expect(body.data.sessions[0]).not.toHaveProperty("location");
	});

	it("扩大扫描只接受边界内的整数", async () => {
		const response = await GET(new Request(`http://localhost/api/sessions/import?limit=${MAX_SCAN_LIMIT}`));
		expect(response.status).toBe(200);
		expect(mocks.scan).toHaveBeenCalledWith("/test-agent", { limit: MAX_SCAN_LIMIT });
	});

	it.each(["", "0", "-1", "1.5", "NaN", "Infinity", "abc", String(MAX_SCAN_LIMIT + 1)])("拒绝无效范围 %j，不启动扫描", async (limit) => {
		const response = await GET(new Request(`http://localhost/api/sessions/import?limit=${encodeURIComponent(limit)}`));
		expect(response.status).toBe(400);
		expect(mocks.scan).not.toHaveBeenCalled();
	});

	it("超过单批上限时不执行导入", async () => {
		const response = await POST(new Request("http://localhost/api/sessions/import", { method: "POST", body: JSON.stringify({ sessions: Array.from({ length: MAX_IMPORT_SELECTION + 1 }, (_, index) => ({ source: "claude", externalId: String(index) })) }) }));
		expect(response.status).toBe(400);
		expect(mocks.importSessions).not.toHaveBeenCalled();
	});
});
