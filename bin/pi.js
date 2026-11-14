#!/usr/bin/env node
/**
 * Pi CLI Entrypoint:
 * - `pi web [options]`: 启动 Pi Web 界面（支持任意大小写：pi web / PI WEB / Pi Web）
 * - `pi [args...]`: 转发给 pi-coding-agent 命令行交互智能体
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateProcessTree } from "../scripts/process-runner.mjs";
import { isMainModule } from "../scripts/entrypoint.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const utf8Env = {
	...process.env,
	PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
	PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
};

const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0]?.trim().toLowerCase();
export function supervise(child) {
	const stop = () => { void terminateProcessTree(child).catch((error) => { console.error(`[piweb] 停止失败：${error.message}`); process.exitCode = 1; }); };
	const interrupt = () => stop("SIGINT");
	const terminate = () => stop("SIGTERM");
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	child.once("error", (error) => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); console.error(`[piweb] 启动失败：${error.message}`); process.exitCode = 1; });
	child.once("exit", (code) => {
		process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
		process.exitCode = code ?? 1;
	});
}

if (isMainModule(import.meta.url)) {
if (firstArg === "web") {
	// 启动 Web 界面
	const subArgs = rawArgs.slice(1);
	const script = path.join(__dirname, "piweb.js");
	const child = spawn(process.execPath, [script, ...subArgs], {
		cwd: root,
		stdio: "inherit",
		detached: process.platform !== "win32",
		env: utf8Env,
	});
	supervise(child);
} else {
	// 转发给 pi-coding-agent
	const piAgentCli = path.join(
		root,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"bundle",
		"cli.js",
	);

	const child = spawn(process.execPath, [piAgentCli, ...rawArgs], {
		cwd: process.cwd(),
		stdio: "inherit",
		detached: process.platform !== "win32",
		env: utf8Env,
	});
	supervise(child);
}
}
