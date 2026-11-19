import { afterEach, expect, it, vi } from "vitest";
import { PHASE_PRODUCTION_SERVER, PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import config from "../next.config";
afterEach(() => { vi.unstubAllEnvs(); });
it("fails closed for authenticated raw Next entrypoints while allowing build/typegen configuration", () => {
	vi.stubEnv("PI_WEB_AUTH", "1");
	vi.stubEnv("PIWEB_HTTP_GUARD", "0");
	vi.stubEnv("HOME", process.env.HOME);
	vi.stubEnv("USERPROFILE", process.env.USERPROFILE);
	expect(() => config(PHASE_PRODUCTION_SERVER)).toThrow(/npm start/);
	expect(() => config(PHASE_DEVELOPMENT_SERVER)).toThrow(/npm run dev/);
	expect(config(PHASE_PRODUCTION_BUILD).experimental?.proxyClientMaxBodySize).toBe("12mb");
	expect(config(PHASE_PRODUCTION_BUILD).experimental?.useTypeScriptCli).toBe(true);
	expect(() => config("phase-development-types")).not.toThrow();
});
it("allows explicit local deployments with authentication disabled", () => {
	vi.stubEnv("PI_WEB_AUTH", "0");
	expect(() => config(PHASE_PRODUCTION_SERVER)).not.toThrow();
});
