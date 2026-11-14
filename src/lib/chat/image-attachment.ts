import type { ImageAttachment } from "../types";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_IMAGES_BASE64 = 8_000_000;
export const MAX_MESSAGE_CHARS = 200_000;

function readData(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
		reader.onerror = () => reject(new Error("Image could not be read"));
		reader.onabort = () => reject(new Error("Image reading was cancelled"));
		reader.readAsDataURL(file);
	});
}

/** Large images are resized before base64 enters a draft or the session history. */
export async function prepareImageAttachment(file: File): Promise<ImageAttachment> {
	if (file.size > 20 * 1024 * 1024) throw new Error("Image exceeds 20 MB");
	if (file.type === "image/gif" && file.size > MAX_IMAGE_BYTES) throw new Error("GIF exceeds 2 MB; resizing would lose its animation");
	if (file.size <= MAX_IMAGE_BYTES) return { type: "image", data: await readData(file), mimeType: file.type };
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Image compression is unavailable");
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		for (const quality of [0.85, 0.65, 0.45]) {
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
			if (blob && blob.size <= MAX_IMAGE_BYTES) return { type: "image", data: await readData(blob), mimeType: "image/jpeg" };
		}
		throw new Error("Image is too large after compression");
	} finally { bitmap.close(); }
}
