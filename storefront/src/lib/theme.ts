/** The three storefront brand themes, applied via `<html data-theme>`. */
export const THEMES = [
  { id: 'priroda', label: 'Природа', color: '#2C5530' },
  { id: 'svezho', label: 'Свежо', color: '#E63950' },
  { id: 'klasik', label: 'Класик', color: '#C8826A' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'priroda';
export const THEME_STORAGE_KEY = 'ff_theme';

/**
 * Inline, render-blocking script injected in <head> so `data-theme` is set from
 * localStorage before first paint — no theme flash. Mirrors the template's
 * `<script>try{…}catch(e){}</script>`.
 */
export const NO_FLASH_THEME_SCRIPT = `try{document.documentElement.setAttribute('data-theme',localStorage.getItem('${THEME_STORAGE_KEY}')||'${DEFAULT_THEME}')}catch(e){}`;
