'use client';
import { useEffect, useRef, useState } from 'react';
import { Eraser, Check } from 'lucide-react';
import { signatureIsBlank } from './signature-export';

/**
 * Mobile-first signature capture. High-DPI canvas (crisp on phones), preview of
 * the captured signature, and a saved-image state with „Промени"/„Изтрий".
 * Emits a PNG data-URL (or null when cleared). Parent persists it.
 */
export function SignaturePadField({
  value,
  onChange,
  label = 'Подпис',
}: {
  value: string | null;
  onChange: (png: string | null) => void;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [editing, setEditing] = useState(!value);
  const [dirty, setDirty] = useState(false);

  // Size the backing store to CSS px × devicePixelRatio so strokes stay sharp.
  useEffect(() => {
    if (!editing) return;
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1c1a17';
  }, [editing]);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => {
    drawing.current = true;
    const ctx = ref.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!dirty) setDirty(true);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const png = ref.current!.toDataURL('image/png');
    onChange(signatureIsBlank(png) ? null : png);
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setDirty(false);
    onChange(null);
  };

  // Saved, not editing → show the stored signature with actions.
  if (!editing && value) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
        <div className="rounded-lg border border-ff-border bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt={label} className="mx-auto h-24 w-auto object-contain" />
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setEditing(true)} className="text-[13px] font-bold text-ff-green-700 underline">Промени</button>
          <button type="button" onClick={() => { onChange(null); setEditing(true); }} className="text-[13px] font-bold text-ff-red underline">Изтрий</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
        {dirty && (
          <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-[13px] font-bold text-ff-green-700">
            <Eraser size={14} /> Изчисти
          </button>
        )}
      </div>
      <canvas
        ref={ref}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        className="h-40 w-full touch-none rounded-lg border-2 border-dashed border-ff-border bg-white"
      />
      <p className="text-[11.5px] text-ff-muted">Подпишете се в полето с пръст или писалка.</p>
      {value && (
        <div className="mt-1">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ff-muted">Преглед</div>
          <div className="rounded-lg border border-ff-border bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt="преглед" className="mx-auto h-16 w-auto object-contain" />
          </div>
        </div>
      )}
      {value && (
        <button type="button" onClick={() => setEditing(false)} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ff-green-700 px-3 py-2 text-[13.5px] font-bold text-white">
          <Check size={15} /> Готово
        </button>
      )}
    </div>
  );
}
