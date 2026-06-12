import type { SiteContactDto } from './dto/site-contact.dto';

/** One public social link. `network` is a known key ('fb'/'ig'/'yt'/'tt'/
 *  'viber'/'telegram'/'whatsapp'/'x'/'other') that drives the storefront icon;
 *  '' on older rows → the storefront guesses the icon from the url. */
export interface PublicSocialLink {
  network: string;
  label: string;
  url: string;
}

/** One arbitrary labeled contact row the farm added ("каквото иска клиента").
 *  e.g. { label: 'WhatsApp', value: '+359…' } or { label: '', value: 'free text' }. */
export interface PublicCustomField {
  label: string;
  value: string;
}

/** Public contact block surfaced on the storefront profile. */
export interface PublicContact {
  address: string | null;
  hours: string | null;
  tagline: string | null;
  phone: string | null;
  email: string | null;
  social: PublicSocialLink[];
  custom: PublicCustomField[];
  mapLat: string | null;
  mapLng: string | null;
}

/** Project a raw settings.contact blob to its public shape (trim, drop empty
 *  social rows, cap at 8). Garbage-in → safe nulls / []. */
export function buildPublicContact(raw: unknown): PublicContact {
  const c =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null;
  const social: PublicSocialLink[] = [];
  if (Array.isArray(c.social)) {
    for (const row of c.social.slice(0, 8)) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        const r = row as Record<string, unknown>;
        if (typeof r.url === 'string' && r.url.trim()) {
          social.push({
            network: typeof r.network === 'string' ? r.network : '',
            label: typeof r.label === 'string' ? r.label : '',
            url: r.url,
          });
        }
      }
    }
  }
  const custom: PublicCustomField[] = [];
  if (Array.isArray(c.custom)) {
    for (const row of c.custom.slice(0, 12)) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        const r = row as Record<string, unknown>;
        if (typeof r.value === 'string' && r.value.trim()) {
          custom.push({
            label: typeof r.label === 'string' ? r.label : '',
            value: r.value,
          });
        }
      }
    }
  }
  return {
    address: str(c.address),
    hours: str(c.hours),
    tagline: str(c.tagline),
    phone: str(c.phone),
    email: str(c.email),
    social,
    custom,
    mapLat: str(c.mapLat),
    mapLng: str(c.mapLng),
  };
}

/** Normalize an incoming SiteContactDto into the stored contact object + the
 *  theme color (undefined = field absent, leave brand.themeColor untouched). */
export function normalizeSiteContact(dto: SiteContactDto): {
  contact: Record<string, unknown>;
  themeColor: string | null | undefined;
} {
  const trim = (v?: string): string => (typeof v === 'string' ? v.trim() : '');
  const social = (dto.social ?? [])
    .map((s) => ({ network: trim(s.network), label: trim(s.label), url: trim(s.url) }))
    .filter((s) => s.url)
    .slice(0, 8);
  const custom = (dto.custom ?? [])
    .map((c) => ({ label: trim(c.label), value: trim(c.value) }))
    .filter((c) => c.value)
    .slice(0, 12);
  const contact = {
    address: trim(dto.address),
    hours: trim(dto.hours),
    tagline: trim(dto.tagline),
    phone: trim(dto.phone),
    email: trim(dto.email),
    social,
    custom,
    mapLat: trim(dto.mapLat),
    mapLng: trim(dto.mapLng),
  };
  const themeColor =
    dto.themeColor === undefined ? undefined : trim(dto.themeColor) || null;
  return { contact, themeColor };
}
