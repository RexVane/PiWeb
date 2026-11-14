// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES, prepareImageAttachment } from "@/lib/chat/image-attachment";

describe("image preparation", () => {
	it("refuses oversized GIFs before animation could be converted to a still JPEG", async () => {
		const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
		try {
			await expect(prepareImageAttachment(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "animation.gif", { type: "image/gif" }))).rejects.toThrow("lose its animation");
			expect(decode).not.toHaveBeenCalled();
		} finally { vi.unstubAllGlobals(); }
	});
});
