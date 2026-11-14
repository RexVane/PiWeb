import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { recycleTemporaryDirectory } from "../src/lib/recycle-temporary";

it("recycles the owned export directory, including quoted filenames", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-export-quoted'-"));
	await fs.writeFile(path.join(directory, "session.html"), "temporary export");
	await recycleTemporaryDirectory(directory);
	await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
}, 40_000);
it("refuses to recycle an arbitrary user directory", async () => {
	await expect(recycleTemporaryDirectory(os.homedir())).rejects.toThrow("Unexpected temporary directory");
});
