import { describe, expect, it } from "vitest";
import {
	basename,
	classifyMessageChars,
	classifyModelError,
	cleanCommand,
	compactDisplayPath,
	deleteTargetOf,
	describeCommandIntent,
	firstSentence,
	dropEchoSeparators,
	displayToolName,
	isDeleteCommand,
	isListCommand,
	langOfPath,
	previewSide,
	relativizeInText,
	relativizePath,
	skillNameFromRead,
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

describe("dropEchoSeparators / displayToolName / isListCommand", () => {
	it("removes heading-style echo segments but keeps real commands and echoed variables", () => {
		expect(dropEchoSeparators('echo "═══ rag/retrieval ═══"; ls app/rag/retrieval; echo "═══ compose ═══"; ls docker')).toBe("ls app/rag/retrieval; ls docker");
		expect(dropEchoSeparators('echo "---"; git remote -v && echo ""; head -5 NOTICE')).toBe("git remote -v; head -5 NOTICE");
		expect(dropEchoSeparators('npx tsc --noEmit; echo "TSC_EXIT=$?"')).toBe('npx tsc --noEmit; echo "TSC_EXIT=$?"');
		expect(dropEchoSeparators('echo "hello world"')).toBe('echo "hello world"');
		expect(dropEchoSeparators('echo "═══ only ═══"')).toBe('echo "═══ only ═══"');
		expect(dropEchoSeparators('grep -n "a; b" file.ts; echo ---')).toBe('grep -n "a; b" file.ts');
	});
	it("is applied by cleanCommand", () => {
		expect(cleanCommand('cd D:/AIApp/PiWeb && echo "=== tsconfig ===" && cat tsconfig.json', "D:/AIApp/PiWeb").text).toBe("cat tsconfig.json");
	});
	it("maps pi tool names to display names", () => {
		expect(displayToolName("bash")).toBe("Bash");
		expect(displayToolName("ls")).toBe("List");
		expect(displayToolName("web_fetch")).toBe("Web_fetch");
	});
	it("recognises directory listings", () => {
		expect(isListCommand("ls -la src")).toBe(true);
		expect(isListCommand("FOO=1 tree -L 2")).toBe(true);
		expect(isListCommand("cat a.txt")).toBe(false);
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
	it("classifies gateway content moderation ahead of the generic 5xx rule", () => {
		// new-api style gateways reject with a misleading 500 plus this payload.
		expect(classifyModelError('500: {"message":"sensitive words detected","code":"sensitive_words_detected"}')).toBe("moderation");
		expect(classifyModelError("Your input was flagged by the content filter")).toBe("moderation");
		expect(classifyModelError("Request blocked by content moderation policy")).toBe("moderation");
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

describe("isDeleteCommand / deleteTargetOf", () => {
	it("recognizes delete commands with a target", () => {
		expect(isDeleteCommand("rm -rf dist")).toBe(true);
		expect(isDeleteCommand("rm 'src/old file.ts'")).toBe(true);
		expect(isDeleteCommand("Remove-Item -Recurse build")).toBe(true);
		expect(isDeleteCommand("del /q tmp.log")).toBe(true);
		expect(isDeleteCommand("/usr/bin/rm notes.txt")).toBe(true);
	});
	it("recognizes deletions inside chained commands (逐段判断，不再只看第一个词)", () => {
		expect(isDeleteCommand("cd src && rm main.py")).toBe(true);
		expect(isDeleteCommand("npm run build; rm -rf dist")).toBe(true);
		expect(isDeleteCommand("git rm old.txt")).toBe(true);
		expect(isDeleteCommand("cd /tmp || Remove-Item cache -Recurse")).toBe(true);
		expect(deleteTargetOf("cd src && rm main.py")).toBe("main.py");
		expect(deleteTargetOf("git rm old.txt")).toBe("old.txt");
	});
	it("does not treat a delete-looking word as a deletion", () => {
		expect(isDeleteCommand("mkdir -p src/app && printf 'x' > src/app/main.py")).toBe(false);
		expect(isDeleteCommand("git stash")).toBe(false);
		expect(isDeleteCommand("npm run rm")).toBe(false);
	});
	it("rejects non-delete commands and bare flags", () => {
		expect(isDeleteCommand("ls -la")).toBe(false);
		expect(isDeleteCommand("grep -r rm .")).toBe(false);
		expect(isDeleteCommand("rm -rf")).toBe(false);
		expect(isDeleteCommand("")).toBe(false);
	});
	it("extracts the first non-flag target with quotes stripped", () => {
		expect(deleteTargetOf("rm -rf dist")).toBe("dist");
		expect(deleteTargetOf("rm \"src/old file.ts\"")).toBe("src/old file.ts");
		expect(deleteTargetOf("Remove-Item -Recurse build")).toBe("build");
	});
});

describe("上下文分项的消息归类", () => {
	it("扩展注入的消息和用户的 ! 命令都算用户内容", () => {
		const chars = classifyMessageChars([
			{ role: "user", content: [{ type: "text", text: "12345" }] },
			// 扩展注入：pi 会把它转成用户消息发给模型
			{ role: "custom", content: [{ type: "text", text: "1234567" }] },
			// `!` 命令：命令与输出都进上下文
			{ role: "bashExecution", content: [], bash: { command: "ls", output: "abc" } },
			// `!!` 命令不进上下文
			{ role: "bashExecution", content: [], bash: { command: "cat .env", output: "secret", excludeFromContext: true } },
			{ role: "assistant", content: [{ type: "text", text: "12" }, { type: "thinking", thinking: "123" }] },
			{ role: "toolResult", content: [{ type: "text", text: "1234" }] },
		]);
		expect(chars).toEqual({ user: 5 + 7 + 5, agentText: 2, agentThinking: 3, agentToolCall: 0, toolOutput: 4 });
	});

	it("没有 bash 字段的历史消息不影响归类", () => {
		expect(classifyMessageChars([{ role: "bashExecution", content: [] }])).toEqual({ user: 0, agentText: 0, agentThinking: 0, agentToolCall: 0, toolOutput: 0 });
	});
});

describe("skillNameFromRead", () => {
	it("extracts skill folder name from read calls targeting exact SKILL.md", () => {
		expect(skillNameFromRead("read", { path: "C:\\Users\\u\\.agents\\skills\\plan-mode\\SKILL.md" })).toBe("plan-mode");
		expect(skillNameFromRead("read", { file_path: "/home/u/.pi/skills/code-review/SKILL.md/" })).toBe("code-review");
		expect(skillNameFromRead("read", { path: ".pi/skills/local-skill/SKILL.md" })).toBe("local-skill");
		expect(skillNameFromRead("read", { path: "./SKILL.md" })).toBe("SKILL.md");
		expect(skillNameFromRead("read", { path: "C:\\SKILL.md" })).toBe("SKILL.md");
		expect(skillNameFromRead("read", { path: "src/skill.md" })).toBeNull();
		expect(skillNameFromRead("read", { path: "docs/README.md" })).toBeNull();
		expect(skillNameFromRead("edit", { path: "/skills/x/SKILL.md" })).toBeNull();
		expect(skillNameFromRead("bash", { command: "cat SKILL.md" })).toBeNull();
	});
});

describe("describeCommandIntent", () => {
	it("extracts port and process intent from PowerShell / ss commands", () => {
		const ps = describeCommandIntent("Get-NetTCPConnection -LocalPort 15721 | Select-Object OwningProcess");
		expect(ps?.category).toBe("port_proc");
		expect(ps?.target).toBe(":15721");

		const proc = describeCommandIntent("Get-Process -Id 4096 | Select-Object Name, Path");
		expect(proc?.category).toBe("port_proc");
		expect(proc?.target).toBe("PID 4096");
	});

	it("translates directory listings while stripping error-action noise", () => {
		const ls = describeCommandIntent("Get-ChildItem \"$env:USERPROFILE\\.cc-switch\" -ErrorAction SilentlyContinue");
		expect(ls?.category).toBe("dir_list");
		expect(ls?.target).toContain("%USERPROFILE%/.cc-switch");
	});

	it("categorizes python scripts, vitest, tsc, git, sqlite, and capture tools", () => {
		const py = describeCommandIntent("cd /repo/tools && python3 inspect_logs.py", "/repo");
		expect(py?.category).toBe("script_py");
		expect(py?.target).toBe("inspect_logs.py");

		const testRun = describeCommandIntent("npx vitest run tests/process-format.test.ts");
		expect(testRun?.category).toBe("test_check");
		expect(testRun?.target).toBe("tests/process-format.test.ts");

		const typeRun = describeCommandIntent("npx tsc --noEmit");
		expect(typeRun?.category).toBe("type_check");

		const gitRead = describeCommandIntent("git status --short");
		expect(gitRead?.category).toBe("git_inspect");

		const gitMutate = describeCommandIntent("git commit -m \"feat: timeline\"");
		expect(gitMutate?.category).toBe("git_write");

		const db = describeCommandIntent("sqlite3 app.db \"SELECT count(*) FROM proxy_request_logs\"");
		expect(db?.category).toBe("sqlite");
		expect(db?.target).toBe("app.db");

		const cap = describeCommandIntent("tshark -i lo0 -f \"tcp port 15721\"");
		expect(cap?.category).toBe("net_capture");
		expect(cap?.target).toContain("tshark");
	});

	it("returns null for unrecognized custom commands so fallback stays untouched", () => {
		expect(describeCommandIntent("my-custom-binary --foo bar")).toBeNull();
		expect(describeCommandIntent("")).toBeNull();
	});

	it("extracts module and inline script hints for python and strips env setup", () => {
		const mod = describeCommandIntent("$env:PYTHONIOENCODING='utf-8'; python -m json.tool");
		expect(mod?.category).toBe("script_py");
		expect(mod?.target).toBe("-m json.tool");

		const inline = describeCommandIntent("python -c \"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:15721').read())\"");
		expect(inline?.category).toBe("script_py");
		expect(inline?.target).toBe(":15721");
	});

	it("skips rg/grep/Get-ChildItem flag values and wildcard/ellipsis noise tokens", () => {
		const ctxSearch = describeCommandIntent("rg -n -C 30 \"activatedOnRegistration\" src/");
		expect(ctxSearch?.category).toBe("code_search");
		expect(ctxSearch?.target).toContain("activatedOnRegistration");
		expect(ctxSearch?.target).not.toContain("30");

		const globSearch = describeCommandIntent("rg -g \"*.ts\" \"disabledPackages\" src/agent");
		expect(globSearch?.category).toBe("code_search");
		expect(globSearch?.target).toContain("disabledPackages");
		expect(globSearch?.target).not.toContain("*.ts");

		const wildDir = describeCommandIntent("Get-ChildItem \"$env:TEMP\" -Filter *.ts");
		expect(wildDir?.category).toBe("dir_list");
		expect(wildDir?.target).not.toContain("*");

		const psRead = describeCommandIntent("Get-Content web-resources.json -TotalCount 60");
		expect(psRead?.category).toBe("file_read");
		expect(psRead?.target).toBe("web-resources.json");

		const wrapped = describeCommandIntent("powershell -NoProfile -Command \"rg -n magpie src/lib\"");
		expect(wrapped?.category).toBe("code_search");
		expect(wrapped?.target).toContain("magpie");
	});
});

describe("compactDisplayPath", () => {
	it("shortens Temp and home directories while preserving workspace relative paths", () => {
		expect(compactDisplayPath("D:/AIApp/PiWeb/src/app/page.tsx", "D:/AIApp/PiWeb")).toBe("src/app/page.tsx");
		expect(compactDisplayPath("C:\\Users\\guica\\AppData\\Local\\Temp\\codex-sniff\\capture.py", "D:/AIApp/PiWeb")).toBe("Temp/codex-sniff/capture.py");
		expect(compactDisplayPath("/tmp/codex-sniff/probe.py", "/repo")).toBe("Temp/codex-sniff/probe.py");
		expect(compactDisplayPath("C:/Users/guica/.cc-switch/config.json", "D:/AIApp/PiWeb")).toBe("~/.cc-switch/config.json");
	});
});
