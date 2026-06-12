'use client';

import { useEffect, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { coverCropStyle } from '@/lib/cover-crop';
import type { CoverCrop } from '@/lib/types';

function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Berry-motif placeholder (components.jsx ProductThumb); doubles as the
 *  image-upload trigger. Shows the real image when one is set. */
export function ProductThumb({
  imageUrl,
  coverCrop,
  uploading,
  onPick,
}: {
  imageUrl?: string | null;
  /** Farmer's saved framing — applied so the panel shows the same crop as the shop. */
  coverCrop?: CoverCrop | null;
  uploading?: boolean;
  onPick?: () => void;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [imageUrl]);
  const g = '#4C8A54';
  const showImg = imageUrl && !broken;

  return (
    <button
      type="button"
      onClick={onPick}
      // Aspect 4:3 matches the default storefront product card, so a photo framed
      // here lands the same in the shop (portrait or landscape, both look uniform).
      className="relative grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-xl border border-ff-border-2"
      style={{ background: 'linear-gradient(150deg, var(--ff-green-50), var(--ff-surface-2))' }}
      title="Качи снимка"
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" loading="lazy" decoding="async" className="h-full w-full" style={coverCropStyle(coverCrop)} onError={() => setBroken(true)} />
      ) : (
        <svg viewBox="0 0 60 40" width="62%" height="62%" style={{ opacity: 0.7 }}>
          <circle cx="24" cy="22" r="8" fill={hexA(g, 0.3)} />
          <circle cx="36" cy="20" r="6.5" fill={hexA(g, 0.2)} />
          <circle cx="31" cy="28" r="5" fill={hexA(g, 0.26)} />
          <path d="M24 14c-1-4 1-7 4-8" stroke={hexA(g, 0.6)} strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      )}
      <span className="absolute bottom-[7px] right-2 inline-flex items-center gap-1 rounded-full bg-white/80 px-[7px] py-0.5 text-[10.5px] font-semibold text-ff-muted">
        <ImageIcon size={12} /> {uploading ? 'качване…' : 'снимка'}
      </span>
    </button>
  );
}
