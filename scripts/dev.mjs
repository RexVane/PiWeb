import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const assetId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const child = spawn(
	process.execPath,
	[nextCli, "dev", "--webpack", "-H", "127.0.0.1", "-p", "30141"],
	{
		stdio: "inherit",
		env: { ...process.env, PIWEB_DEV_ASSET_ID: assetId },
	},
);

child.once("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
child.once("exit", (code) => {
	process.exitCode = code ?? 1;
});
