import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { installPiRuntime, piRuntimeSpecs, verifyPiRuntimePins } from "../../scripts/runtime/pi-packages.mjs";

const names = [
	"@earendil-works/pi-coding-agent", "@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core", "@earendil-works/pi-codemode",
	"@earendil-works/pi-mcp", "@earendil-works/pi-telemetry", "@earendil-works/pi-tui",
];
const pinned = (version = "1.1.0") => ({ dependencies: Object.fromEntries(names.map((name) => [name, version])) });

// A checkout's lock masked this failure: newly installed 0.3.22 could use codemode 1.2.
describe("published Pi runtime dependencies", () => {
	it("keeps every runtime package pinned in both the manifest and checkout lock", async () => {
		const manifest = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"));
		const lock = JSON.parse(await fs.readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
		const version = verifyPiRuntimePins(manifest);
		for (const name of names) {
			expect(lock.packages[""].dependencies[name]).toBe(version);
			expect(lock.packages["node_modules/" + name].version).toBe(version);
		}
	});

	it("rejects the 0.3.22 manifest that only pins the two public SDK entry points", () => {
		expect(() => verifyPiRuntimePins({ dependencies: {
			"@earendil-works/pi-coding-agent": "1.1.0", "@earendil-works/pi-ai": "1.1.0",
		} })).toThrow(/must be pinned/);
	});

	it.each([undefined, "^1.1.0", "1.2.0"])("rejects missing, ranged or mismatched codemode: %s", (version) => {
		const manifest = pinned();
		manifest.dependencies["@earendil-works/pi-codemode"] = version as string;
		expect(() => verifyPiRuntimePins(manifest)).toThrow(/pi-codemode.*pinned to 1\.1\.0/);
	});
});

describe("coordinated Pi runtime upgrades", () => {
	function context(version = "1.2.0") {
		const run = vi.fn(async (_command: string, args: string[]) => args[0] === "view" ? version + "\n" : "");
		return { root: "installation", env: {}, run };
	}

	it("resolves latest once and installs every package at the same exact release", async () => {
		const ctx = context();
		expect(await installPiRuntime(ctx)).toBe("1.2.0");
		expect(ctx.run.mock.calls.map(([, args]) => args)).toEqual([
			["view", "@earendil-works/pi-coding-agent@latest", "version"],
			["install", "--save-exact", ...names.map((name) => name + "@1.2.0"), "--no-audit", "--no-fund"],
		]);
	});

	it("supports a production install without adding development dependencies", async () => {
		const ctx = context();
		await installPiRuntime(ctx, { omitDev: true });
		expect(ctx.run.mock.calls[1][1]).toContain("--omit=dev");
	});

	it("checks for active sessions again after the registry lookup and before installation", async () => {
		const ctx = context();
		const idle = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("session running"));
		await expect(installPiRuntime(ctx, { assertIdle: idle })).rejects.toThrow("session running");
		expect(ctx.run.mock.calls.map(([, args]) => args[0])).toEqual(["view"]);
	});

	it.each(["", "latest", "^1.2.0", "1.2.0\n1.3.0", "1.2.0 --force"])("rejects invalid registry versions before install: %s", async (version) => {
		const ctx = context(version);
		await expect(installPiRuntime(ctx)).rejects.toThrow(/exact version/);
		expect(ctx.run).toHaveBeenCalledTimes(1);
	});

	it("preserves exact prerelease versions", () => {
		expect(piRuntimeSpecs("1.3.0-beta.1")).toContain("@earendil-works/pi-codemode@1.3.0-beta.1");
	});
});
