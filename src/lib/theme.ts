export type ThemePref = 'light' | 'dark' | 'system';

export function getSystemTheme(): 'light' | 'dark' {
	if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getEffectiveTheme(pref: ThemePref): 'light' | 'dark' {
	if (pref === 'system') {
		return getSystemTheme();
	}
	return pref;
}

export function applyTheme(pref: ThemePref): 'light' | 'dark' {
	if (typeof window === 'undefined') return 'dark';
	const effective = getEffectiveTheme(pref);
	const isDark = effective === 'dark';

	if (isDark) {
		document.documentElement.setAttribute('data-ds-dark-theme', '');
		document.documentElement.removeAttribute('data-ds-light-theme');
		if (document.body) {
			document.body.setAttribute('data-ds-dark-theme', '');
			document.body.removeAttribute('data-ds-light-theme');
		}
	} else {
		document.documentElement.removeAttribute('data-ds-dark-theme');
		document.documentElement.setAttribute('data-ds-light-theme', '');
		if (document.body) {
			document.body.removeAttribute('data-ds-dark-theme');
			document.body.setAttribute('data-ds-light-theme', '');
		}
	}

	document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
	try {
		localStorage.setItem('piweb.theme', pref);
		const fs = localStorage.getItem('piweb.fontSize');
		if (fs) {
			const n = Math.max(12, Math.min(17, parseInt(fs, 10) || 14));
			document.documentElement.style.setProperty('--dsh-content-font-size', `${n}px`);
			document.documentElement.style.setProperty('--dsh-content-font-delta', `${n - 14}px`);
		}
	} catch {
		/* ignore */
	}
	return effective;
}
