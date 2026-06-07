/**
 * Catalog of editable "media slots" — the static decorative image positions on a
 * storefront that a tenant can replace with their own photo. The map is generic
 * (`settings.media[key] = { url }`); this catalog is the *contract* describing
 * which keys exist for a given site theme, their human label, aspect ratio and
 * grouping. The admin panel renders its editor from this catalog, so a new
 * storefront site becomes editable by adding a catalog entry here + dropping the
 * `MediaSlot` wrapper into that site — no admin code change required.
 */
export interface MediaSlotDef {
  /** Stable slot id, e.g. "home.hero". Used as the storefront lookup key and the
   *  R2 sub-path. Shared spots (rendered on >1 page) use a `site.*` prefix. */
  key: string;
  /** Bulgarian label shown in the admin editor. */
  label: string;
  /** Aspect ratio for the admin preview thumbnail, e.g. "16/10". */
  ratio: string;
  /** Group heading in the admin editor (the storefront page it appears on). */
  page: string;
  /** Optional admin hint, e.g. "shown on another page too". */
  note?: string;
  /** Preview uses rounded corners to mirror the storefront `.ph--rounded` look. */
  rounded?: boolean;
}

/** Pages in display order for the editor. */
export const MEDIA_SLOT_PAGES = ['Начало', 'Поръчки', 'За нас'] as const;

/** Theme "pazar" (Фермерски пазар Чайка / ferma). */
const PAZAR_SLOTS: MediaSlotDef[] = [
  { key: 'home.hero', label: 'Главна снимка (hero)', ratio: '4/5', page: 'Начало', rounded: true },
  {
    key: 'site.pillar_market',
    label: '„Пазар на място“ · щандове',
    ratio: '16/10',
    page: 'Начало',
    note: 'Показва се и на страница „Поръчки“',
  },
  {
    key: 'site.pillar_delivery',
    label: '„Доставка до дома“ · кашон',
    ratio: '16/10',
    page: 'Начало',
    note: 'Показва се и на страница „Поръчки“',
  },
  { key: 'orders.box', label: 'Кашон с поръчка', ratio: '4/3', page: 'Поръчки', rounded: true },
  { key: 'about.portrait', label: 'Пазарът на Чайка (портрет)', ratio: '4/5', page: 'За нас', rounded: true },
  { key: 'about.gallery_stalls', label: 'Галерия · Щандовете на пазара', ratio: '2/1', page: 'За нас' },
  { key: 'about.gallery_basket', label: 'Галерия · Кошница с плодове', ratio: '1/1', page: 'За нас' },
  { key: 'about.gallery_honey', label: 'Галерия · Буркани с мед', ratio: '1/2', page: 'За нас' },
  { key: 'about.gallery_dairy', label: 'Галерия · Сирене и мляко', ratio: '1/1', page: 'За нас' },
  { key: 'about.gallery_farmer', label: 'Галерия · Фермер на щанда', ratio: '1/1', page: 'За нас' },
  { key: 'about.gallery_sweets', label: 'Галерия · Домашни сладка', ratio: '1/1', page: 'За нас' },
  { key: 'about.gallery_customers', label: 'Галерия · Клиенти на пазара', ratio: '1/1', page: 'За нас' },
];

const CATALOGS: Record<string, MediaSlotDef[]> = {
  pazar: PAZAR_SLOTS,
};

export const DEFAULT_SITE_THEME = 'pazar';

/** Resolve a tenant's slot catalog by its `settings.siteTheme` (default "pazar").
 *  Unknown themes fall back to the default so the editor is never empty. */
export function getMediaCatalog(theme?: string | null): MediaSlotDef[] {
  return CATALOGS[theme ?? DEFAULT_SITE_THEME] ?? CATALOGS[DEFAULT_SITE_THEME];
}

/** True if `slotKey` is a valid editable slot for the given theme. */
export function isValidSlot(theme: string | null | undefined, slotKey: string): boolean {
  return getMediaCatalog(theme).some((s) => s.key === slotKey);
}
