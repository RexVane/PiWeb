import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { measureGitObjectBytes } from "../src/lib/git-object-size";
import { recycleFixture } from "./lib/sandbox/fixtures";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await recycleFixture(directory); });

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-object-stream-")); directories.push(directory);
	const script = path.join(directory, "git-fixture.mjs");
	await fs.writeFile(script, `
import { once } from 'node:events';
if (process.argv.includes('rev-list')) {
  if (process.env.STREAM_FAIL === '1') { process.stderr.write('fixture failure'); process.exitCode = 2; }
  else { for (let i=0;i<220;i++) { if (!process.stdout.write(('a'.repeat(40)+'\\n').repeat(1000))) await once(process.stdout,'drain'); } }
} else {
  let count=0; for await(const chunk of process.stdin) for(const byte of chunk) if(byte===10) count++;
  for(let i=0;i<count;i+=1000) if(!process.stdout.write('1\\n'.repeat(Math.min(1000,count-i)))) await once(process.stdout,'drain');
}
`);
	return { directory, script };
}

it("measures more than 8MiB of object IDs with bounded streaming and reports capacity failures", async () => {
	const { directory, script } = await fixture();
	const options = { cwd: directory, env: { ...process.env }, limit: 1_000_000 };
	expect(await measureGitObjectBytes(process.execPath, [script], [], options)).toBe(220_000);
	await expect(measureGitObjectBytes(process.execPath, [script], [], { ...options, limit: 100 })).rejects.toMatchObject({ code: "too-large" });
});

it("does not treat an object-enumeration failure as an empty valid history", async () => {
	const { directory, script } = await fixture();
	await expect(measureGitObjectBytes(process.execPath, [script], [], { cwd: directory, env: { ...process.env, STREAM_FAIL: "1" }, limit: 1_000_000 })).rejects.toThrow("fixture failure");
});
