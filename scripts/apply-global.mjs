/**
 * 把本仓的 src/ 同步进全局安装的 @rexvane/piweb,并就地重建成品构建。
 *
 * 为什么不是直接把仓库里的 .next 拷过去:Next 的 webpack/swc 规则会排除一切
 * node_modules 下的路径,而安装目录本身就在 node_modules 里,直接在原地构建
 * 会以「@/i18n 解析不到 / TS 文件的 import 被当语法错误」失败。仓库里本来就有
 * 官方解法 —— scripts/install-build.mjs 的 ensureInstallBuild:在一个不经过任何
 * node_modules 的暂存目录里构建,再把成品 .next 拷回来。这里复用它。
 *
 * 只动 src/ 与 .next/src/assets、pi 的依赖、用户数据一律不碰。
 * 用法:node scripts/apply-global.mjs [--out <全局安装根>] [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { ensureInstallBuild } from "./install-build.mjs";
import { selectProductionBuild } from "./build-output.mjs";
import { isMainModule } from "./entrypoint.mjs";

const DEFAULT_OUT = "D:\\NodeJs\\node_modules\\@rexvane\\piweb";
const SKIP_DIRS = new Set(["assets"]); // 发布包自带的图片资源,源码仓里是同一份,不必覆盖

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const same = (a, b) => {
	const fa = fs.readFileSync(a), fb = fs.readFileSync(b);
	return fa.length === fb.length && fa.equals(fb);
};

/** Prepare the candidate from a staging source tree before changing installed sources. */
export function applyGlobalSources({ source = process.cwd(), out = DEFAULT_OUT, dry = false, build = ensureInstallBuild, log = console.log } = {}) {
const SRC = path.resolve(source), OUT = path.resolve(out), DRY = dry;
// 1) 版本必须一致:src 是某个版本的源码,装到别的版本上会静默错配
const localPkg = read(path.join(SRC, "package.json"));
const outPkg = read(path.join(OUT, "package.json"));
if (localPkg.version !== outPkg.version) {
	throw new Error(`版本不一致:源码 ${localPkg.version},目标 ${outPkg.version}。先 npm install -g @rexvane/piweb@${localPkg.version} 对齐。`);
}

// 2) 同步 src/。目标里多出来的文件不动,只覆盖与新增
const changes = [];
const walk = (rel) => {
	for (const entry of fs.readdirSync(path.join(SRC, "src", rel), { withFileTypes: true })) {
		const child = path.join(rel, entry.name);
		if (entry.isDirectory()) {
			if (rel === "" && SKIP_DIRS.has(entry.name)) continue;
			walk(child);
			continue;
		}
		const from = path.join(SRC, "src", child);
		const to = path.join(OUT, "src", child);
		if (fs.existsSync(to) && same(from, to)) continue;
		changes.push({ from, to });
	}
};
walk("");
log(`src 同步:${changes.length} 个文件${DRY ? "(dry-run,未写入)" : "待验证构建"}(src/assets 不覆盖)`);
if (DRY) return "skipped";

// 3) Build a fresh immutable release. Old directories remain available to live
// processes and failure leaves the last complete active build selected.
const status = build(OUT, { force: true, sourceRoot: SRC });
if (status !== "built") {
	throw new Error("重建失败，原有源码与完整构建已保留。");
}
for (const { from, to } of changes) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
log(`构建完成:${selectProductionBuild(OUT).buildDir}；空闲时手动重启后生效。`);
return "built";
}
if (isMainModule(import.meta.url)) {
	const args = process.argv.slice(2), outIndex = args.indexOf("--out");
	try {
		if (outIndex >= 0 && !args[outIndex + 1]) throw new Error("--out 需要安装目录");
		applyGlobalSources({ out: outIndex >= 0 ? args[outIndex + 1] : DEFAULT_OUT, dry: args.includes("--dry") });
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
