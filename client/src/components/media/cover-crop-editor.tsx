'use client';

import { useEffect, useRef } from 'react';
import { Move, RotateCcw, ZoomIn } from 'lucide-react';
import type { CoverCrop } from '@/lib/types';
import { coverCropStyle, clamp, DEFAULT_CROP, ZOOM_MIN, ZOOM_MAX } from '@/lib/cover-crop';

/**
 * Discord-style cover framing control. Drag the image to pan (sets the focal
 * point), slider or wheel to zoom. The preview frame uses the *exact* storefront
 * render math (`coverCropStyle`) at the storefront card's aspect ratio, so what
 * the farm sees here is what the card shows. Fully controlled: every change calls
 * `onChange` with the new {@link CoverCrop}. `null` value = centered, no zoom.
 *
 * Mounted only once a cover image exists; the parent resets the value to `null`
 * when the cover image itself changes (a new photo invalidates the old framing).
 */
export function CoverCropEditor({
  imageUrl,
  value,
  aspect,
  onChange,
}: {
  imageUrl: string;
  value: CoverCrop | null;
  /** Frame aspect ratio (width / height) — match the storefront card. */
  aspect: number;
  onChange: (next: CoverCrop) => void;
}) {
  const crop = value ?? DEFAULT_CROP;
  // Latest crop for the pointer handlers (closures can lag behind fast moves).
  const cropRef = useRef(crop);
  cropRef.current = crop;

  const frameRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  const setZoom = (zoom: number) =>
    onChange({ ...cropRef.current, zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) });

  function onPointerDown(e: React.PointerEvent) {
    frameRef.current?.setPointerCapture(e.pointerId);
    dragFrom.current = { x: e.clientX, y: e.clientY };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragFrom.current) return;
    const r = frameRef.current?.getBoundingClientRect();
    if (!r) return;
    const dx = e.clientX - dragFrom.current.x;
    const dy = e.clientY - dragFrom.current.y;
    dragFrom.current = { x: e.clientX, y: e.clientY };
    // Dragging the image right reveals its left → focal point moves left.
    const c = cropRef.current;
    onChange({
      ...c,
      x: clamp(c.x - dx / r.width, 0, 1),
      y: clamp(c.y - dy / r.height, 0, 1),
    });
  }
  function endDrag() {
    dragFrom.current = null;
  }

  // Wheel-to-zoom needs a non-passive listener to preventDefault the page scroll.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(cropRef.current.zoom - e.deltaY * 0.0015);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-ff-ink-2">
          <Move size={13} /> Нагласи рамката
        </div>
        <button
          type="button"
          onClick={() => onChange(DEFAULT_CROP)}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ff-muted hover:text-ff-ink"
        >
          <RotateCcw size={12} /> Центрирай
        </button>
      </div>

      <div
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative w-full cursor-grab overflow-hidden rounded-lg border border-ff-border bg-ff-surface-2 active:cursor-grabbing"
        style={{ aspectRatio: String(aspect), touchAction: 'none' }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className="pointer-events-none select-none"
          style={{ width: '100%', height: '100%', ...coverCropStyle(crop) }}
        />
      </div>

      <label className="flex items-center gap-2 text-[12px] font-semibold text-ff-muted">
        <ZoomIn size={14} className="shrink-0" />
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={0.01}
          value={crop.zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="h-1 w-full cursor-pointer accent-ff-green-600"
        />
        <span className="w-9 text-right tabular-nums">{crop.zoom.toFixed(1)}×</span>
      </label>
      <p className="text-[11.5px] text-ff-muted-2">
        Влачи снимката за да избереш коя част се вижда; колелцето или плъзгача увеличава.
      </p>
    </div>
  );
}
