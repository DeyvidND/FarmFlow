'use client';

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2, GripVertical, Star } from 'lucide-react';
import { toast } from 'sonner';
import {
  ApiError,
  listMedia,
  addMedia,
  deleteMedia,
  reorderMedia,
  type MediaResource,
} from '@/lib/api-client';
import type { MediaItem } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/**
 * Multi-image gallery editor shared by the product / farmer / subcategory dialogs.
 * Photo 0 is the cover (server keeps the owner's `imageUrl` synced to it); reorder
 * via drag or the ↑/↓ buttons, delete via the ✕. `onCoverChange` lets the parent
 * keep its own cover preview / list card in sync without a reload.
 */
export function MediaManager({
  resource,
  ownerId,
  onCoverChange,
}: {
  resource: MediaResource;
  ownerId: string;
  onCoverChange?: (url: string | null) => void;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    listMedia(resource, ownerId)
      .then((m) => alive && setItems(m))
      .catch(() => alive && toast.error('Снимките не се заредиха'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [resource, ownerId]);

  const announceCover = (next: MediaItem[]) => onCoverChange?.(next[0]?.url ?? null);

  async function onAdd(file: File) {
    setBusy(true);
    try {
      await addMedia(resource, ownerId, file);
      // Refetch: the server may have lazy-adopted a legacy cover as photo 0, so the
      // returned single row isn't enough to know the true order.
      const fresh = await listMedia(resource, ownerId);
      setItems(fresh);
      announceCover(fresh);
      toast.success('Снимката е качена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(m: MediaItem) {
    const prev = items;
    const next = items.filter((x) => x.id !== m.id).map((x, i) => ({ ...x, position: i }));
    setItems(next); // optimistic
    announceCover(next);
    try {
      await deleteMedia(resource, ownerId, m.id);
    } catch (e) {
      setItems(prev); // rollback
      announceCover(prev);
      toast.error(errMsg(e));
    }
  }

  async function persistOrder(next: MediaItem[]) {
    setItems(next);
    announceCover(next);
    try {
      const saved = await reorderMedia(
        resource,
        ownerId,
        next.map((m, i) => ({ id: m.id, position: i })),
      );
      setItems(saved);
      announceCover(saved);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    void persistOrder(next.map((m, i) => ({ ...m, position: i })));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12.5px] font-bold text-ff-ink-2">
        Снимки {loading ? '' : `(${items.length})`}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        {items.map((m, i) => (
          <div
            key={m.id}
            draggable
            onDragStart={() => {
              dragIndex.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex.current !== null) {
                move(dragIndex.current, i);
                dragIndex.current = null;
              }
            }}
            className="group relative aspect-square overflow-hidden rounded-lg border border-ff-border bg-ff-surface-2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.url} alt="" className="h-full w-full object-cover" />

            {i === 0 && (
              <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-ff-green-600/90 px-1.5 py-0.5 text-[9.5px] font-bold text-white">
                <Star size={9} fill="currentColor" /> Корица
              </span>
            )}

            <div className="absolute inset-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/55 to-transparent p-1 opacity-0 transition group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <span className="grid h-6 w-6 cursor-grab place-items-center rounded bg-white/85 text-ff-ink" title="Влачи за подреждане">
                <GripVertical size={13} />
              </span>
              <div className="flex gap-1">
                {i !== 0 && (
                  <button
                    type="button"
                    onClick={() => move(i, 0)}
                    aria-label="Направи корица"
                    title="Направи корица"
                    className="grid h-6 w-6 place-items-center rounded bg-white/85 text-ff-green-700 hover:bg-white"
                  >
                    <Star size={12} />
                  </button>
                )}
                <MiniBtn disabled={i === 0} onClick={() => move(i, i - 1)} label="Нагоре">
                  ↑
                </MiniBtn>
                <MiniBtn disabled={i === items.length - 1} onClick={() => move(i, i + 1)} label="Надолу">
                  ↓
                </MiniBtn>
                <button
                  type="button"
                  onClick={() => onDelete(m)}
                  aria-label="Изтрий снимка"
                  className="grid h-6 w-6 place-items-center rounded bg-white/85 text-ff-red hover:bg-white"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="grid aspect-square place-items-center rounded-lg border border-dashed border-ff-border-2 bg-ff-surface-2 text-ff-muted transition hover:border-ff-green-500 hover:text-ff-ink disabled:opacity-50"
        >
          <span className="inline-flex flex-col items-center gap-1 text-[10.5px] font-semibold">
            <ImagePlus size={18} /> {busy ? '…' : 'Добави'}
          </span>
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onAdd(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function MiniBtn({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-6 w-6 place-items-center rounded bg-white/85 text-[13px] font-bold text-ff-ink hover:bg-white disabled:opacity-40"
    >
      {children}
    </button>
  );
}
