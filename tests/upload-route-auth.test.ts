/** 上传路由自己做鉴权（不经过 proxy 的请求体克隆）：吊销记录读不了时与 proxy 一样答 503，而不是 401。 */
import { afterEach, expect, it, vi } from "vitest";

const revocations = vi.hoisted(() => ({ unavailable: true }));
vi.mock("@/lib/web-secret", () => ({
	loadWebSecret: () => Buffer.alloc(32, 7),
	loadSessionRevocations: () => (revocations.unavailable
		? { notBefore: Number.MAX_SAFE_INTEGER, revoked: new Map(), unavailable: true }
		: { notBefore: 0, revoked: new Map() }),
}));

import { POST } from "@/app/api/files/upload/route";

afterEach(() => vi.unstubAllEnvs());

const upload = () => POST(new Request("http://127.0.0.1/api/files/upload?name=a.txt", {
	method: "POST", headers: { "content-length": "1", "x-upload-size": "1" }, body: "a",
}));

it("answers 503 when session revocations cannot be read, and 401 for a missing cookie", async () => {
	vi.stubEnv("PI_WEB_AUTH", "1");
	revocations.unavailable = true;
	expect((await upload()).status).toBe(503);
	revocations.unavailable = false;
	expect((await upload()).status).toBe(401);
});
