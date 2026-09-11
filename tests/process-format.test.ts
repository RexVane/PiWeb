import { describe, expect, it } from "vitest";
import {
	basename,
	classifyModelError,
	cleanCommand,
	firstSentence,
	langOfPath,
	previewSide,
	relativizeInText,
	relativizePath,
	toolKind,
	trimNoiseTail,
} from "../src/lib/process-format";

describe("toolKind", () => {
	it("maps pi's built-in tools to kinds", () => {
		expect(toolKind("bash")).toBe("cmd");
		expect(toolKind("PowerShell")).toBe("cmd");
		expect(toolKind("read")).toBe("read");
		expect(toolKind("grep")).toBe("search");
		expect(toolKind("glob")).toBe("search");
		expect(toolKind("edit")).toBe("write");
		expect(toolKind("write")).toBe("write");
		expect(toolKind("web_fetch")).toBe("other");
	});
});

describe("relativizePath", () => {
	it("strips the workspace prefix on Windows paths, case-insensitively", () => {
		expect(relativizePath("D:\\AIApp\\PiWeb\\src\\a.ts", "d:/aiapp/piweb")).toBe("src/a.ts");
		expect(relativizePath("D:/AIApp/PiWeb/src/a.ts", "D:\\AIApp\\PiWeb\\")).toBe("src/a.ts");
	});
	it("understands MSYS style /d/... paths", () => {
		expect(relativizePath("/d/AIApp/PiWeb/src/a.ts", "D:/AIApp/PiWeb")).toBe("src/a.ts");
	});
	it("leaves paths outside the workspace alone (slashes normalized)", () => {
		expect(relativizePath("C:\\Windows\\win.ini", "D:/AIApp/PiWeb")).toBe("C:/Windows/win.ini");
		expect(relativizePath("D:/AIApp/PiWebX/a.ts", "D:/AIApp/PiWeb")).toBe("D:/AIApp/PiWebX/a.ts");
	});
	it("returns '.' for the workspace itself and passes through without cwd", () => {
		expect(relativizePath("D:/AIApp/PiWeb", "D:/AIApp/PiWeb")).toBe(".");
		expect(relativizePath("src\\a.ts")).toBe("src/a.ts");
	});
});

describe("cleanCommand", () => {
	it("drops a leading cd into the workspace and collapses whitespace", () => {
		const r = cleanCommand("cd D:/AIApp/PiWeb && npx   tsc --noEmit 2>&1 | head -50", "D:\\AIApp\\PiWeb");
		expect(r).toEqual({ text: "npx tsc --noEmit 2>&1 | head -50", lines: 1 });
	});
	it("handles quoted, /d and MSYS forms, and ';' separators", () => {
		expect(cleanCommand('cd "D:\\AIApp\\PiWeb" && git status', "D:/AIApp/PiWeb").text).toBe("git status");
		expect(cleanCommand("cd /d D:\\AIApp\\PiWeb && dir", "D:/AIApp/PiWeb").text).toBe("dir");
		expect(cleanCommand("cd /d/AIApp/PiWeb; ls", "D:/AIApp/PiWeb").text).toBe("ls");
	});
	it("keeps a cd into some other directory, and keeps everything without cwd", () => {
		expect(cleanCommand("cd D:/other && ls", "D:/AIApp/PiWeb").text).toBe("cd D:/other && ls");
		expect(cleanCommand("cd D:/AIApp/PiWeb && ls").text).toBe("cd D:/AIApp/PiWeb && ls");
	});
	it("reports line counts for multi-line scripts and shows only the first line", () => {
		const r = cleanCommand("python - <<'EOF'\nprint(1)\n\nEOF\n", "D:/x");
		expect(r.text).toBe("python - <<'EOF'");
		expect(r.lines).toBe(3);
	});
});

describe("relativizeInText / cleanCommand paths", () => {
	it("rewrites workspace paths inside a command, in any slash style", () => {
		expect(cleanCommand("ls -la D:/AIApp/PiWeb", "D:/AIApp/PiWeb").text).toBe("ls -la .");
		expect(cleanCommand("cat D:/AIApp/PiWeb/package.json", "D:\\AIApp\\PiWeb").text).toBe("cat package.json");
		expect(cleanCommand('type "D:\\AIApp\\PiWeb\\src\\a.ts"', "D:/AIApp/PiWeb").text).toBe('type "src\\a.ts"');
		expect(cleanCommand("wc -l /d/AIApp/PiWeb/src/lib/*.ts /d/AIApp/PiWeb/bin/pi.js", "D:/AIApp/PiWeb").text).toBe("wc -l src/lib/*.ts bin/pi.js");
	});
	it("does not touch sibling directories that merely share the prefix", () => {
		expect(relativizeInText("ls D:/AIApp/PiWebX D:/AIApp/PiWeb2/a", "D:/AIApp/PiWeb")).toBe("ls D:/AIApp/PiWebX D:/AIApp/PiWeb2/a");
	});
});

