import { describe, expect, it, vi } from "vitest";
const open = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ default: { open } }));
import { readFileBounded } from "../src/lib/read-file-bounded";

describe("bounded file reads", () => {
	it("rejects a file growing after stat and closes its handle", async () => {
		const close = vi.fn();
		let calls = 0;
		open.mockResolvedValue({ stat: async () => ({ size: 2, isFile: () => true }), close,
			read: async (buffer: Buffer) => { calls++; buffer.fill(120); return { bytesRead: buffer.length }; } });
		await expect(readFileBounded("fixture", 8)).rejects.toThrow("grew");
		expect(calls).toBe(1); expect(close).toHaveBeenCalledOnce();
	});
	it("keeps an empty regular file readable", async () => {
		const close = vi.fn();
		open.mockResolvedValue({ stat: async () => ({ size: 0, isFile: () => true }), read: async () => ({ bytesRead: 0 }), close });
		expect(await readFileBounded("fixture", 8)).toEqual(Buffer.alloc(0)); expect(close).toHaveBeenCalledOnce();
	});
});
