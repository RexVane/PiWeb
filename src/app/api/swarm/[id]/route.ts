import { NextResponse } from "next/server";
import { BoundaryError } from "@/lib/path-security";
import { acceptSwarmTask, cancelSwarm, getSwarm } from "@/lib/swarm-service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json({ success: true, data: await getSwarm((await params).id) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String((error as Error).message ?? error) }, { status: error instanceof BoundaryError ? 400 : 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await req.json();
    const id = (await params).id;
    const data = body?.action === "cancel"
      ? await cancelSwarm(id, body?.cwd)
      : body?.action === "accept"
        ? await acceptSwarmTask(id, body?.index, body?.cwd)
        : (() => { throw new BoundaryError("invalid swarm action"); })();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String((error as Error).message ?? error) }, { status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500 });
  }
}
