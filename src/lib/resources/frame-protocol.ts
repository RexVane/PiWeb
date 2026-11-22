/** Browser-side protocol validation; sandboxed frames never choose their own resource, workspace or session. */
import { RESOURCE_FRAME_CHANNEL, RESOURCE_BROWSER_CAPABILITIES, type JsonValue } from "./protocol";

export function safeResourceViewUrl(value: string): boolean {
	return /^\/api\/resources\/views\/[A-Za-z0-9_-]+\/assets\/[A-Za-z0-9._%-]+\.html?$/.test(value) && !value.includes("..");
}

export interface ResourceFrameMessage {
	channel: typeof RESOURCE_FRAME_CHANNEL;
	token?: string;
	type: "ready" | "answer" | "cancel" | "resize" | "focus" | "invoke" | "host" | "busy";
	id?: string;
	name?: string;
	args?: JsonValue;
	value?: JsonValue;
	height?: number;
}

export function resourceFrameMessage(raw: unknown, token: string, minHeight = 80): ResourceFrameMessage | undefined {
	try {
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(raw).length > 128 * 1024) return undefined;
		const value = raw as ResourceFrameMessage;
		if (value.channel !== RESOURCE_FRAME_CHANNEL) return undefined;
		if (value.type === "ready") return { channel: RESOURCE_FRAME_CHANNEL, type: "ready" };
		if (value.token !== token) return undefined;
		if (value.type === "resize" && Number.isFinite(value.height)) return { channel: RESOURCE_FRAME_CHANNEL, type: "resize", height: Math.min(1000, Math.max(minHeight === 0 ? 0 : 80, Math.round(value.height!))) };
		if (value.type === "busy" && typeof value.value === "boolean") return value;
		if (value.type === "cancel" || value.type === "answer") return value;
		if (value.type === "focus" && typeof value.id === "string" && /^[\w-]{1,80}$/.test(value.id)) return { channel: RESOURCE_FRAME_CHANNEL, token, type: "focus", id: value.id };
		if ((value.type === "invoke" || value.type === "host") && typeof value.id === "string" && /^[\w-]{1,80}$/.test(value.id) && typeof value.name === "string" && /^[\w.-]{1,100}$/.test(value.name)
			&& (value.type !== "host" || RESOURCE_BROWSER_CAPABILITIES.includes(value.name as never))) return value;
	} catch { /* Not valid JSON or beyond the frame's budget. */ }
	return undefined;
}
