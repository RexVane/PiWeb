import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNode } from "@/instrumentation-node";

const mocks = vi.hoisted(() => ({ publish: vi.fn(), connect: vi.fn(), scheduler: vi.fn() }));
vi.mock("@/lib/web-launch-token", () => ({ publishLaunchToken: mocks.publish }));
vi.mock("@/lib/update/startup-check", () => ({ ensureStartupCheck: async () => {} }));
vi.mock("@/lib/resources/host", () => ({ startResourceHost: mocks.scheduler }));
vi.mock("@/lib/remote/supervisor", () => ({
	remoteLanEnabled: () => process.env.PIWEB_REMOTE_LAN !== "0",
	remoteBlocked: () => process.env.PI_WEB_AUTH === "0" ? "auth" : process.env.NODE_ENV === "development" ? "dev" : null,
	ensureRemoteAccess: mocks.connect,
}));

beforeEach(() => {
	vi.stubEnv("NEXT_PHASE", "");
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("PI_WEB_AUTH", "");
	vi.stubEnv("PI_WEB_LAUNCH_TOKEN", "");
	vi.stubEnv("PIWEB_REMOTE_LAN", "1");
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.publish.mockReset();
	mocks.scheduler.mockReset();
	mocks.connect.mockReset().mockResolvedValue({ lan: { running: true, urls: ["http://192.168.1.2:30142"] } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("remote startup defaults", () => {
	it("enables authentication, prepares a credential and starts remote access without a switch", async () => {
		await registerNode();
		expect(process.env.PI_WEB_AUTH).toBe("1");
		expect(process.env.PI_WEB_LAUNCH_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(mocks.publish).toHaveBeenCalledOnce();
		expect(mocks.connect).toHaveBeenCalledOnce();
	});

	it("preserves the launcher credential and does not expose development mode", async () => {
		vi.stubEnv("PI_WEB_LAUNCH_TOKEN", "existing-launcher-token");
		vi.stubEnv("NODE_ENV", "development");
		await registerNode();
		expect(process.env.PI_WEB_AUTH).toBe("1");
		expect(process.env.PI_WEB_LAUNCH_TOKEN).toBe("existing-launcher-token");
		expect(mocks.connect).not.toHaveBeenCalled();
	});

	it("honors an explicit deployment opt-out without opening an unauthenticated entry", async () => {
		vi.stubEnv("PI_WEB_AUTH", "0");
		await registerNode();
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(mocks.connect).not.toHaveBeenCalled();
	});

	it("does not change credentials or open a connection during a production build", async () => {
		vi.stubEnv("NEXT_PHASE", "phase-production-build");
		await registerNode();
		expect(process.env.PI_WEB_AUTH).toBe("");
		expect(process.env.PI_WEB_LAUNCH_TOKEN).toBe("");
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(mocks.connect).not.toHaveBeenCalled();
	});
});
