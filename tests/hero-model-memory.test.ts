import { describe, expect, it } from "vitest";
import { readRememberedHeroModel, writeRememberedHeroModel } from "../src/lib/hero-model-memory";

/** 只实现读写两个方法的内存版 localStorage */
function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
	};
}

describe("remembered new-session model", () => {
	it("has nothing for a workspace that never had a choice", () => {
		expect(readRememberedHeroModel(memoryStorage(), "D:\\repo-b")).toBeNull();
	});

	it("keeps each workspace's choice separate, with no fallback to another workspace", () => {
		const storage = memoryStorage();
		writeRememberedHeroModel(storage, "D:\\repo-a", { provider: "anthropic", id: "claude-opus-4-8" });
		expect(readRememberedHeroModel(storage, "D:\\repo-a")).toEqual({ provider: "anthropic", id: "claude-opus-4-8" });
		expect(readRememberedHeroModel(storage, "D:\\repo-b")).toBeNull();
	});

	it("ignores the old global key that earlier builds wrote", () => {
		const storage = memoryStorage({ "piweb.heroModel": JSON.stringify({ provider: "xai", id: "grok-4.7" }) });
		expect(readRememberedHeroModel(storage, "D:\\repo-a")).toBeNull();
	});

	it("treats damaged or wrongly shaped values as nothing chosen", () => {
		const storage = memoryStorage({
			"piweb.heroModel.D:\\bad": "{not json",
			"piweb.heroModel.D:\\shape": JSON.stringify({ provider: 1 }),
		});
		expect(readRememberedHeroModel(storage, "D:\\bad")).toBeNull();
		expect(readRememberedHeroModel(storage, "D:\\shape")).toBeNull();
	});
});
