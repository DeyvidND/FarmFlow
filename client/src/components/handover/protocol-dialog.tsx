'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SignaturePadField } from './signature-pad-field';
import { moneyFromStotinki } from '@/lib/utils';
import { ApiError, createProtocol, getProtocolDraft, protocolPdfHref } from '@/lib/api-client';
import type { LegalIdentity, ProtocolDraft } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function PartyBlock({ label, identity }: { label: string; identity: LegalIdentity }) {
  return (
    <div className="rounded-xl border border-ff-border-2 px-3.5 py-3">
      <div className="mb-0.5 text-xs font-bold text-ff-muted">{label}</div>
      <div className="text-sm font-semibold text-ff-ink">{identity.name ?? '—'}</div>
      {identity.address && <div className="mt-px text-xs text-ff-muted">{identity.address}</div>}
    </div>
  );
}

/**
 * Sign-and-save dialog for a handover protocol («Протокол за клиента»/-за фермера).
 * Fetches the (unsaved) draft on mount, renders parties + items + total, captures
 * both signatures (or skips the customer's via «Получено без подпис»), then
 * creates the protocol and opens its PDF in a new tab.
 *
 * `orderId` targets an `operator_to_customer` protocol; `farmerId`+`slotId`
 * target a `farmer_to_operator` one (which farmer pickup at which delivery slot).
 */
export function ProtocolDialog({
  kind,
  orderId,
  farmerId,
  slotId,
  onClose,
}: {
  kind: string;
  orderId?: string;
  farmerId?: string;
  slotId?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ProtocolDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromSignaturePng, setFromSignaturePng] = useState<string | null>(null);
  const [toSignaturePng, setToSignaturePng] = useState<string | null>(null);
  const [noSignature, setNoSignature] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getProtocolDraft({ kind, orderId, farmerId, slotId })
      .then(setDraft)
      .catch((e) => setError(errMsg(e)));
  }, [kind, orderId, farmerId, slotId]);

  async function submit() {
    if (!draft) return;
    setSubmitting(true);
    try {
      const res = await createProtocol({
        kind,
        orderId,
        farmerId,
        slotId,
        items: draft.items,
        fromSignaturePng,
        toSignaturePng: noSignature ? null : toSignaturePng,
        meta: {},
      });
      window.open(protocolPdfHref(res.id), '_blank', 'noopener');
      toast.success('Протоколът е записан');
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-[560px] max-w-[94vw] overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="text-[16px] font-extrabold text-ff-ink">
            {kind === 'farmer_to_operator' ? 'Протокол за фермер' : 'Протокол за клиента'}
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {!draft && !error && <p className="py-8 text-center text-sm text-ff-muted">Зареждане…</p>}
          {error && (
            <div className="py-8 text-center">
              <p className="text-sm text-ff-muted">{error}</p>
            </div>
          )}
          {draft && (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3">
                <PartyBlock label="ПРЕДАВА" identity={draft.from} />
                <PartyBlock label="ПРИЕМА" identity={draft.to} />
              </div>

              <div className="mb-2 text-[13px] font-bold text-ff-muted">ПРОДУКТИ</div>
              <div className="mb-4 overflow-hidden rounded-xl border border-ff-border-2">
                {draft.items.map((it, i) => (
                  <div
                    key={i}
                    className={`flex items-center justify-between px-3.5 py-3 ${i < draft.items.length - 1 ? 'border-b border-ff-border-2' : ''}`}
                  >
                    <div className="min-w-0 pr-3">
                      <div className="truncate text-sm font-semibold">
                        {it.productName}
                        {it.variantLabel ? ` · ${it.variantLabel}` : ''}
                      </div>
                      <div className="mt-px text-xs text-ff-muted">
                        × {it.quantity}
                        {it.unit ? ` ${it.unit}` : ''} · {moneyFromStotinki(it.priceStotinki)}
                      </div>
                    </div>
                    <span className="ff-fig shrink-0 text-[13.5px] font-bold">
                      {moneyFromStotinki(it.priceStotinki * it.quantity)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mb-5 flex items-center justify-between border-t border-ff-border-2 px-1 pt-2.5">
                <span className="text-[15px] font-bold">Общо</span>
                <span className="ff-fig text-[20px] font-extrabold">{moneyFromStotinki(draft.total)}</span>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-3">
                <SignaturePadField value={fromSignaturePng} onChange={setFromSignaturePng} label="Предал" />
                {!noSignature && (
                  <SignaturePadField value={toSignaturePng} onChange={setToSignaturePng} label="Приел" />
                )}
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ff-ink-2">
                <input
                  type="checkbox"
                  checked={noSignature}
                  onChange={(e) => {
                    setNoSignature(e.target.checked);
                    if (e.target.checked) setToSignaturePng(null);
                  }}
                  className="h-4 w-4 accent-ff-green-700"
                />
                Получено без подпис
              </label>
            </>
          )}
        </div>

        <div className="border-t border-ff-border px-5 py-4">
          <Button variant="primary" disabled={!draft || submitting} onClick={submit} className="w-full rounded-sm">
            {submitting ? 'Записване…' : 'Запиши и отвори PDF'}
          </Button>
        </div>
      </div>
    </div>
  );
}
