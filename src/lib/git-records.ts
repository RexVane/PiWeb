import { spawn } from "node:child_process";

/** Read one delimited Git record at a time, including records split across UTF-8 or pipe boundaries. */
export async function* gitRecords(
	bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; command: string },
): AsyncGenerator<string> {
	const { cwd, env, command } = options;
	const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let diagnostic = Buffer.alloc(0);
	child.stderr.on("data", (chunk: Buffer) => {
		if (diagnostic.length < 8192) diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, 8192 - diagnostic.length)]);
	});
	let failure: Error | undefined;
	const completed = new Promise<number | null>((resolve) => {
		child.once("error", (error) => { failure = error; });
		child.once("close", resolve);
	});
	// The timeout measures time waiting on Git, excluding backpressure from the consumer.
	const timeoutMs = 60_000;
	const onTimeout = () => {
		failure = new Error(`git ${command} timed out after ${timeoutMs / 1000}s in ${cwd}`);
		child.kill("SIGKILL");
	};
	let timer = setTimeout(onTimeout, timeoutMs);
	const pieces: Buffer[] = [];
	try {
		for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
			clearTimeout(timer);
			let start = 0;
			for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
				const part = chunk.subarray(start, end);
				if (pieces.length) {
					pieces.push(part);
					const record = Buffer.concat(pieces).toString("utf8");
					pieces.length = 0;
					yield record;
				} else {
					yield part.toString("utf8");
				}
				start = end + 1;
			}
			if (start < chunk.length) pieces.push(chunk.subarray(start));
			timer = setTimeout(onTimeout, timeoutMs);
		}
		const code = await completed;
		if (failure) throw failure;
		if (code !== 0) throw new Error(`git ${command} failed in ${cwd}: ${diagnostic.toString().trim() || `exit ${code}`}`);
		if (pieces.length) yield Buffer.concat(pieces).toString("utf8");
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await completed;
	}
}
