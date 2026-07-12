import sharp from 'sharp';

export interface InlineSanityResult {
  anomaly: boolean;
  reasons: string[];
}

// Below this on the short edge, a photo is too small for a usable storefront
// card — flag it rather than let a postage-stamp thumbnail slip through.
const MIN_EDGE = 400;
// Longest:shortest edge ratio above this reads as a sliver/banner crop, not a
// normal product photo (e.g. a screenshot strip or an accidental panorama).
const MAX_ASPECT_RATIO = 3;
// Laplacian-edge stdev floor below which a photo reads as out-of-focus. Tuned
// empirically against a handful of sharp vs. visibly blurred product photos —
// revisit if farmers report sharp photos getting flagged.
const BLUR_FLOOR = 6;

const RASTER = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Grayscale Laplacian-edge stdev — a cheap, well-known blur proxy (low edge
 *  energy = blurry). Downscaled first so cost stays flat regardless of the
 *  source resolution. */
async function laplacianVariance(buffer: Buffer): Promise<number> {
  const { channels } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize({ width: 500, height: 500, fit: 'inside', withoutEnlargement: true })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .stats();
  return channels[0]?.stdev ?? Number.POSITIVE_INFINITY;
}

/**
 * Cheap, synchronous (no network) product-photo checks — runs inline on
 * upload so the vast majority of clean photos never reach the vision worker.
 * Flags, never blocks: the upload always proceeds; an anomaly only queues a
 * closer, vision-based look (see `ImageSanityVisionClient`).
 */
export async function inlineSanityCheck(buffer: Buffer, mime: string): Promise<InlineSanityResult> {
  if (!RASTER.has(mime)) return { anomaly: false, reasons: [] };
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
    const reasons: string[] = [];
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w > 0 && h > 0) {
      if (Math.min(w, h) < MIN_EDGE) reasons.push('ниска резолюция');
      if (Math.max(w, h) / Math.min(w, h) > MAX_ASPECT_RATIO) reasons.push('необичайно съотношение');
    }
    if ((await laplacianVariance(buffer)) < BLUR_FLOOR) reasons.push('замъглена');
    return { anomaly: reasons.length > 0, reasons };
  } catch {
    // A check that can't run is not a verdict — never block or flag on our own failure.
    return { anomaly: false, reasons: [] };
  }
}
