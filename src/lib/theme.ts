/**
 * 外观 = pebrel 配色主题对（https://github.com/Kuddev/pebrel）
 *      + dsh 亮暗模式三选一（light / dark / system，见 dsh ui-theme 的 theme-settings.ts）。
 * 两者独立持久化：配色 piweb.pebrelTheme，亮暗 piweb.theme。
 */

export type PebrelTheme =
	| 'silver-steel'
	| 'limestone-coal'
	| 'linen-moss'
	| 'nord-paper'
	| 'pebrel'
	| 'dsh';

/** dsh 的 THEME_PREFERENCES：浅色/深色/跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system';

export const PEBREL_THEME_IDS: PebrelTheme[] = [
	'dsh',
	'silver-steel',
	'limestone-coal',
	'linen-moss',
	'nord-paper',
	'pebrel',
];

export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

export const DEFAULT_PEBREL_THEME: PebrelTheme = 'dsh';
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

const THEME_KEY = 'piweb.pebrelTheme';
const MODE_KEY = 'piweb.theme';

export function isPebrelTheme(value: string | null): value is PebrelTheme {
	return !!value && (PEBREL_THEME_IDS as string[]).includes(value);
}

export function isThemeMode(value: string | null): value is ThemeMode {
	return !!value && (THEME_MODES as string[]).includes(value);
}

export function loadPebrelTheme(): PebrelTheme {
	if (typeof window === 'undefined') return DEFAULT_PEBREL_THEME;
	try {
		const saved = localStorage.getItem(THEME_KEY);
		if (isPebrelTheme(saved)) return saved;
	} catch {
		/* ignore */
	}
	return DEFAULT_PEBREL_THEME;
}

export function loadThemeMode(): ThemeMode {
	if (typeof window === 'undefined') return DEFAULT_THEME_MODE;
	try {
		const saved = localStorage.getItem(MODE_KEY);
		if (isThemeMode(saved)) return saved;
	} catch {
		/* ignore */
	}
	return DEFAULT_THEME_MODE;
}

/** 亮暗模式解析为实际值：system 跟随系统媒体查询（dsh getEffectiveTheme 语义） */
export function getEffectiveMode(mode: ThemeMode): 'light' | 'dark' {
	if (mode === 'system') {
		if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}
	return mode;
}

function applyLightDark(mode: ThemeMode): void {
	if (typeof window === 'undefined') return;
	const isDark = getEffectiveMode(mode) === 'dark';
	const root = document.documentElement;
	const body = document.body;
	if (isDark) {
		root.setAttribute('data-ds-dark-theme', '');
		root.removeAttribute('data-ds-light-theme');
		body?.setAttribute('data-ds-dark-theme', '');
		body?.removeAttribute('data-ds-light-theme');
	} else {
		root.removeAttribute('data-ds-dark-theme');
		root.setAttribute('data-ds-light-theme', '');
		body?.removeAttribute('data-ds-dark-theme');
		body?.setAttribute('data-ds-light-theme', '');
	}
	root.style.colorScheme = isDark ? 'dark' : 'light';
}

function applyFontSize(): void {
	try {
		const fs = localStorage.getItem('piweb.fontSize');
		if (fs) {
			const n = Math.max(12, Math.min(17, parseInt(fs, 10) || 14));
			document.documentElement.style.setProperty('--dsh-content-font-size', `${n}px`);
			document.documentElement.style.setProperty('--dsh-content-font-delta', `${n - 14}px`);
		}
	} catch {
		/* ignore */
	}
}

export function applyPebrelTheme(theme: PebrelTheme, mode?: ThemeMode): void {
	if (typeof window === 'undefined') return;
	const effectiveMode = mode ?? loadThemeMode();
	if (theme === 'dsh') {
		// dsh 经典配色 = 项目基础变量，移除 pebrel 覆盖
		document.documentElement.removeAttribute('data-pebrel-theme');
		document.body?.removeAttribute('data-pebrel-theme');
	} else {
		document.documentElement.setAttribute('data-pebrel-theme', theme);
		document.body?.setAttribute('data-pebrel-theme', theme);
	}
	applyLightDark(effectiveMode);
	applyFontSize();
	try {
		localStorage.setItem(THEME_KEY, theme);
		localStorage.setItem(MODE_KEY, effectiveMode);
	} catch {
		/* ignore */
	}
}

/** 初始化：读取存储的配色与亮暗并应用 */
export function initPebrelTheme(): PebrelTheme {
	const theme = loadPebrelTheme();
	applyPebrelTheme(theme, loadThemeMode());
	return theme;
}

/** 系统亮暗变化 / 跨标签同步时重放当前外观 */
export function syncPebrelTheme(): void {
	applyPebrelTheme(loadPebrelTheme(), loadThemeMode());
}
