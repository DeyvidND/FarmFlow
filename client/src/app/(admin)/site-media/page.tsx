'use client';

import { useEffect, useRef, useState } from 'react';
import { Upload, Trash2, ImageOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  getSiteMedia,
  uploadSiteMedia,
  deleteSiteMedia,
  type SiteMediaSlotDef,
} from '@/lib/api-client';

const ACCEPT = 'image/jpeg,image/png,image/webp';

/** Mirrors the storefront `.ph` placeholder (ferma theme) so an empty slot looks
 *  the same in the editor as it does live on the site. */
const MOCK_STYLE: React.CSSProperties = {
  backgroundColor: '#E4EADF',
  backgroundImage:
    'radial-gradient(rgba(63,125,67,.14) 1.6px, transparent 1.7px), radial-gradient(rgba(63,125,67,.14) 1.6px, transparent 1.7px)',
  backgroundPosition: '0 0, 9px 9px',
  backgroundSize: '18px 18px',
};

function SlotCard({
  slot,
  url,
  busy,
  onPick,
  onRemove,
}: {
  slot: SiteMediaSlotDef;
  url?: string;
  busy: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <div
        className={`relative w-full ${slot.rounded ? 'rounded-b-none' : ''}`}
        style={{ ...MOCK_STYLE, aspectRatio: slot.ratio }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={slot.label} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/60 px-3 py-1.5 text-center text-[11.5px] font-semibold uppercase tracking-[0.04em] text-[#76836E] backdrop-blur-[2px]">
            {slot.label}
          </span>
        )}
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-black/30 text-[13px] font-semibold text-white">
            Качване…
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 p-3.5">
        <div>
          <div className="text-[14px] font-bold text-ff-ink">{slot.label}</div>
          <div className="mt-0.5 text-[12px] text-ff-muted">
            Формат {slot.ratio.replace('/', ':')}
            {slot.note ? ` · ${slot.note}` : ''}
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPick(file);
            e.target.value = '';
          }}
        />

        <div className="mt-0.5 flex gap-2">
          <Button
            variant="soft"
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="flex-1 gap-1.5 rounded-sm py-2 text-[13.5px]"
          >
            <Upload size={15} /> {url ? 'Смени' : 'Качи снимка'}
          </Button>
          {url && (
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={onRemove}
              title="Премахни снимката"
              className="gap-1.5 rounded-sm px-3 py-2 text-[13.5px] text-ff-red hover:bg-ff-red/10"
            >
              <Trash2 size={15} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SiteMediaPage() {
  const [catalog, setCatalog] = useState<SiteMediaSlotDef[]>([]);
  const [values, setValues] = useState<Record<string, { url: string }>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    getSiteMedia()
      .then((res) => {
        setCatalog(res.catalog);
        setValues(res.values);
      })
      .catch(() => toast.error('Неуспешно зареждане'))
      .finally(() => setLoading(false));
  }, []);

  async function upload(slotKey: string, file: File) {
    setBusy((b) => ({ ...b, [slotKey]: true }));
    try {
      const { url } = await uploadSiteMedia(slotKey, file);
      setValues((v) => ({ ...v, [slotKey]: { url } }));
      toast.success('Снимката е качена');
    } catch {
      toast.error('Неуспешно качване');
    } finally {
      setBusy((b) => ({ ...b, [slotKey]: false }));
    }
  }

  async function remove(slotKey: string) {
    setBusy((b) => ({ ...b, [slotKey]: true }));
    try {
      await deleteSiteMedia(slotKey);
      setValues((v) => {
        const next = { ...v };
        delete next[slotKey];
        return next;
      });
      toast.success('Снимката е премахната');
    } catch {
      toast.error('Неуспешно изтриване');
    } finally {
      setBusy((b) => ({ ...b, [slotKey]: false }));
    }
  }

  // Group by page, preserving catalog order.
  const groups: { page: string; slots: SiteMediaSlotDef[] }[] = [];
  for (const slot of catalog) {
    let g = groups.find((x) => x.page === slot.page);
    if (!g) {
      g = { page: slot.page, slots: [] };
      groups.push(g);
    }
    g.slots.push(slot);
  }

  return (
    <div className="max-w-[1100px]">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Снимки на сайта</h1>
        <p className="text-[13.5px] text-ff-muted">
          Качи снимки за декоративните места на сайта. Без снимка местата показват сив макет.
        </p>
      </div>

      {loading ? (
        <p className="text-[14px] text-ff-muted">Зареждане…</p>
      ) : catalog.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl border border-ff-border bg-ff-surface p-6 text-[14px] text-ff-muted shadow-ff-sm">
          <ImageOff size={20} /> Няма декоративни места за този сайт.
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.page}>
              <h2 className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2">
                {group.page}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {group.slots.map((slot) => (
                  <SlotCard
                    key={slot.key}
                    slot={slot}
                    url={values[slot.key]?.url}
                    busy={!!busy[slot.key]}
                    onPick={(file) => upload(slot.key, file)}
                    onRemove={() => remove(slot.key)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
