'use client';

import { coverCropStyle } from '@/lib/cover-crop';
import type { CoverCrop } from '@/lib/types';

/** hex + alpha → rgba() string, with a green fallback for null tints. */
export function hexA(hex: string | null, a: number): string {
  const h = (hex ?? '#4C8A54').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** First letters of up to two words, e.g. "Петър Петров" → "ПП". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

/** Farmer avatar — uploaded photo, else initials on a tinted disc. */
export function Avatar({
  name,
  tint,
  imageUrl,
  coverCrop,
  size = 44,
  ring = false,
}: {
  name: string;
  tint: string | null;
  imageUrl?: string | null;
  /** Farmer's saved cover framing — applied so the avatar respects their focal point. */
  coverCrop?: CoverCrop | null;
  size?: number;
  ring?: boolean;
}) {
  const t = tint ?? '#2C5530';
  if (imageUrl) {
    return (
      // overflow-hidden wrapper clips a zoomed (scale > 1) framing to the circle.
      <span className="block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={name}
          loading="lazy"
          decoding="async"
          className="h-full w-full"
          style={coverCropStyle(coverCrop)}
        />
      </span>
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-display font-extrabold tracking-[-0.01em]"
      style={{
        width: size,
        height: size,
        background: hexA(t, 0.16),
        color: t,
        fontSize: size * 0.36,
        boxShadow: ring ? `inset 0 0 0 1.5px ${hexA(t, 0.4)}` : 'none',
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
