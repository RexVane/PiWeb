import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeSessionId } from "../src/lib/pi";
import { BoundaryError, isPathInside, resolveSessionPath } from "../src/lib/path-security";

describe("filesystem boundaries", () => {
	it("distinguishes descendants from similarly prefixed siblings", () => {
		const root = path.resolve("test-root");
		expect(isPathInside(root, path.join(root, "child", "file.jsonl"))).toBe(true);
		expect(isPathInside(root, path.resolve(`${root}-other`, "file.jsonl"))).toBe(false);
	});

	it("does not treat an arbitrary encoded file as a Pi session", async () => {
		const id = encodeSessionId(path.resolve("package.json"));
		await expect(resolveSessionPath(id)).rejects.toBeInstanceOf(BoundaryError);
	});
});
