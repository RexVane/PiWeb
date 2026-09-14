import { describe, expect, it } from "vitest";
import { isNewer, parseVersion } from "../src/lib/semver";

describe("semver", () => {
	it("parses plain and prerelease versions", () => {
		expect(parseVersion("v0.4.0")).toEqual({ nums: [0, 4, 0], pre: [] });
		expect(parseVersion("0.4.0-beta.1")).toEqual({ nums: [0, 4, 0], pre: ["beta", "1"] });
		expect(parseVersion("garbage")).toBeNull();
	});
	it("compares numeric parts", () => {
		expect(isNewer("0.4.0", "0.3.0")).toBe(true);
		expect(isNewer("0.3.0", "0.4.0")).toBe(false);
		expect(isNewer("0.3.0", "0.3.0")).toBe(false);
		expect(isNewer("1.0.0", "0.99.99")).toBe(true);
	});
	it("treats a release as newer than its own prerelease and orders prereleases", () => {
		expect(isNewer("0.4.0", "0.4.0-beta.1")).toBe(true);
		expect(isNewer("0.4.1", "0.4.0-beta.1")).toBe(true);
		expect(isNewer("0.4.0-beta.2", "0.4.0-beta.1")).toBe(true);
		expect(isNewer("0.4.0-beta.1", "0.4.0-beta.2")).toBe(false);
		expect(isNewer("0.4.0-beta.1", "0.4.0")).toBe(false);
		expect(isNewer("0.4.0-rc.1", "0.4.0-beta.9")).toBe(true);
		expect(isNewer("0.4.0-beta.1.1", "0.4.0-beta.1")).toBe(true);
	});
	it("never reports newer when either side is unparseable", () => {
		expect(isNewer("latest", "0.4.0")).toBe(false);
		expect(isNewer("0.4.0", "")).toBe(false);
	});
});
