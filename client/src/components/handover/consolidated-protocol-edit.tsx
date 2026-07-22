'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  getConsolidatedProtocol,
  updateConsolidatedProtocol,
  consolidatedProtocolPdfHref,
  signConsolidatedProtocol,
} from '@/lib/api-client';
import type { ConsolidatedProtocolView } from '@/lib/types';
import { buildOverridesToggleExclude } from './consolidated-protocol-overrides';
import { META_FIELDS, META_LABELS, isMetaDirty, seedMetaForm, type MetaFormState } from './consolidated-protocol-meta';
import { SignaturePadField } from './signature-pad-field';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/**
 * Consolidated (day/leg) protocol editor — section Б order list with an
 * "Изключи" checkbox per order (writes `overrides.excludedOrderIds`), and a
 * section В transport-meta form (vehicle/plate/driver/timing). Both are
 * disabled once the protocol is `status='signed'` (server also rejects a
 * PATCH at that point with a 409 — this is a courtesy, not the real gate).
 *
 * The В form is CONTROLLED and saves the WHOLE form in one PATCH. The old
 * per-field blur-save disabled every input while a save was in flight, which
 * kicked the focus out of the field being typed in and fired a cascade of
 * premature blurs — the resulting concurrent single-field PATCHes raced each
 * other and an operator's filled form survived as just its last field (prod
 * audit_logs showed PATCH pairs 4ms apart). A full-form PATCH also self-heals
 * any previously lost field, and sign() flushes the form first so
 * „попълни → Подпиши" without a final blur can never freeze the PDF without
 * the data.
 */
export function ConsolidatedProtocolEdit({ id }: { id: string }) {
  const [view, setView] = useState<ConsolidatedProtocolView | null>(null);
  const [saving, setSaving] = useState(false);
  const [receiverSig, setReceiverSig] = useState<string | null>(null);
  const [metaForm, setMetaForm] = useState<MetaFormState | null>(null);
  // What the server last acked — flushMeta() is a no-op while the form matches it.
  const lastSavedMeta = useRef<MetaFormState | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await getConsolidatedProtocol(id);
      setView(v);
      // Seed the form from the FIRST load only — a reload after a save must
      // never clobber what the operator is still typing.
      setMetaForm((current) => {
        if (current !== null) return current;
        const seeded = seedMetaForm(v.meta);
        lastSavedMeta.current = seeded;
        return seeded;
      });
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

  /** Sends the WHOLE form in one PATCH when it differs from the last ack.
   *  Throws on failure so sign() can abort instead of freezing without data. */
  async function flushMeta(form: MetaFormState): Promise<void> {
    if (!isMetaDirty(form, lastSavedMeta.current)) return;
    await updateConsolidatedProtocol(id, { meta: form });
    lastSavedMeta.current = form;
  }

  async function saveMetaOnBlur() {
    if (!metaForm || view?.status !== 'draft') return;
    try {
      await flushMeta(metaForm);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function sign() {
    setSaving(true);
    try {
      if (metaForm && view?.status === 'draft') await flushMeta(metaForm);
      await signConsolidatedProtocol(id, receiverSig);
      toast.success('Протоколът е подписан');
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  if (!view || !metaForm) return <p className="py-8 text-center text-sm text-ff-muted">Зареждане…</p>;

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
              {META_LABELS[field]}
              <input
                className="mt-1 block w-full rounded-lg border border-ff-border px-2.5 py-1.5 text-[13.5px]"
                value={metaForm[field]}
                // NB: deliberately NOT disabled while a save is in flight —
                // disabling a focused input kicks the focus out and fires the
                // premature-blur cascade this rework exists to kill.
                disabled={!isDraft}
                onChange={(e) => setMetaForm({ ...metaForm, [field]: e.target.value })}
                onBlur={() => void saveMetaOnBlur()}
              />
            </label>
          ))}
        </div>

        {isDraft && (
          <div className="border-t border-ff-border-2 px-5 py-4">
            <SignaturePadField value={receiverSig} onChange={setReceiverSig} label="Приел за транспорт" commit="live" />
            <Button variant="primary" className="mt-3 w-full" disabled={saving} onClick={() => void sign()}>
              {saving ? 'Подписване…' : 'Подпиши и замрази'}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
