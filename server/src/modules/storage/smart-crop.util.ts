import sharp from 'sharp';
import * as smartcrop from 'smartcrop-sharp';

/** Focal point + zoom stored in an entity's `cover_crop` jsonb. x/y are the focal
 *  point (0..1); zoom 1 = no zoom. Mirrors the {@link CoverCrop} the storefronts read. */
export interface Focal {
  x: number;
  y: number;
  zoom: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

/**
 * Content-aware focal point for a cover image, so a mixed-orientation photo frames
 * onto its subject in the storefront's fixed-aspect card instead of a blind centre
 * crop. Asks smartcrop for the best 4:3 region — the dominant landscape card shape,
 * which forces vertical localisation (the main pain is tall photos losing their
 * subject) — and returns that region's centre as an aspect-independent focal point.
 * zoom stays 1 (reposition only; never zoom in, which could cut the subject). The
 * farmer can still override it by hand in the cover editor.
 *
 * Best-effort: any failure (non-raster input, decode error, smartcrop throw) returns
 * null so the caller falls back to a centred crop — an upload never fails over framing.
 */
export async function smartFocal(buffer: Buffer): Promise<Focal | null> {
  try {
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height) return null;
    const { topCrop } = await smartcrop.crop(buffer, { width: 4, height: 3 });
    return {
      x: clamp01((topCrop.x + topCrop.width / 2) / width),
      y: clamp01((topCrop.y + topCrop.height / 2) / height),
      zoom: 1,
    };
  } catch {
    return null;
  }
}

/**
 * SSRF guard for {@link smartFocalFromUrl}. An entity's cover URL ultimately derives
 * from a client-settable field (`imageUrl` on the create/update DTOs), so a tenant
 * could point it at an internal address (`http://169.254.169.254/…`, a loopback
 * service, an internal host) and have the server fetch it. We pin the fetch to the
 * exact origin of our own storage's public base (R2/CDN): the only host ever
 * contacted is the CDN, whose DNS the attacker cannot make resolve to an internal
 * address. A non-matching origin (or unparseable URL, or missing base) → not allowed.
 */
export function isAllowedImageUrl(
  url: string,
  allowedBaseUrl: string | null | undefined,
): boolean {
  if (!allowedBaseUrl) return false;
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(allowedBaseUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  // origin = protocol + host + port — pins all three to the storage base.
  return target.origin === base.origin;
}

/**
 * Same as {@link smartFocal} but fetches the stored object first — used when only the
 * public URL is at hand (e.g. a gallery reorder/delete picks a new cover whose bytes
 * are no longer in memory). Times out fast and swallows errors → null on any hiccup.
 *
 * `allowedBaseUrl` is the storage public base (`StorageService.getPublicBaseUrl()`).
 * The fetch is refused (→ null) unless the URL lives under that exact origin — an
 * SSRF guard, since the URL can trace back to a client-settable `imageUrl`. Redirects
 * are not followed (`redirect:'error'`) so a CDN-side open redirect can't be chained
 * to an internal target.
 */
export async function smartFocalFromUrl(
  url: string,
  allowedBaseUrl: string | null | undefined,
): Promise<Focal | null> {
  if (!isAllowedImageUrl(url, allowedBaseUrl)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'error' });
    if (!res.ok) return null;
    return await smartFocal(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}
