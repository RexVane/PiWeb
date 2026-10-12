import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelFilesFingerprint, reloadStoredCredentials } from "../src/lib/model-files";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-model-files-"));
});

afterEach(async () => {
	if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith("piweb-model-files-")) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("modelFilesFingerprint", () => {
	it("reports missing files, and changes when a file is created, resized, or removed", async () => {
		const missing = modelFilesFingerprint(dir);
		expect(missing).toBe("models.json:-|auth.json:-");

		await fs.writeFile(path.join(dir, "models.json"), "{}");
		const created = modelFilesFingerprint(dir);
		expect(created).not.toBe(missing);
		expect(modelFilesFingerprint(dir)).toBe(created);

		await fs.writeFile(path.join(dir, "models.json"), '{"providers":{}}');
		expect(modelFilesFingerprint(dir)).not.toBe(created);

		await fs.rm(path.join(dir, "models.json"));
		expect(modelFilesFingerprint(dir)).toBe(missing);
	});

	it("ignores other files in the agent directory", async () => {
		const before = modelFilesFingerprint(dir);
		await fs.writeFile(path.join(dir, "settings.json"), "{}");
		expect(modelFilesFingerprint(dir)).toBe(before);
	});
});

describe("reloadStoredCredentials", () => {
	it("makes a hand-edited auth.json visible to the real SDK runtime", async () => {
		// 用真实 SDK：它的 auth 存储第一次读后会缓存，这里验证我们走的内部路径确实能让它重读
		const authPath = path.join(dir, "auth.json");
		await fs.writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "old-key" } }));
		const runtime = await ModelRuntime.create({
			modelsPath: null, authPath, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
		});
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("old-key");

		await fs.writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "new-key" } }));
		reloadStoredCredentials(runtime);
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("new-key");
	});

	it("does nothing for a runtime without the internal store (unknown SDK shape)", () => {
		expect(() => reloadStoredCredentials({})).not.toThrow();
	});
});
