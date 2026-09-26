import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [cwd, selected, reportFile] = process.argv.slice(2);
let runner;
try {
  if (!cwd || !selected || !reportFile) throw new Error("expected workspace, test file and report path");
  const api = await import(pathToFileURL(path.join(cwd, "node_modules/vitest/dist/node.js")).href);
  const options = { root: cwd, run: true, watch: false, reporters: ["json"], outputFile: reportFile };
  runner = Number(api.version.split(".")[0]) >= 5
    ? await api.createVitest(options)
    : await api.createVitest("test", options);
  if (typeof runner.globTestSpecifications !== "function" || typeof runner.runTestSpecifications !== "function") {
    throw new Error("this Vitest version does not support exact test specifications");
  }
  const canonical = (file) => process.platform === "win32" ? file.toLowerCase() : file;
  const target = canonical(await fs.realpath(selected));
  const specs = await runner.globTestSpecifications();
  const exact = [];
  for (const spec of specs) {
    if (canonical(await fs.realpath(spec.moduleId)) === target) exact.push(spec);
  }
  if (!exact.length) throw new Error("selected file is excluded by the workspace Vitest configuration");
  // Discovery is read-only; only exact specifications are handed to the executor.
  if (typeof runner.standalone === "function") await runner.standalone();
  else await runner.init();
  await runner.runTestSpecifications(exact);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await runner?.close();
}
