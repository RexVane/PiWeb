import { describe, expect, it } from "vitest";
import { workspaceTabPath } from "../src/lib/workspace-tab-path";

describe("workspaceTabPath (browser-side tab normalization, not an access grant)", () => {
	it("keeps relative paths and resolves safe dot segments", () => {
		expect(workspaceTabPath("src/file.ts", "C:/project")).toBe("src/file.ts");
		expect(workspaceTabPath("./src/../README.md", "/project")).toBe("README.md");
		expect(workspaceTabPath(".", "/project")).toBe(".");
		expect(workspaceTabPath("../outside.txt", "/project")).toBeNull();
	});

	it("keeps in-workspace absolute paths instead of dropping valid tabs", () => {
		expect(workspaceTabPath("c:\\PROJECT\\src\\file.ts", "C:/project")).toBe("src/file.ts");
		expect(workspaceTabPath("/c/project/src/file.ts", "C:/project")).toBe("src/file.ts");
		expect(workspaceTabPath("/project/src/file.ts", "/project")).toBe("src/file.ts");
		expect(workspaceTabPath("/project", "/project")).toBe(".");
		expect(workspaceTabPath("/etc/file.txt", "/")).toBe("etc/file.txt");
	});

	it("rejects sibling prefixes, parent escapes and ambiguous drive-relative paths", () => {
		for (const value of ["C:/project-other/file.ts", "C:/project/../outside.txt", "D:/project/file.ts", "C:file.ts", "/src/file.ts"]) {
			expect(workspaceTabPath(value, "C:/project")).toBeNull();
		}
		expect(workspaceTabPath("/Project/file.ts", "/project")).toBeNull();
		expect(workspaceTabPath("/project-other/file.ts", "/project")).toBeNull();
	});

	it("handles UNC shares and does not guess the cwd for absolute paths", () => {
		expect(workspaceTabPath("\\\\SERVER\\share\\repo\\doc.md", "//server/share/repo")).toBe("doc.md");
		expect(workspaceTabPath("//server/other/repo/doc.md", "//server/share/repo")).toBeNull();
		expect(workspaceTabPath("C:/project/file.ts")).toBeNull();
		expect(workspaceTabPath("\u0000bad")).toBeNull();
	});
});
