import type { SiteContactDto } from './dto/site-contact.dto';

/** One public social link. */
export interface PublicSocialLink {
  label: string;
  url: string;
}

/** Public contact block surfaced on the storefront profile. */
export interface PublicContact {
  address: string | null;
  hours: string | null;
  tagline: string | null;
  email: string | null;
  social: PublicSocialLink[];
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
        const url = (row as Record<string, unknown>).url;
        const label = (row as Record<string, unknown>).label;
        if (typeof url === 'string' && url.trim()) {
          social.push({ label: typeof label === 'string' ? label : '', url });
        }
      }
    }
  }
  return {
    address: str(c.address),
    hours: str(c.hours),
    tagline: str(c.tagline),
    email: str(c.email),
    social,
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
    .map((s) => ({ label: trim(s.label), url: trim(s.url) }))
    .filter((s) => s.url)
    .slice(0, 8);
  const contact = {
    address: trim(dto.address),
    hours: trim(dto.hours),
    tagline: trim(dto.tagline),
    email: trim(dto.email),
    social,
    mapLat: trim(dto.mapLat),
    mapLng: trim(dto.mapLng),
  };
  const themeColor =
    dto.themeColor === undefined ? undefined : trim(dto.themeColor) || null;
  return { contact, themeColor };
}
