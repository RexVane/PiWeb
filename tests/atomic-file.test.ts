import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomically } from "@/lib/atomic-file";
import { recycleTemporaryDirectory } from "@/lib/recycle-temporary";

let directory: string;
let source: string;
let destination: string;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-export-atomic-test-"));
	source = path.join(directory, "pending");
	destination = path.join(directory, "current");
	await fs.writeFile(source, "new contents");
	await fs.writeFile(destination, "old contents");
});
afterEach(async () => {
	vi.restoreAllMocks();
	await recycleTemporaryDirectory(directory);
});

describe("atomic replacement under sharing contention", () => {
	it.each(["EPERM", "EACCES", "EBUSY"])("retries %s and commits once the target is available", async (code) => {
		const rename = fs.rename.bind(fs);
		let attempts = 0;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			attempts += 1;
			if (attempts < 3) {
				expect(await fs.readFile(destination, "utf8")).toBe("old contents");
				throw Object.assign(new Error("temporarily occupied"), { code });
			}
			await rename(from, to);
		});
		await replaceFileAtomically(source, destination);
		expect(attempts).toBe(3);
		expect(await fs.readFile(destination, "utf8")).toBe("new contents");
		await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("stops after a bounded number of attempts and retains both original files", async () => {
		const failure = Object.assign(new Error("still occupied"), { code: "EBUSY" });
		const rename = vi.spyOn(fs, "rename").mockRejectedValue(failure);
		await expect(replaceFileAtomically(source, destination)).rejects.toBe(failure);
		expect(rename).toHaveBeenCalledTimes(10);
		expect(await fs.readFile(destination, "utf8")).toBe("old contents");
		expect(await fs.readFile(source, "utf8")).toBe("new contents");
	});

	it("does not retry unrelated I/O errors", async () => {
		const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
		const rename = vi.spyOn(fs, "rename").mockRejectedValue(failure);
		await expect(replaceFileAtomically(source, destination)).rejects.toBe(failure);
		expect(rename).toHaveBeenCalledTimes(1);
		expect(await fs.readFile(destination, "utf8")).toBe("old contents");
	});

	it("revalidates before a retry and preserves an intervening edit", async () => {
		const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
			await fs.writeFile(destination, "external edit");
			throw Object.assign(new Error("occupied"), { code: "EBUSY" });
		});
		const validate = vi.fn(async () => {
			if (await fs.readFile(destination, "utf8") !== "old contents") throw new Error("version conflict");
		});
		await expect(replaceFileAtomically(source, destination, validate)).rejects.toThrow("version conflict");
		expect(validate).toHaveBeenCalledTimes(2);
		expect(rename).toHaveBeenCalledTimes(1);
		expect(await fs.readFile(destination, "utf8")).toBe("external edit");
	});
});
