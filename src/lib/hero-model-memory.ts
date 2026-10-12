/**
 * 新会话页记住的模型：按工作区存在这个浏览器的 localStorage 里（key 为 piweb.heroModel.<工作区>）。
 * 只认工作区自己记住的那一条；没有就是没选过，不回落到别的工作区，也不替用户预选。
 */

export interface HeroModelChoice {
	provider: string;
	id: string;
}

const KEY_PREFIX = "piweb.heroModel.";

/** 读某个工作区记住的模型；没有、或内容损坏，都当作没选过 */
export function readRememberedHeroModel(storage: Pick<Storage, "getItem">, cwd: string): HeroModelChoice | null {
	const raw = storage.getItem(`${KEY_PREFIX}${cwd}`);
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<HeroModelChoice> | null;
		return value && typeof value.provider === "string" && typeof value.id === "string" ? { provider: value.provider, id: value.id } : null;
	} catch {
		return null;
	}
}

/** 记住某个工作区选的模型，只写这个工作区名下 */
export function writeRememberedHeroModel(storage: Pick<Storage, "setItem">, cwd: string, choice: HeroModelChoice): void {
	storage.setItem(`${KEY_PREFIX}${cwd}`, JSON.stringify({ provider: choice.provider, id: choice.id }));
}
