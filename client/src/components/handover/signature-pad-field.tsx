'use client';
import { useEffect, useRef, useState } from 'react';
import { Eraser, Check } from 'lucide-react';
import { signatureIsBlank } from './signature-export';

/**
 * Mobile-first signature capture. High-DPI canvas (crisp on phones), preview of
 * the captured signature, and a saved-image state with „Промени"/„Изтрий".
 * Emits a PNG data-URL (or null when deleted). Parent persists it.
 *
 * COMMIT MODEL: strokes accumulate in local `draft` state and `onChange` fires
 * exactly ONCE, from „Готово". It used to fire on every pen-lift, which turned
 * one signature into several writes (and several "saved" toasts), and let a
 * partial stroke overwrite the finished one if responses raced. „Изчисти" is
 * local-only; removing a stored signature goes through „Изтрий", which confirms
 * first because the parent's `onChange(null)` is an irreversible server delete.
 */
export function SignaturePadField({
  value,
  onChange,
  label = 'Подпис',
  commit: commitMode = 'explicit',
}: {
  value: string | null;
  onChange: (png: string | null) => void;
  label?: string;
  /**
   * When `onChange` PERSISTS (a network write), keep the default 'explicit':
   * strokes stay local and one write happens on „Готово".
   *
   * Use 'live' only where `onChange` is a plain setState — the sign-protocol
   * dialog, where two people sign in turn and the submit button reads that
   * state. There, per-stroke updates cost nothing and skipping „Готово" would
   * otherwise submit an empty signature.
   */
  commit?: 'explicit' | 'live';
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [editing, setEditing] = useState(!value);
  const [dirty, setDirty] = useState(false);
  /** Uncommitted strokes. Kept out of `value` so the parent never persists a
   *  half-drawn signature — see `up`. */
  const [draft, setDraft] = useState<string | null>(null);
  /** „Изтрий" is a server-side delete with no undo, so it asks first. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
  // Strokes accumulate LOCALLY. `onChange` is the parent's persist call, so
  // firing it per pen-lift meant a 4-stroke signature became 4 writes and 4
  // „запазено" toasts — and, if the responses landed out of order, a 2-stroke
  // fragment could overwrite the finished signature. Only „Готово" commits.
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const png = ref.current!.toDataURL('image/png');
    const next = signatureIsBlank(png) ? null : png;
    setDraft(next);
    if (commitMode === 'live') onChange(next);
  };
  /** Wipes the pad. Local only — it must never delete an already-saved
   *  signature; that is what „Изтрий" (with its confirm) is for. */
  const clear = () => {
    const c = ref.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setDirty(false);
    setDraft(null);
    if (commitMode === 'live') onChange(null);
  };
  const commit = () => {
    if (!draft) return;
    if (commitMode === 'explicit') onChange(draft); // the ONE write
    setDraft(null);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(null);
    setDirty(false);
    setEditing(false);
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
        {confirmingDelete ? (
          <div className="flex flex-col gap-2 rounded-lg border border-ff-red/40 bg-ff-surface-2 p-3">
            <p className="text-[13px] font-semibold text-ff-ink">
              Подписът ще бъде премахнат и няма да се слага на бъдещите протоколи.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                  onChange(null);
                  setEditing(true);
                }}
                className="min-h-[44px] rounded-lg bg-ff-red px-4 text-[14px] font-bold text-white"
              >
                Изтрий
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="min-h-[44px] rounded-lg border border-ff-border px-4 text-[14px] font-bold text-ff-ink-2"
              >
                Откажи
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="min-h-[44px] text-[14px] font-bold text-ff-green-700 underline"
            >
              Промени
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="min-h-[44px] text-[14px] font-bold text-ff-red underline"
            >
              Изтрий
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
        {/* Always offered, not only when `dirty`: re-entering the editor over an
            existing signature previously showed no way to start over. */}
        <button
          type="button"
          onClick={clear}
          className="inline-flex min-h-[44px] items-center gap-1 text-[14px] font-bold text-ff-green-700"
        >
          <Eraser size={15} /> Изчисти
        </button>
      </div>
      <canvas
        ref={ref}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        className="h-40 w-full touch-none rounded-lg border-2 border-dashed border-ff-border bg-white"
      />
      {/* 13px, not 11.5 — this is the only instruction on the card and its reader
          is often wearing reading glasses. */}
      <p className="text-[13px] text-ff-muted">Подпиши се в полето с пръст или писалка.</p>

      {/* Preview of the UNCOMMITTED signature — how it will look on the protocol,
          shown before anything is saved. */}
      {draft && (
        <div className="mt-1">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ff-muted">Преглед</div>
          <div className="rounded-lg border border-ff-border bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={draft} alt="преглед" className="mx-auto h-16 w-auto object-contain" />
          </div>
        </div>
      )}

      <div className="flex gap-2">
        {/* Always rendered, disabled while blank. Previously it appeared only
            when a signature existed, so clearing the pad left no way out. */}
        <button
          type="button"
          onClick={commit}
          disabled={!draft}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-ff-green-700 px-3 text-[14px] font-bold text-white disabled:opacity-50"
        >
          <Check size={15} /> Готово
        </button>
        {value && (
          <button
            type="button"
            onClick={cancel}
            className="min-h-[44px] rounded-lg border border-ff-border px-4 text-[14px] font-bold text-ff-ink-2"
          >
            Откажи
          </button>
        )}
      </div>
      {/* Only true in 'explicit' mode — in 'live' the parent already has it. */}
      {!draft && commitMode === 'explicit' && (
        <p className="text-[12px] text-ff-muted">Подписът се запазва чак когато натиснеш „Готово".</p>
      )}
    </div>
  );
}
