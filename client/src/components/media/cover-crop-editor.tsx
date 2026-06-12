'use client';

import { useEffect, useRef, useState } from 'react';
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
  aspects,
  onChange,
}: {
  imageUrl: string;
  value: CoverCrop | null;
  /** Frame aspect ratio (width / height) — match the storefront card. */
  aspect: number;
  /**
   * Optional preview-aspect choices. When the same image renders at several
   * aspects live (e.g. a product card whose box differs per visitor-selected
   * storefront theme), pass them here to show a segmented toggle so the farmer
   * can check the framing in each. `aspect` is the default. The crop value
   * (focal point + zoom) is aspect-independent, so switching only re-frames the
   * preview — it never mutates the saved crop.
   */
  aspects?: { label: string; value: number; shape?: 'wide' | 'square' | 'tall' }[];
  onChange: (next: CoverCrop) => void;
}) {
  const crop = value ?? DEFAULT_CROP;
  // Which aspect the preview frame uses; defaults to the canonical `aspect`.
  // Initialise from the saved shape so the preview matches what's stored.
  const [previewAspect, setPreviewAspect] = useState(() => {
    if (value?.shape && aspects) {
      const saved = aspects.find((a) => a.shape === value.shape);
      if (saved) return saved.value;
    }
    return aspect;
  });
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

      {aspects && aspects.length > 1 && (
        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] font-semibold text-ff-muted-2">Форма:</span>
          <div className="inline-flex overflow-hidden rounded-lg border border-ff-border">
            {aspects.map((a) => {
              const active = Math.abs(a.value - previewAspect) < 1e-6;
              return (
                <button
                  key={a.label}
                  type="button"
                  // Preview-only: switching shape just re-frames the preview box so the
                  // farmer can check the focal point at each card shape. It does NOT persist
                  // a per-product shape — every product card stays the same (theme) aspect so
                  // the grid never goes ragged. Framing is controlled by zoom + pan, which ARE
                  // shape-independent (focal point), so the saved crop works in any shape.
                  onClick={() => setPreviewAspect(a.value)}
                  className={`px-2 py-1 text-[11.5px] font-bold ${
                    active ? 'bg-ff-green-600 text-white' : 'bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2'
                  }`}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative w-full cursor-grab overflow-hidden rounded-lg border border-ff-border bg-ff-surface-2 active:cursor-grabbing"
        style={{ aspectRatio: String(previewAspect), touchAction: 'none' }}
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
