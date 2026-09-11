import { createLocalPowerShellOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const itWindows = process.platform === "win32" ? it : it.skip;

describe("official Pi PowerShell UTF-8 boundary", () => {
	itWindows("decodes multilingual output without replacement characters", async () => {
		const chunks: Buffer[] = [];
		const operations = createLocalPowerShellOperations();
		const result = await operations.exec('Write-Output "中文编码正常 · UTF-8"', process.cwd(), {
			onData: (data) => chunks.push(Buffer.from(data)),
			timeout: 30,
			env: { ...process.env },
		});
		const output = Buffer.concat(chunks).toString("utf8");

		expect(result.exitCode).toBe(0);
		expect(output).toContain("中文编码正常 · UTF-8");
		expect(output).not.toContain("�");
	});
});
