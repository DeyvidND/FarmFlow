'use client';

/**
 * Sticky site header — React port of `buildHeader`. Brand + nav + search/cart/
 * hamburger, with the cart-count badge driven by the cart store. Renders the
 * promo strip above it and owns the mobile drawer's open state.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Berry, Cart, Menu, Search } from './icons';
import { PromoBar } from './promo-bar';
import { MobileDrawer } from './mobile-drawer';
import { NAV, SITE, isActiveHref } from '@/lib/site';
import { useCart, selectCount } from '@/lib/cart';
import { useHasMounted } from '@/lib/use-has-mounted';

export function SiteHeader() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mounted = useHasMounted();
  const count = useCart(selectCount);
  const shownCount = mounted ? count : 0;

  // pulse the badge when the count grows (port of pulseCart)
  const badgeRef = useRef<HTMLSpanElement>(null);
  const prev = useRef(shownCount);
  useEffect(() => {
    if (shownCount > prev.current) {
      badgeRef.current?.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.5)' },
          { transform: 'scale(1)' },
        ],
        { duration: 350 },
      );
    }
    prev.current = shownCount;
  }, [shownCount]);

  // lock body scroll while the drawer is open
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  return (
    <>
      <PromoBar />
      <header className="site-header">
        <div className="wrap">
          <nav className="nav">
            <Link href="/" className="brand">
              <span className="brand__mark">
                <Berry />
              </span>
              <span>
                <span className="brand__name">{SITE.name}</span>
                <span className="brand__tag" style={{ display: 'block' }}>
                  {SITE.tagline}
                </span>
              </span>
            </Link>
            <div className="nav__links">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={isActiveHref(pathname, item.href) ? 'active' : ''}
                >
                  {item.label}
                </Link>
              ))}
            </div>
            <div className="nav__actions">
              <button className="icon-btn" type="button" aria-label="Търсене">
                <Search />
              </button>
              <Link href="/cart" className="icon-btn" aria-label="Количка">
                <Cart />
                <span
                  ref={badgeRef}
                  className={`cart-count${shownCount === 0 ? ' is-zero' : ''}`}
                >
                  {shownCount}
                </span>
              </Link>
              <button
                className="icon-btn hamburger"
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Меню"
              >
                <Menu />
              </button>
            </div>
          </nav>
        </div>
      </header>
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        pathname={pathname}
      />
    </>
  );
}
