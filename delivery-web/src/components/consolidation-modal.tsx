'use client';

import { useState } from 'react';
import { ApiError, consolidateShipments, type Carrier, type ConsolidationSuggestion } from '@/lib/api-client';
import { cn, eur } from '@/lib/utils';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Обединяването се провали');

/**
 * One consolidation suggestion → one modal. Lets the operator pick which farmer
 * collects the merged parcel (radio over the group's members) and, optionally,
 * force a carrier — then calls consolidateShipments and lets the caller refresh.
 */
export function ConsolidationModal({
  suggestion,
  onClose,
  onDone,
}: {
  suggestion: ConsolidationSuggestion;
  onClose: () => void;
  onDone: () => void;
}) {
  const [collector, setCollector] = useState<string>(suggestion.members[0]?.farmerId ?? '');
  const [carrier, setCarrier] = useState<Carrier | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await consolidateShipments({
        collectorFarmerId: collector,
        memberOrderIds: suggestion.members.map((m) => m.orderId),
        carrier: carrier || undefined,
      });
      onDone();
    } catch (e) {
      // The server sends a Bulgarian message (e.g. "Изберете куриер...") — surface it as-is.
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-ff-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-[18px] font-extrabold text-ff-ink">Обедини в 1 товарителница</h2>
        <p className="mt-1 text-[13px] text-ff-muted">
          {suggestion.customerName ?? 'Клиент'} · {suggestion.deliveryCity ?? '—'} · {suggestion.deliveryAddress ?? '—'}
        </p>

        <div className="mt-4 space-y-2">
          <div className="text-[12.5px] font-bold text-ff-muted">Кой фермер събира пратката?</div>
          {suggestion.members.map((m) => {
            const active = collector === m.farmerId;
            return (
              <label
                key={m.farmerId}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-2.5 text-[13px]',
                  active ? 'border-ff-green-500 bg-ff-green-50' : 'border-ff-border bg-ff-surface-2',
                )}
              >
                <span className="flex items-center gap-2 font-semibold text-ff-ink">
                  <input
                    type="radio"
                    name="collector"
                    value={m.farmerId}
                    checked={active}
                    onChange={() => setCollector(m.farmerId)}
                    className="h-4 w-4 accent-ff-green-700"
                  />
                  {m.farmerName ?? 'Ферма'}
                </span>
                <span className="ff-fig text-ff-muted">{eur(m.totalStotinki)}</span>
              </label>
            );
          })}
        </div>

        <div className="mt-3.5">
          <div className="text-[12.5px] font-bold text-ff-muted">Куриер</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(['', 'econt', 'speedy'] as const).map((c) => (
              <button
                key={c || 'auto'}
                type="button"
                onClick={() => setCarrier(c)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-[12.5px] font-bold transition-colors',
                  carrier === c ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-800' : 'border-ff-border text-ff-ink-2 hover:text-ff-ink',
                )}
              >
                {c === '' ? 'Автоматично' : c === 'econt' ? 'Econt' : 'Speedy'}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-ff-muted">Ако събирачът има само един куриер, остави „Автоматично".</p>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-ff-border pt-3 text-[13px]">
          <span className="text-ff-muted">Общ наложен платеж</span>
          <span className="ff-fig font-bold text-ff-ink">{eur(suggestion.sumStotinki)}</span>
        </div>

        {error && <p className="mt-2 text-[12.5px] font-semibold text-ff-red">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-ff-border px-4 py-2 text-[13.5px] font-bold text-ff-ink-2 disabled:opacity-60"
          >
            Отказ
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !collector}
            className="rounded-xl bg-ff-green-700 px-4 py-2 text-[13.5px] font-bold text-white disabled:opacity-60"
          >
            {busy ? 'Обединявам…' : 'Обедини'}
          </button>
        </div>
      </div>
    </div>
  );
}
