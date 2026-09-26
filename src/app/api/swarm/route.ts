import { NextResponse } from "next/server";
import { BoundaryError } from "@/lib/path-security";
import { listSwarms, startSwarm } from "@/lib/swarm-service";
import { RuntimeBusyError } from "@/lib/runtime-activity";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    return NextResponse.json({ success: true, data: await listSwarms(cwd) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String((error as Error).message ?? error) }, { status: error instanceof BoundaryError ? 400 : 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json({ success: true, data: await startSwarm(body?.cwd, body?.tasks) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String((error as Error).message ?? error) }, { status: error instanceof RuntimeBusyError ? 409 : error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500 });
  }
}
