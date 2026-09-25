import { NextResponse } from "next/server";
import { BoundaryError } from "@/lib/path-security";
import { listTestFiles, readTestFile, runTestFile } from "@/lib/test-run-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const cwd = params.get("cwd");
    const file = params.get("file");
    const data = file ? await readTestFile(cwd, file) : { files: await listTestFiles(cwd), runner: "vitest" };
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String((error as Error).message ?? error) }, { status: error instanceof BoundaryError ? 400 : 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json({ success: true, data: await runTestFile(body?.cwd, body?.file) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String((error as Error).message ?? error) }, { status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500 });
  }
}
