import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const assetId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const utf8Env = {
	...process.env,
	PIWEB_DEV_ASSET_ID: assetId,
	PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
	PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
};
const child = spawn(
	process.execPath,
	[nextCli, "dev", "--webpack", "-H", "127.0.0.1", "-p", "30141"],
	{
		stdio: "inherit",
		env: utf8Env,
	},
);

child.once("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
child.once("exit", (code) => {
	process.exitCode = code ?? 1;
});
