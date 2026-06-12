'use client';

import { Image as ImageIcon } from 'lucide-react';
import { hexA } from '@/components/farmers/avatar';
import { coverCropStyle } from '@/lib/cover-crop';
import type { CoverCrop } from '@/lib/types';

/** Section banner — uploaded photo, else a tinted gradient placeholder. */
export function SectionPhoto({
  tint,
  imageUrl,
  coverCrop,
  height = 120,
  radius = 12,
  label = true,
}: {
  tint: string | null;
  imageUrl?: string | null;
  /** Farmer's saved framing — applied so the banner matches the shop. */
  coverCrop?: CoverCrop | null;
  height?: number;
  radius?: number;
  label?: boolean;
}) {
  const t = tint ?? '#4C8A54';
  if (imageUrl) {
    return (
      // overflow-hidden so a zoomed (scale > 1) framing clips to the banner box.
      <div className="w-full overflow-hidden" style={{ height, borderRadius: radius }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="" loading="lazy" decoding="async" className="h-full w-full" style={coverCropStyle(coverCrop)} />
      </div>
    );
  }
  return (
    <div
      className="relative w-full overflow-hidden border border-ff-border-2"
      style={{ height, borderRadius: radius, background: `linear-gradient(135deg, ${hexA(t, 0.18)}, var(--ff-surface-2))` }}
    >
      <svg viewBox="0 0 120 60" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full opacity-50">
        <path d="M0 46 Q 20 34 40 42 T 80 40 T 120 46 V60 H0Z" fill={hexA(t, 0.22)} />
        <path d="M0 52 Q 30 44 60 50 T 120 50 V60 H0Z" fill={hexA(t, 0.16)} />
        <circle cx="92" cy="18" r="9" fill={hexA(t, 0.2)} />
      </svg>
      {label && (
        <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-white/80 px-[7px] py-0.5 text-[10.5px] font-semibold text-ff-muted">
          <ImageIcon size={12} /> снимка на секцията
        </span>
      )}
    </div>
  );
}
