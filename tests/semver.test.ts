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
	it("rejects suffix garbage, empty segments, leading zeros and oversized core numbers", () => {
		for (const raw of ["2.0.0junk", "2.0.0-beta..1", "2.0.0-beta.01", "02.0.0", "2.0.0+build..1", "999999999999999999.0.0"]) expect(parseVersion(raw)).toBeNull();
		expect(parseVersion("2.0.0+build.1")).toEqual({ nums: [2, 0, 0], pre: [] });
		expect(isNewer("2.0.0-999999999999999999999", "2.0.0-999999999999999999998")).toBe(true);
	});
});
