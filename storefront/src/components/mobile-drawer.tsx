'use client';

/**
 * Mobile nav drawer — React port of `buildDrawer`/`openDrawer`/`closeDrawer`.
 * Controlled by `<SiteHeader>`. Backdrop + slide-in panel; closes on backdrop
 * click, the X, or Escape.
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { Berry, Cart, Close } from './icons';
import { mainNav, SITE, telHref, isActiveHref } from '@/lib/site';

export function MobileDrawer({
  open,
  onClose,
  pathname,
  hasFarmers = false,
  articlesEnabled = true,
  reviewsEnabled = true,
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
  hasFarmers?: boolean;
  articlesEnabled?: boolean;
  reviewsEnabled?: boolean;
}) {
  const nav = mainNav(hasFarmers, { articlesEnabled, reviewsEnabled });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`drawer-backdrop${open ? ' open' : ''}`}
        id="drawerBackdrop"
        onClick={onClose}
      />
      <aside
        className={`drawer${open ? ' open' : ''}`}
        id="drawer"
        aria-hidden={!open}
      >
        <div className="drawer__head">
          <span className="brand">
            <span className="brand__mark">
              <Berry />
            </span>
            <span className="brand__name">{SITE.name}</span>
          </span>
          <button
            className="icon-btn"
            type="button"
            onClick={onClose}
            aria-label="Затвори"
          >
            <Close />
          </button>
        </div>
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={isActiveHref(pathname, item.href) ? 'active' : ''}
            onClick={onClose}
          >
            {item.label}
          </Link>
        ))}
        <Link
          href="/cart"
          onClick={onClose}
          style={{ display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <Cart /> Количка
        </Link>
        <div
          style={{
            marginTop: 'auto',
            paddingTop: 18,
            color: 'var(--muted)',
            fontSize: 14,
          }}
        >
          <a href={telHref(SITE.phone)}>{SITE.phone}</a>
        </div>
      </aside>
    </>
  );
}
