/**
 * Turn a stored {@link CoverCrop} (focal point + zoom) into inline styles for a
 * cover `<img>` that uses `object-fit: cover`. `objectPosition` pans to the focal
 * point; `transform: scale` zooms in around it. NULL → centered, no zoom (exactly
 * the legacy look). The admin editor uses the identical math, so the preview is
 * WYSIWYG. The `<img>` MUST sit in an `overflow: hidden` box or the zoom spills.
 */
import type { CSSProperties } from 'react';
import type { CoverCrop } from '@farmflow/types';

const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

export function coverCropStyle(crop?: CoverCrop | null): CSSProperties {
  const x = crop ? clamp(crop.x, 0, 1) : 0.5;
  const y = crop ? clamp(crop.y, 0, 1) : 0.5;
  const zoom = crop ? clamp(crop.zoom, 1, 3) : 1;
  const pos = `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`;
  return {
    objectFit: 'cover',
    objectPosition: pos,
    ...(zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: pos } : {}),
  };
}
