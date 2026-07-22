'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, getConsolidatedProtocol, updateConsolidatedProtocol, consolidatedProtocolPdfHref } from '@/lib/api-client';
import type { ConsolidatedProtocolView } from '@/lib/types';
import { buildOverridesToggleExclude } from './consolidated-protocol-overrides';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const META_FIELDS = ['vehicle', 'plate', 'driverName', 'startPlace', 'startTime', 'plannedEnd'] as const;

/**
 * Consolidated (day/leg) protocol editor — section Б order list with an
 * "Изключи" checkbox per order (writes `overrides.excludedOrderIds`), and a
 * section В transport-meta form (vehicle/plate/driver/timing). Both are
 * disabled once the protocol is `status='signed'` (server also rejects a
 * PATCH at that point with a 409 — this is a courtesy, not the real gate).
 */
export function ConsolidatedProtocolEdit({ id }: { id: string }) {
  const [view, setView] = useState<ConsolidatedProtocolView | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await getConsolidatedProtocol(id));
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleExclude(orderId: string, exclude: boolean) {
    if (!view) return;
    setSaving(true);
    try {
      const overrides = buildOverridesToggleExclude(view.overrides, orderId, exclude);
      await updateConsolidatedProtocol(id, { overrides });
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveMeta(patch: Partial<ConsolidatedProtocolView['meta']>) {
    setSaving(true);
    try {
      await updateConsolidatedProtocol(id, { meta: patch });
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  if (!view) return <p className="py-8 text-center text-sm text-ff-muted">Зареждане…</p>;

  const isDraft = view.status === 'draft';
  const excluded = new Set(view.overrides.excludedOrderIds ?? []);

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[18px] font-extrabold">
          ОБ-{view.docNumber} · {view.status === 'signed' ? 'Подписан' : 'Чернова'}
        </h1>
        <a
          href={consolidatedProtocolPdfHref(id)}
          target="_blank"
          rel="noopener"
          className="text-[13.5px] font-bold text-ff-ink underline"
        >
          Свали PDF
        </a>
      </div>

      {!isDraft && (
        <p className="mb-4 rounded-lg bg-ff-surface-2 px-4 py-2.5 text-[13px] font-semibold text-ff-muted-2">
          Протоколът е подписан — вече не подлежи на редакция.
        </p>
      )}

      <section className="mb-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface">
        <div className="border-b border-ff-border-2 px-5 py-3">
          <h2 className="text-[14px] font-extrabold">Б. Поръчки</h2>
        </div>
        {view.rows.orders.map((o) => (
          <div
            key={o.orderId}
            className="flex items-center justify-between border-b border-ff-border-2 px-5 py-2.5 last:border-0"
          >
            <div className="text-[13.5px]">
              {o.orderNumber != null ? `№ ${o.orderNumber}` : '—'} · {o.customerCode} · {o.cityOrZone ?? '—'}
            </div>
            {isDraft && (
              <label className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                <input
                  type="checkbox"
                  checked={excluded.has(o.orderId)}
                  disabled={saving}
                  onChange={(e) => void toggleExclude(o.orderId, e.target.checked)}
                />
                Изключи
              </label>
            )}
          </div>
        ))}
      </section>

      <section className="mb-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface">
        <div className="border-b border-ff-border-2 px-5 py-3">
          <h2 className="text-[14px] font-extrabold">В. Транспорт</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 p-5">
          {META_FIELDS.map((field) => (
            <label key={field} className="text-[12.5px] font-semibold text-ff-muted">
              {field}
              <input
                className="mt-1 block w-full rounded-lg border border-ff-border px-2.5 py-1.5 text-[13.5px]"
                defaultValue={view.meta[field] ?? ''}
                disabled={!isDraft || saving}
                onBlur={(e) => void saveMeta({ [field]: e.target.value })}
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
