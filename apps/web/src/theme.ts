import type { Theme } from '@hive/shared';

const KEY = 'hive-theme';

/** What a person chose. `system` follows the device. */
export type ThemePreference = Theme | 'system';

export function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  return set === 'dark' || set === 'light' ? set : systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: theme still applies for this session */
  }
}

/** Applies a stored preference. `system` clears the override so theme-init.js follows the OS. */
export function applyPreference(pref: ThemePreference): void {
  if (pref !== 'system') return applyTheme(pref);
  document.documentElement.dataset.theme = systemTheme();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export function storedPreference(): ThemePreference {
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'light' || s === 'dark') return s;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

const BAR = { light: '#f4f5f7', dark: '#0e1013' } as const;

/** Colours the browser bar / status bar to match the theme in use, even when it differs from the device's. */
export function syncThemeColor(): void {
  const color = BAR[currentTheme()];
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((m, i) => {
    m.content = color;
    if (i > 0) m.remove();
    else m.removeAttribute('media');
  });
}

export function watchThemeColor(): void {
  syncThemeColor();
  new MutationObserver(syncThemeColor).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}
