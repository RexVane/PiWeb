import { NextResponse, type NextRequest } from "next/server";
import { isSafeOrigin, validBasicAuthorization } from "@/lib/auth";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function proxy(request: NextRequest) {
	if (!READ_METHODS.has(request.method) && !isSafeOrigin(request)) {
		return NextResponse.json({ success: false, error: "cross-origin request rejected" }, { status: 403 });
	}

	const password = process.env.PI_WEB_PASSWORD;
	if (!password || validBasicAuthorization(request.headers.get("authorization"), password)) {
		return NextResponse.next();
	}

	return new NextResponse("Authentication required", {
		status: 401,
		headers: {
			"WWW-Authenticate": 'Basic realm="PiWeb", charset="UTF-8"',
			"Cache-Control": "no-store",
		},
	});
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|icon\\.svg|favicon\\.ico).*)"],
};
