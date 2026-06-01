'use client';

/**
 * Global theme switcher bar — React port of `bindThemeSwitcher` from app.js.
 * Sticky at the very top; writes `data-theme` on <html> + persists `ff_theme`,
 * and keeps `--themebar-h` in sync so the sticky header docks right beneath it
 * (the bar wraps on narrow screens).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  THEMES,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  type ThemeId,
} from '@/lib/theme';

export function ThemeBar() {
  const barRef = useRef<HTMLDivElement>(null);
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);

  const syncHeight = useCallback(() => {
    const h = barRef.current?.offsetHeight ?? 0;
    document.documentElement.style.setProperty('--themebar-h', `${h}px`);
  }, []);

  // On mount: adopt the stored theme (the no-flash script already set <html>),
  // and keep --themebar-h in sync. A ResizeObserver on the bar catches every
  // height change — viewport width, wrap point, late font load — so the sticky
  // header always docks flush beneath it.
  useEffect(() => {
    const stored = (localStorage.getItem(THEME_STORAGE_KEY) as ThemeId) || DEFAULT_THEME;
    setThemeState(stored);
    document.documentElement.setAttribute('data-theme', stored);
    syncHeight();
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(syncHeight);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [syncHeight]);

  const setTheme = (id: ThemeId) => {
    document.documentElement.setAttribute('data-theme', id);
    localStorage.setItem(THEME_STORAGE_KEY, id);
    setThemeState(id);
    // height can change when the active label width shifts the wrap point
    requestAnimationFrame(syncHeight);
  };

  return (
    <div className="theme-bar" id="themeBar" ref={barRef}>
      <div className="wrap theme-bar__inner">
        <span className="theme-bar__label">Тема</span>
        <div className="theme-tabs">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-tab${theme === t.id ? ' active' : ''}`}
              data-theme={t.id}
              onClick={() => setTheme(t.id)}
            >
              <span className="dot" style={{ background: t.color }} />
              {t.label}
            </button>
          ))}
        </div>
        <span className="theme-bar__note">
          Демо превключвател — стилът важи за целия сайт →
        </span>
      </div>
    </div>
  );
}
