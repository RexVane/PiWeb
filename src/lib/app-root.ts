import path from "node:path";

/** The launchers set this explicitly; direct `next` invocations still use their working directory. */
export const APP_ROOT = path.resolve(process.env.PI_WEB_ROOT ?? process.cwd());
