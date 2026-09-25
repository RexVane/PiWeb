/**
 * 外观 = pebrel 配色主题对（https://github.com/Kuddev/pebrel）
 *      + dsh 亮暗模式三选一（light / dark / system，见 dsh ui-theme 的 theme-settings.ts）。
 * 两者独立持久化：配色 piweb.pebrelTheme，亮暗 piweb.theme。
 */

export type PebrelTheme =
	| 'piweb'
	| 'ocean-ink'
	| 'silver-steel'
	| 'limestone-coal'
	| 'linen-moss'
	| 'nord-paper'
	| 'pebrel'
	| 'dsh';

/** dsh 的 THEME_PREFERENCES：浅色/深色/跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeMeta {
	id: PebrelTheme;
	name: string;
	description: string;
	colors: [string, string];
}

export const THEME_CATALOG: ThemeMeta[] = [
	{
		id: 'piweb',
		name: 'PiWeb · 工作台',
		description: '粘土薄荷原装配方',
		colors: ['#34D399', '#A7F3D0'],
	},
	{
		id: 'ocean-ink',
		name: '海与墨',
		description: '湛蓝深邃与清爽青靛',
		colors: ['#38BDF8', '#0284C7'],
	},
	{
		id: 'silver-steel',
		name: '银钢',
		description: '坚实质感与精密中性',
		colors: ['#E2E8F0', '#475569'],
	},
	{
		id: 'limestone-coal',
		name: '石灰与煤炭',
		description: '暖橙炭黑微拟物风格',
		colors: ['#FB923C', '#1E293B'],
	},
	{
		id: 'linen-moss',
		name: '亚麻与苔绿',
		description: '自然植物纤维温润感',
		colors: ['#FFDCC5', '#006C4B'],
	},
	{
		id: 'nord-paper',
		name: '北欧纸墨',
		description: '哑光书纸触觉明度',
		colors: ['#F6FAFE', '#00668A'],
	},
	{
		id: 'pebrel',
		name: 'Pebrel',
		description: '柔和薰衣草紫与鹅卵石质感',
		colors: ['#818CF8', '#EEF2FF'],
	},
];

export const PEBREL_THEME_IDS: PebrelTheme[] = [
	'piweb',
	'ocean-ink',
	'dsh',
	'silver-steel',
	'limestone-coal',
	'linen-moss',
	'nord-paper',
	'pebrel',
];

export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

export const DEFAULT_PEBREL_THEME: PebrelTheme = 'piweb';
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

const THEME_KEY = 'piweb.pebrelTheme';
const MODE_KEY = 'piweb.theme';
const DESIGN_VERSION_KEY = 'piweb.designVersion';

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
		if (saved === 'dsh' && localStorage.getItem(DESIGN_VERSION_KEY) !== '1') {
			localStorage.setItem(THEME_KEY, 'piweb');
			localStorage.setItem(DESIGN_VERSION_KEY, '1');
			return 'piweb';
		}
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
		// 界面字号：驱动 body/导航/标签等（--dsh-content-font-size + delta）
		const fs = localStorage.getItem('piweb.fontSize');
		if (fs) {
			const n = Math.max(12, Math.min(18, parseInt(fs, 10) || 14));
			document.documentElement.style.setProperty('--dsh-content-font-size', `${n}px`);
			document.documentElement.style.setProperty('--dsh-content-font-delta', `${n - 14}px`);
		}
		// 对话字号：只作用于消息正文/用户气泡/输入框（.md 等），缺省回落界面字号
		const chatFs = localStorage.getItem('piweb.chatFontSize');
		if (chatFs) {
			const n = Math.max(12, Math.min(20, parseInt(chatFs, 10) || 14));
			document.documentElement.style.setProperty('--piweb-chat-font-size', `${n}px`);
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
		localStorage.setItem(DESIGN_VERSION_KEY, '1');
	} catch {
		/* ignore */
	}
}

/** 系统亮暗变化 / 跨标签同步时重放当前外观 */
export function syncPebrelTheme(): void {
	applyPebrelTheme(loadPebrelTheme(), loadThemeMode());
}
