import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("does not retry cancellation, success or arbitrary errors in the actual picker decision code", async () => {
  const script = await fs.readFile("scripts/pick-folder.ps1", "utf8");
  expect(script).not.toMatch(/[^\x00-\x7f]/);
  const source = script.match(/\$src = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  if (!source) throw new Error("picker C# source missing");
  const fixture = `
public class PickerCases {
  public static bool[] Run() {
    var owner = new System.IntPtr(1);
    return new bool[] {
      PiFolderPicker.ShouldRetryWithoutOwner(unchecked((int)0x800704C7), owner),
      PiFolderPicker.ShouldRetryWithoutOwner(0, owner),
      PiFolderPicker.ShouldRetryWithoutOwner(unchecked((int)0x80070005), owner),
      PiFolderPicker.ShouldRetryWithoutOwner(unchecked((int)0x80070578), owner),
      PiFolderPicker.ShouldRetryWithoutOwner(unchecked((int)0x80070578), System.IntPtr.Zero)
    };
  }
}`;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'\nAdd-Type -Language CSharp -TypeDefinition @'\n${source}\n${fixture}\n'@\nConvertTo-Json -Compress -InputObject ([PickerCases]::Run())`,
  ], { windowsHide: true, timeout: 30_000 });
  expect(JSON.parse(stdout.trim())).toEqual([false, false, false, true, false]);
}, 40_000);
