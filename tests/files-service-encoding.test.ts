import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readWorkspaceFile } from "../src/lib/files-service";
import { recycleFixture } from "./fixtures/recycle";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-encoding-")); });
afterEach(async () => { await recycleFixture(root); });
const text = "中文文本 😀\nsecond line";
it.each(["utf8-bom", "utf16-le", "utf16-be"])("reads real %s files without BOM, binary misclassification or replacement glyphs", async (encoding) => {
	const body = Buffer.from(text, encoding === "utf8-bom" ? "utf8" : "utf16le");
	if (encoding === "utf16-be") body.swap16();
	const bom = Buffer.from(encoding === "utf8-bom" ? [239, 187, 191] : encoding === "utf16-le" ? [255, 254] : [254, 255]);
	await fs.writeFile(path.join(root, "text.txt"), Buffer.concat([bom, body]));
	const result = await readWorkspaceFile(root, "text.txt");
	expect(result.binary).toBe(false); expect(result.encodingUnsupported).toBeUndefined();
	expect(result.content).toBe(text); expect(result.truncated).toBe(false);
});
it("flags an actual GBK payload and malformed complete UTF-8 instead of returning silent replacement text", async () => {
	for (const [name, bytes] of [["gbk.txt", Buffer.from([0xd6, 0xd0, 0xce, 0xc4])], ["broken.txt", Buffer.from([0x61, 0xe4, 0xb8])]] as const) {
		await fs.writeFile(path.join(root, name), bytes);
		const result = await readWorkspaceFile(root, name);
		expect(result).toMatchObject({ binary: false, encodingUnsupported: true, content: "", truncated: false });
	}
});
it("keeps UTF-16 preview reads bounded and does not decode a truncated surrogate pair", async () => {
	const prefix = "a".repeat((256 * 1024 - 2) / 2 - 1);
	await fs.writeFile(path.join(root, "large.txt"), Buffer.concat([Buffer.from([255, 254]), Buffer.from(prefix + "😀" + "尾".repeat(200_000), "utf16le")]));
	const result = await readWorkspaceFile(root, "large.txt");
	expect(result.truncated).toBe(true); expect(result.encodingUnsupported).toBeUndefined();
	expect(result.content).toBe(prefix); expect(result.content).not.toContain("�");
});
