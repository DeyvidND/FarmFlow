import sharp from 'sharp';

/** Longest-edge cap for the stored MASTER. Cloudflare Transformations resizes this
 *  down per request, so the master only needs enough pixels for the largest delivery
 *  (display × DPR × cover-crop zoom). 2560 covers a retina hero and a 3× zoomed crop
 *  while staying well inside CF's input limits; storage is ~free ($0.015/GB). */
const MAX_EDGE = 2560;

/** WebP quality for the master. Higher than a delivered file (was 82) because the
 *  edge re-encodes this again (WebP→AVIF); a high-quality master avoids compounded
 *  generation loss. The edge applies the real per-request quality on delivery. */
const QUALITY = 90;

/** Encoder effort 0–6. Encoding happens once at upload; spend the CPU for a smaller
 *  master. smartSubsample preserves sharp colour edges at this quality. */
const EFFORT = 6;

/** MIME types we re-encode. Everything else (e.g. SVG/GIF, or video for article
 *  media) passes through untouched. The product/farmer/subcategory upload guards
 *  already restrict to this set. */
const RASTER = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Longest edge for a processed favicon. Google's favicon indexing wants a
 *  roughly-square image (docs: "a multiple of 48px, square") — this is well
 *  above that floor while staying a small file. */
const FAVICON_EDGE = 512;

/**
 * Force an uploaded favicon to a proper square icon. Admins sometimes upload
 * their raw logo/banner (arbitrary aspect ratio, thousands of pixels) — that
 * renders fine shrunk into a browser tab, but Google's Search favicon crawler
 * rejects non-square images and falls back to a generic globe. `fit: 'cover'`
 * center-crops to square before resizing, so this always emits a clean
 * FAVICON_EDGE×FAVICON_EDGE icon. ICO passes through untouched — sharp's ICO
 * decode is unreliable, and .ico files already carry their own square frames.
 * Any sharp failure returns the original bytes (never fail the upload).
 */
export async function squareFavicon(buffer: Buffer, mime: string): Promise<Buffer> {
  if (mime !== 'image/png') return buffer;
  try {
    return await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: FAVICON_EDGE, height: FAVICON_EDGE, fit: 'cover' })
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  /** File extension to use in the storage key (without a leading dot). */
  ext: string;
}

/**
 * Re-encode an uploaded raster image into a clean, web-sized WebP MASTER: a 4000px
 * multi-MB phone JPEG becomes a ~2560px WebP. EXIF orientation is baked in and all
 * other metadata stripped. The stored object is not the delivered file — Cloudflare
 * Transformations sits in front and resizes + re-encodes (AVIF/WebP) per request —
 * so this just produces one transform-safe source per image, no schema change or
 * per-image plumbing.
 *
 * Raster input is ALWAYS re-encoded to WebP (not "only if smaller"): a consistent,
 * standard WebP master is what keeps every object transformable. Odd source formats
 * — notably some legacy PNGs — make Cloudflare's decoder fail (`ERROR 9516`); always
 * normalising to WebP removes that class of failure going forward.
 *
 * Robust by design: non-raster input (SVG/GIF/video) or ANY sharp failure returns
 * the original bytes + extension unchanged, so an upload never fails or silently
 * loses a photo because of optimization.
 */
export async function optimizeImage(
  buffer: Buffer,
  mime: string,
  fallbackExt: string,
): Promise<ProcessedImage> {
  if (!RASTER.has(mime)) return { buffer, contentType: mime, ext: fallbackExt };
  try {
    const out = await sharp(buffer, { failOn: 'none' })
      .rotate() // apply EXIF orientation before metadata is dropped by re-encode
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: EFFORT, smartSubsample: true })
      .toBuffer();
    return { buffer: out, contentType: 'image/webp', ext: 'webp' };
  } catch {
    return { buffer, contentType: mime, ext: fallbackExt };
  }
}
