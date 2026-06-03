/**
 * Static site/farm details for the chrome. The template hardcoded FARM/PHONE/
 * EMAIL in app.js; here they're env-overridable with the template defaults.
 *
 * FLAG (S9): a public `GET /public/:slug` profile endpoint would let the header/
 * footer pull the real farm name/phone/email/socials and drop these constants.
 */
export const SITE = {
  name: process.env.NEXT_PUBLIC_STOREFRONT_NAME ?? 'Горска Градина',
  tagline: 'био плодове · Варна',
  phone: process.env.NEXT_PUBLIC_STOREFRONT_PHONE ?? '+359 88 123 4567',
  email: process.env.NEXT_PUBLIC_STOREFRONT_EMAIL ?? 'zdravei@example.bg',
  city: 'гр. Варна, България',
  hours: 'Пон–Съб · 9:00–18:00',
  blurb:
    'Малко семейно стопанство. Берем сутрин, доставяме до вечерта — свежи био плодове от Варна и региона.',
  socials: {
    facebook: '#',
    instagram: '#',
    tiktok: '#',
  },
} as const;

/** Telephone href with whitespace stripped (matches the template). */
export const telHref = (phone: string) => `tel:${phone.replace(/\s/g, '')}`;

export interface NavItem {
  label: string;
  href: string;
}

/** Primary nav — template labels, mapped from `*.html` to Next routes. */
export const NAV: ReadonlyArray<NavItem> = [
  { label: 'Начало', href: '/' },
  { label: 'Продукти', href: '/products' },
  { label: 'За нас', href: '/about' },
  { label: 'Сезонни пакети', href: '/bundles' },
  { label: 'Влог', href: '/blog' },
  { label: 'Отзиви', href: '/reviews' },
  { label: 'Контакти', href: '/contact' },
  { label: 'ЧЗВ', href: '/faq' },
];

const FARMERS_NAV: NavItem = { label: 'Фермери', href: '/farmers' };

/**
 * Primary nav with the "Фермери" item spliced in after "Продукти" when the farm
 * runs multi-farmer mode (`hasFarmers`). Single-producer farms keep the base nav,
 * so the link never points at an empty page.
 */
export function mainNav(hasFarmers: boolean): ReadonlyArray<NavItem> {
  if (!hasFarmers) return NAV;
  const i = NAV.findIndex((n) => n.href === '/products');
  const out = [...NAV];
  out.splice(i + 1, 0, FARMERS_NAV);
  return out;
}

/** Footer "Магазин" column. */
export const FOOTER_SHOP: ReadonlyArray<NavItem> = [
  { label: 'Продукти', href: '/products' },
  { label: 'Сезонни пакети', href: '/bundles' },
  { label: 'Количка', href: '/cart' },
  { label: 'Отзиви', href: '/reviews' },
];

/** Footer "Магазин" column with "Фермери" added when multi-farmer mode is on. */
export function footerShop(hasFarmers: boolean): ReadonlyArray<NavItem> {
  if (!hasFarmers) return FOOTER_SHOP;
  return [FOOTER_SHOP[0], FARMERS_NAV, ...FOOTER_SHOP.slice(1)];
}

/** Footer "Информация" column. */
export const FOOTER_INFO: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'За нас', href: '/about' },
  { label: 'Влог', href: '/blog' },
  { label: 'ЧЗВ', href: '/faq' },
  { label: 'Контакти', href: '/contact' },
];

/**
 * Is `href` the active route? `/` matches exactly; everything else matches on
 * prefix so nested routes (e.g. /products/[slug]) keep their nav item lit.
 */
export function isActiveHref(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}
