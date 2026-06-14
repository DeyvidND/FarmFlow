import sharp from 'sharp';

/** Longest-edge cap for stored catalog images. A storefront card renders at a few
 *  hundred CSS px (≤ ~1200 on a 2x retina hero), so 1600px is the practical ceiling
 *  — anything larger is wasted bytes on every page view. */
const MAX_EDGE = 1600;

/** WebP quality. 82 is visually lossless for produce photography while ~10× smaller
 *  than a full-res phone JPEG. */
const QUALITY = 82;

/** Encoder effort 0–6. Encoding happens once at upload; the object is served on every
 *  page view, so we spend the extra CPU for a smaller file (~5–15% over the default 4).
 *  smartSubsample preserves sharp colour edges at this quality. */
const EFFORT = 6;

/** MIME types we re-encode. Everything else (e.g. video for article media) passes
 *  through untouched. The product/farmer/subcategory upload guards already restrict
 *  to this set; articles also allow video, which lands in the pass-through path. */
const RASTER = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  /** File extension to use in the storage key (without a leading dot). */
  ext: string;
}

/**
 * Downscale + re-encode an uploaded raster image so the STORED object is web-sized:
 * a 4000px multi-MB phone JPEG becomes a ~1600px WebP of a few hundred KB. EXIF
 * orientation is baked in and all other metadata stripped. Because this shrinks the
 * single stored object, every consumer (both storefronts + the admin grids) loads
 * the smaller file with no schema change or per-image plumbing.
 *
 * Robust by design: non-raster input (SVG/GIF/video) or ANY sharp failure returns
 * the original bytes + extension unchanged, so an upload never fails or silently
 * loses a photo because of optimization. The re-encoded result is also only used
 * when it's actually smaller than the source.
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
    if (out.length < buffer.length) {
      return { buffer: out, contentType: 'image/webp', ext: 'webp' };
    }
    // Already small/efficient — keep the original to avoid a pointless re-encode.
    return { buffer, contentType: mime, ext: fallbackExt };
  } catch {
    return { buffer, contentType: mime, ext: fallbackExt };
  }
}
