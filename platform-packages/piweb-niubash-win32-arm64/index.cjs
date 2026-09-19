"use strict";

const path = require("node:path");

module.exports = Object.freeze({
	schema: 1,
	packageName: "@rexvane/piweb-niubash-win32-arm64",
	distributionVersion: "1.1.4-piweb.0",
	niubashVersion: "1.1.4",
	platform: "win32",
	arch: "arm64",
	runtimeDir: path.join(__dirname, "runtime"),
	shellPath: path.join(__dirname, "runtime", "niu.exe"),
	manifestPath: path.join(__dirname, "runtime-manifest.json"),
});
