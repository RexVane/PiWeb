import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import icons from "../src/lib/file-icons.json";
import { fileIconSrc, folderIconSrc } from "../src/lib/file-icons";

const iconDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/file-icons");

it("ships every mapped file icon and both states of every folder icon", () => {
	const ids = new Set([...Object.values(icons.defaults), ...Object.values(icons.ext), ...Object.values(icons.name)]);
	for (const id of Object.values(icons.folder)) {
		ids.add(id);
		ids.add(`${id}-open`);
	}
	for (const id of ids) expect(fs.existsSync(path.join(iconDir, `${id}.svg`)), id).toBe(true);
	expect(fileIconSrc("example.test.ts")).toMatch(/\/file-icons\/.*\.svg$/);
	expect(folderIconSrc("src", true)).toMatch(/-open\.svg$/);
});
