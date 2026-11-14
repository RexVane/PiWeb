import { spawn } from "node:child_process";

/** Stream object IDs directly into cat-file; large histories must not fill a JS buffer. */
export function measureGitObjectBytes(binary: string, base: string[], refs: string[], options: {
	cwd: string; env: NodeJS.ProcessEnv; limit: number; timeoutMs?: number;
}): Promise<number> {
	return new Promise((resolve, reject) => {
		const spawnOptions = { cwd: options.cwd, env: options.env, windowsHide: true, stdio: "pipe" as const };
		const objects = spawn(binary, [...base, "rev-list", "--objects", "--no-object-names", ...refs], spawnOptions);
		const sizes = spawn(binary, [...base, "cat-file", "--batch-check=%(objectsize)"], spawnOptions);
		let total = 0, pending = "", closed = 0, finished = false;
		const timer = setTimeout(() => fail(new Error("增长历史大小检查超时，现有历史已保留，请稍后重试或导出后管理历史。")), options.timeoutMs ?? 30_000);
		timer.unref?.();
		const fail = (error: Error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			objects.stdout.unpipe(sizes.stdin);
			objects.kill(); sizes.kill();
			reject(error);
		};
		const consume = (line: string) => {
			if (!line) return;
			const bytes = Number(line);
			if (!/^\d+$/.test(line) || !Number.isSafeInteger(bytes) || bytes < 0) return fail(new Error("无法验证增长历史的存储大小，现有历史已保留"));
			total += bytes;
			if (total > options.limit) fail(Object.assign(new Error("增长历史已达到 1GB 存储上限，现有历史已保留，请关闭记录或导出后管理历史。"), { code: "too-large" }));
		};
		sizes.stdout.on("data", (chunk: Buffer) => {
			if (finished) return;
			const lines = (pending + chunk.toString("ascii")).split("\n");
			pending = lines.pop() ?? "";
			if (pending.length > 64) return fail(new Error("Invalid Git object size output"));
			for (const line of lines) { consume(line.trim()); if (finished) break; }
		});
		for (const [name, child] of [["rev-list", objects], ["cat-file", sizes]] as const) {
			// Drain stderr independently from stdout; retain only a bounded diagnostic.
			let diagnostic = "";
			child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4096); });
			child.on("error", fail);
			child.stdin.on("error", fail);
			child.stdout.on("error", fail);
			child.on("close", (code) => {
				if (finished) return;
				if (code !== 0) return fail(new Error(`git ${name} failed: ${diagnostic.trim().split("\n")[0] || `exit ${code}`}`));
				closed += 1;
				if (closed !== 2) return;
				consume(pending.trim());
				if (finished) return;
				finished = true; clearTimeout(timer); resolve(total);
			});
		}
		objects.stdout.pipe(sizes.stdin);
		objects.stdin.end();
	});
}
