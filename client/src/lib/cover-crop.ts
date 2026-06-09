/**
 * Cover-image framing math, shared by the admin <CoverCropEditor> preview and the
 * storefront render (the storefront keeps its own identical copy under its package
 * boundary). `objectPosition` pans to the focal point; `transform: scale` zooms in
 * around it. The `<img>` must live in an `overflow: hidden` box.
 */
import type { CSSProperties } from 'react';
import type { CoverCrop } from './types';

export const DEFAULT_CROP: CoverCrop = { x: 0.5, y: 0.5, zoom: 1 };
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 3;

export const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

export function coverCropStyle(crop?: CoverCrop | null): CSSProperties {
  const x = clamp(crop?.x ?? 0.5, 0, 1);
  const y = clamp(crop?.y ?? 0.5, 0, 1);
  const zoom = clamp(crop?.zoom ?? 1, ZOOM_MIN, ZOOM_MAX);
  const pos = `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`;
  return {
    objectFit: 'cover',
    objectPosition: pos,
    ...(zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: pos } : {}),
  };
}
