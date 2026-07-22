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
import type { ConsolidatedProtocolOverrides, ConsolidatedProtocolView } from '@/lib/types';
import {
  buildOverridesSetFieldOverride,
  buildOverridesToggleExclude,
  type ConsolidatedOverrideField,
} from './consolidated-protocol-overrides';
import { META_FIELDS, META_LABELS, isMetaDirty, seedMetaForm, type MetaFormState } from './consolidated-protocol-meta';
import { SignaturePadField } from './signature-pad-field';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** Section А per-farmer editable cells → `overrides.fieldOverrides[f:<farmerId>]`. */
const FARMER_FIELDS: ReadonlyArray<readonly [ConsolidatedOverrideField, string]> = [
  ['batch', 'Партида'],
  ['eDoc', 'Е-док'],
  ['note', 'Бележка'],
] as const;

/**
 * Consolidated (day/leg) protocol editor — section А farmer list with
 * per-farmer Партида/Е-док/Бележка inputs (writes
 * `overrides.fieldOverrides[f:<farmerId>]`), section Б order list with an
 * "Изключи" checkbox per order (writes `overrides.excludedOrderIds`), and a
 * section В transport-meta form (vehicle/plate/driver/timing). All are
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

  // Local source-of-truth for `overrides` between reloads. Every overrides
  // PATCH must send the FULL object (the server's merge is shallow, so
  // `fieldOverrides` is replaced wholesale) — composing each mutation on this
  // ref instead of `view.overrides` keeps back-to-back blur-saves from
  // clobbering each other while the first save's reload is still in flight.
  const overridesRef = useRef<ConsolidatedProtocolOverrides>({});
  const pendingRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    try {
      const v = await getConsolidatedProtocol(id);
      // Resync the local overrides only when no PATCH is queued/in flight —
      // this fetch reflects a state older than what the queue composed.
      if (pendingRef.current === 0) overridesRef.current = v.overrides;
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

  /** Serialize every overrides PATCH through one promise chain, composing on
   *  `overridesRef` at EXECUTION time (not call time) so overlapping saves
   *  stack instead of the later one silently dropping the earlier edit. */
  async function patchOverrides(build: (current: ConsolidatedProtocolOverrides) => ConsolidatedProtocolOverrides) {
    pendingRef.current += 1;
    const run = queueRef.current.then(async () => {
      const next = build(overridesRef.current);
      // On PATCH failure the ref keeps the optimistic value on purpose: the
      // uncontrolled inputs still show the typed text, so the next successful
      // save re-sending it matches exactly what the operator sees.
      overridesRef.current = next;
      await updateConsolidatedProtocol(id, { overrides: next });
    });
    queueRef.current = run
      .catch(() => {}) // keep the chain alive after a failure
      .finally(() => {
        pendingRef.current -= 1;
      });
    await run;
  }

  async function toggleExclude(orderId: string, exclude: boolean) {
    setSaving(true);
    try {
      await patchOverrides((current) => buildOverridesToggleExclude(current, orderId, exclude));
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  /** Blur-save for one section-А cell. Like the В form, deliberately never
   *  disabled while a save is in flight — these inputs are tabbed through,
   *  and disabling the next input mid-save would kick the operator's focus
   *  out of it. Write ordering is guaranteed by patchOverrides' queue. */
  async function saveFieldOverride(key: string, field: ConsolidatedOverrideField, value: string) {
    try {
      await patchOverrides((current) => buildOverridesSetFieldOverride(current, key, field, value));
      await load();
    } catch (e) {
      toast.error(errMsg(e));
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
      // A blur-save fired by the click that landed on this button (mousedown
      // blurs the focused А input) may still be in flight — the freeze must
      // include it, so drain the overrides queue and flush the В form first.
      await queueRef.current;
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
          <h2 className="text-[14px] font-extrabold">А. Фермери</h2>
        </div>
        {view.rows.farmers.map((f) => {
          // Manual extra rows (farmerId `extra:<label>`) are not override
          // targets — decorateWithOverrides appends them AFTER fieldOverrides
          // apply, so an `f:extra:…` key would never land anywhere.
          const isExtra = f.farmerId.startsWith('extra:');
          return (
            <div key={f.farmerId} className="border-b border-ff-border-2 px-5 py-3 last:border-0">
              <div className="text-[13.5px] font-bold">{f.name}</div>
              {isDraft && !isExtra ? (
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {FARMER_FIELDS.map(([field, label]) => (
                    <label key={field} className="text-[12.5px] font-semibold text-ff-muted">
                      {label}
                      <input
                        className="mt-1 block w-full rounded-lg border border-ff-border px-2.5 py-1.5 text-[13.5px]"
                        defaultValue={f[field] ?? ''}
                        onBlur={(e) => {
                          // Unchanged value → skip the PATCH+reload (tabbing
                          // through the grid shouldn't spam the server).
                          if (e.target.value.trim() === (f[field] ?? '')) return;
                          void saveFieldOverride(`f:${f.farmerId}`, field, e.target.value);
                        }}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                (f.batch || f.eDoc || f.note) && (
                  <div className="mt-1 text-[12.5px] text-ff-muted">
                    {[
                      f.batch ? `Партида: ${f.batch}` : null,
                      f.eDoc ? `Е-док: ${f.eDoc}` : null,
                      f.note ? `Бележка: ${f.note}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )
              )}
            </div>
          );
        })}
      </section>

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
