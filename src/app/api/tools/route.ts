import { NextResponse } from "next/server";
import { readToolPreference } from "@/lib/tool-preferences";
import { saveGlobalToolPreference } from "@/lib/agent-manager";
import type { ToolPreset } from "@/lib/types";

export const dynamic = "force-dynamic";

const PRESETS = new Set<ToolPreset>(["readonly", "standard", "full"]);

/** 全局工具配置（与 pi 的 defaultTools 同层）：新会话页没有打开会话时也能读写同一份。 */
export async function GET() {
try {
return NextResponse.json({ success: true, data: await readToolPreference() });
} catch (error) {
return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "request failed" }, { status: 500 });
}
}

export async function PUT(req: Request) {
try {
const body = (await req.json()) as { toolPreset?: unknown; names?: unknown };
if (typeof body.toolPreset !== "string" || !PRESETS.has(body.toolPreset as ToolPreset)) {
return NextResponse.json({ success: false, error: "invalid tool preset" }, { status: 400 });
}
const names = body.names === undefined
? undefined
: (Array.isArray(body.names) ? body.names.filter((name): name is string => typeof name === "string" && name.length > 0) : null);
if (names === null || names?.length === 0) {
return NextResponse.json({ success: false, error: "names must be a non-empty array of tool names" }, { status: 400 });
}
await saveGlobalToolPreference({
toolPreset: body.toolPreset as ToolPreset,
...(names ? { customActiveTools: [...new Set(names)] } : {}),
});
return NextResponse.json({ success: true, data: await readToolPreference() });
} catch (error) {
return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "request failed" }, { status: error instanceof SyntaxError ? 400 : 500 });
}
}
