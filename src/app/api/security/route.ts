import { NextResponse } from "next/server";
import type { ProjectTrust } from "@/lib/security-service";
import { getSecurity, setProjectTrust } from "@/lib/security-service";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return NextResponse.json({ success: true, data: await getSecurity() });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}

export async function PUT(req: Request) {
	try {
		const body = (await req.json()) as { defaultProjectTrust?: ProjectTrust };
		const v = body.defaultProjectTrust;
		if (v !== "ask" && v !== "always" && v !== "never")
			return NextResponse.json({ success: false, error: "bad value" }, { status: 400 });
		await setProjectTrust(v);
		return NextResponse.json({ success: true });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}
