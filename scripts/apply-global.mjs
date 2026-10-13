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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUT = "D:\\NodeJs\\node_modules\\@rexvane\\piweb";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : DEFAULT_OUT;
const DRY = args.includes("--dry");
const SRC = process.cwd();
const SKIP_DIRS = new Set(["assets"]); // 发布包自带的图片资源,源码仓里是同一份,不必覆盖

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const same = (a, b) => {
	const fa = fs.readFileSync(a), fb = fs.readFileSync(b);
	return fa.length === fb.length && fa.equals(fb);
};

// 1) 版本必须一致:src 是某个版本的源码,装到别的版本上会静默错配
const localPkg = read(path.join(SRC, "package.json"));
const outPkg = read(path.join(OUT, "package.json"));
if (localPkg.version !== outPkg.version) {
	console.error(`版本不一致:源码 ${localPkg.version},目标 ${outPkg.version}。先 npm install -g @rexvane/piweb@${localPkg.version} 对齐。`);
	process.exit(1);
}

// 2) 同步 src/。目标里多出来的文件不动,只覆盖与新增
let copied = 0;
const walk = (rel) => {
	for (const entry of fs.readdirSync(path.join(SRC, "src", rel), { withFileTypes: true })) {
		const child = path.join(rel, entry.name);
		if (entry.isDirectory()) {
			if (rel === "" && SKIP_DIRS.has(entry.name)) continue;
			fs.mkdirSync(path.join(OUT, "src", child), { recursive: true });
			walk(child);
			continue;
		}
		const from = path.join(SRC, "src", child);
		const to = path.join(OUT, "src", child);
		if (fs.existsSync(to) && same(from, to)) continue;
		if (!DRY) {
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
		}
		copied += 1;
	}
};
walk("");
console.log(`src 同步:${copied} 个文件${DRY ? "(dry-run,未写入)" : "已写入"}(src/assets 不覆盖)`);
if (DRY) process.exit(0);

// 3) 重建成品构建。ensureInstallBuild 只看「有没有可用构建」,所以先把旧 .next 让开
const build = await import(pathToFileURL(path.join(OUT, "scripts", "install-build.mjs")).href);
const nextBin = build.resolveNextBin(OUT);
if (!nextBin) {
	console.error("安装目录里找不到 Next(依赖被清空过?),无法重建。");
	process.exit(1);
}
const old = path.join(OUT, `.next-old-${Date.now()}`);
const target = path.join(OUT, ".next");
if (fs.existsSync(target)) fs.renameSync(target, old);
const status = spawnSync(process.execPath, ["-e", `
	const { ensureInstallBuild } = await import(${JSON.stringify(pathToFileURL(path.join(OUT, "scripts", "install-build.mjs")).href)});
	const r = ensureInstallBuild(${JSON.stringify(OUT)});
	if (r !== "built") { console.error("ensureInstallBuild ->", r); process.exit(1); }
`], { stdio: "inherit", env: { ...process.env, PIWEB_SKIP_INSTALL_BUILD: "0", PIWEB_BUILD_DIR: ".next" }, cwd: OUT });
if (status.status !== 0 || !fs.existsSync(path.join(target, "BUILD_ID"))) {
	// 失败就把旧构建放回去,别把安装留成不可用的状态
	if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
	if (fs.existsSync(old)) fs.renameSync(old, target);
	console.error("重建失败,已回滚到原构建(全局安装未被破坏)。");
	process.exit(status.status ?? 1);
}
console.log(`构建完成:${target}(旧构建留在 ${path.basename(old)},确认新构建可用后再删)`);