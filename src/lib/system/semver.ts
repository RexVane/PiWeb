/**
 * 版本号比较（设置页「检查更新」用）：主.次.修 按数字比，预发布段按 semver 规则比。
 * 正式版高于同号预发布（0.4.0 > 0.4.0-beta.1）；预发布标识符数字按数值、字母按字典序、数字低于字母。
 */
export interface ParsedVersion {
	nums: [number, number, number];
	pre: string[];
}

export function parseVersion(value: string): ParsedVersion | null {
	const m = value.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
	if (!m) return null;
	return { nums: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: m[4] ? m[4].split(".") : [] };
}

/** a 比 b 新才返回 true；任一方解析失败按「不比它新」处理 */
export function isNewer(a: string, b: string): boolean {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return false;
	for (let i = 0; i < 3; i += 1) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
	if (!pa.pre.length || !pb.pre.length) return pa.pre.length === 0 && pb.pre.length > 0;
	const n = Math.max(pa.pre.length, pb.pre.length);
	for (let i = 0; i < n; i += 1) {
		const x = pa.pre[i];
		const y = pb.pre[i];
		if (x === undefined) return false;
		if (y === undefined) return true;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			if (Number(x) !== Number(y)) return Number(x) > Number(y);
			continue;
		}
		if (nx !== ny) return ny;
		if (x !== y) return x > y;
	}
	return false;
}
