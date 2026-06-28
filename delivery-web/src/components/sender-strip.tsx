'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pencil, AlertTriangle } from 'lucide-react';
import { getEcontConfig, getSpeedyConfig } from '@/lib/api-client';
import { SenderModal } from './sender-modal';

type Row = {
  carrier: 'econt' | 'speedy';
  label: string;
  sender: { name?: string; officeCode?: string; cityName?: string } | null;
  configured: boolean;
};

/** Compact „Подаваш от: …" strip shown atop Пратки/Внос. One row per connected
 *  carrier; ✎ opens the SenderModal. Replaces the „Профил на подател" settings page. */
export function SenderStrip() {
  const [rows, setRows] = useState<Row[]>([]);
  const [editing, setEditing] = useState<'econt' | 'speedy' | null>(null);

  const load = useCallback(async () => {
    const [e, s] = await Promise.allSettled([getEcontConfig(), getSpeedyConfig()]);
    const next: Row[] = [];
    if (e.status === 'fulfilled' && e.value?.configured) {
      next.push({ carrier: 'econt', label: 'Еконт', sender: (e.value.sender as Row['sender']) ?? null, configured: true });
    }
    if (s.status === 'fulfilled' && s.value?.configured) {
      next.push({ carrier: 'speedy', label: 'Speedy', sender: (s.value.sender as Row['sender']) ?? null, configured: true });
    }
    setRows(next);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!rows.length) return null;

  return (
    <div className="mb-4 flex flex-col gap-2">
      {rows.map((r) => {
        const place = r.sender?.officeCode ? `офис ${r.sender.officeCode}` : (r.sender?.cityName ?? '');
        const hasPickup = !!(r.sender?.officeCode || r.sender?.cityName);
        return (
          <div key={r.carrier} className="flex items-center justify-between gap-3 rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-2.5">
            <div className="min-w-0 text-[13.5px] text-ff-ink-2">
              {hasPickup ? (
                <>Подаваш от <b className="text-ff-ink">{r.sender?.name}</b>{place ? <> · {place}</> : null} <span className="text-ff-muted">({r.label})</span></>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-bold text-ff-amber-600">
                  <AlertTriangle size={15} /> Избери офис на подаване ({r.label})
                </span>
              )}
            </div>
            <button type="button" onClick={() => setEditing(r.carrier)} className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-bold text-ff-green-700">
              <Pencil size={14} /> Промени
            </button>
          </div>
        );
      })}
      <SenderModal
        carrier={editing ?? 'econt'}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
    </div>
  );
}