describe("previewSide / trimNoiseTail", () => {
	it("looks at the head for listing commands and the tail for build/test commands", () => {
		expect(previewSide("cat package.json")).toBe("head");
		expect(previewSide("ls -la src")).toBe("head");
		expect(previewSide("git status --short")).toBe("head");
		expect(previewSide("git push origin main")).toBe("tail");
		expect(previewSide("FOO=1 npx vitest run 2>&1 | tail -40")).toBe("tail");
		expect(previewSide(`python - <<'EOF'
print(1)
EOF`)).toBe("tail");
		expect(previewSide("C:\\tools\\rg.exe -n foo")).toBe("head");
		expect(previewSide("cd D:/other && cat a.txt")).toBe("head");
		expect(previewSide("wc -l src/*.ts")).toBe("tail");
	});
	it("drops trailing bracket-only lines", () => {
		expect(trimNoiseTail(['"node": ">=22"', "}", "}", "$"])).toEqual(['"node": ">=22"']);
		expect(trimNoiseTail(["ok", "done"])).toEqual(["ok", "done"]);
		expect(trimNoiseTail(["}"])).toEqual([]);
	});
});

describe("firstSentence", () => {
	it("takes the first sentence", () => {
		expect(firstSentence("The components are extensive. I've got a solid sense of the architecture. Let me…")).toBe("The components are extensive.");
	});
	it("does not break on decimals, and handles Chinese punctuation", () => {
		expect(firstSentence("Version 3.5 is installed here. Next step.")).toBe("Version 3.5 is installed here.");
		expect(firstSentence("先看路由。再看组件。")).toBe("先看路由。");
	});
	it("falls back to the whole text when the first sentence is tiny, and truncates with an ellipsis", () => {
		expect(firstSentence("OK. Now the real work begins here", 100)).toBe("OK. Now the real work begins here");
		const long = "a".repeat(200);
		const s = firstSentence(long, 50);
		expect(s.length).toBe(50);
		expect(s.endsWith("…")).toBe(true);
	});
	it("collapses whitespace and returns empty for blank input", () => {
		expect(firstSentence("  \n\t ")).toBe("");
		expect(firstSentence("a  b\n\nc")).toBe("a b c");
	});
});

describe("classifyModelError", () => {
	it("recognizes common provider failures", () => {
		expect(classifyModelError("429 status code (no body)")).toBe("rateLimit");
		expect(classifyModelError("Rate limit reached for gpt-4o")).toBe("rateLimit");
		expect(classifyModelError("401 Unauthorized: invalid api key")).toBe("auth");
		expect(classifyModelError("403 Forbidden")).toBe("auth");
		expect(classifyModelError("402 insufficient balance")).toBe("billing");
		expect(classifyModelError("404 model not found")).toBe("notFound");
		expect(classifyModelError("prompt is too long: 210000 tokens > 200000 maximum")).toBe("context");
		expect(classifyModelError("input length and max_tokens exceed context limit")).toBe("context");
		expect(classifyModelError("504 Gateway Timeout")).toBe("timeout");
		expect(classifyModelError("request timed out after 60s")).toBe("timeout");
		expect(classifyModelError("529 overloaded_error")).toBe("server");
		expect(classifyModelError("500 Internal Server Error")).toBe("server");
		expect(classifyModelError("fetch failed: ECONNRESET")).toBe("network");
	});
	it("returns null for unknown messages", () => {
		expect(classifyModelError("something odd happened")).toBeNull();
	});
});

describe("basename / langOfPath", () => {
	it("extracts file names from either slash style and maps extensions", () => {
		expect(basename("D:\\AIApp\\PiWeb\\src\\ChatWindow.tsx")).toBe("ChatWindow.tsx");
		expect(basename("src/i18n.tsx")).toBe("i18n.tsx");
		expect(langOfPath("src/ChatWindow.tsx")).toBe("TSX");
		expect(langOfPath("Dockerfile")).toBe("Dockerfile");
		expect(langOfPath("weird.unknownext")).toBe("");
	});
});
