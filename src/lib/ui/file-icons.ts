/**
 * 文件 / 文件夹图标：按扩展名、完整文件名、文件夹名查 material-icon-theme 的精简映射，
 * 返回 public/file-icons 下的 SVG 路径。映射表由 scripts/sync-file-icons.mjs 生成。
 */
import icons from "./file-icons.json";

interface IconMap {
	defaults: { file: string; folder: string; folderOpen: string };
	ext: Record<string, string>;
	name: Record<string, string>;
	folder: Record<string, string>;
}

const map = icons as IconMap;

function src(id: string): string {
	return `/file-icons/${id}.svg`;
}

/** 文件图标：先按完整文件名，再按最长匹配的多段扩展名（d.ts > ts） */
export function fileIconSrc(fileName: string): string {
	const lower = fileName.toLowerCase();
	const byName = map.name[lower];
	if (byName) return src(byName);
	const parts = lower.split(".");
	for (let i = 1; i < parts.length; i += 1) {
		const ext = parts.slice(i).join(".");
		const id = map.ext[ext];
		if (id) return src(id);
	}
	return src(map.defaults.file);
}

/** 文件夹图标：按文件夹名，展开态用 -open 变体 */
export function folderIconSrc(dirName: string, open: boolean): string {
	const id = map.folder[dirName.toLowerCase()];
	if (id) return src(open ? `${id}-open` : id);
	return src(open ? map.defaults.folderOpen : map.defaults.folder);
}
