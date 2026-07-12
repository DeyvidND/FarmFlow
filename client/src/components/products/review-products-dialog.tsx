'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, approveProduct, listPendingProducts } from '@/lib/api-client';
import { moneyFromStotinki } from '@/lib/utils';
import type { Farmer, Product } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

interface ReviewProductsDialogProps {
  open: boolean;
  onClose: () => void;
  farmers: Farmer[];
  /** Called after a successful approve so the parent can patch its local list + badge. */
  onApproved: (p: Product) => void;
  /** Opens the parent's full product editor; the queue dialog closes so the admin
   *  isn't stacking two modals — they reopen the queue afterwards to approve. */
  onEdit: (p: Product) => void;
}

/** Farmer-submitted products awaiting admin approval before they show in the
 *  storefront. Drains every page of the (small) pending queue up front — no
 *  pagination UI — then lets the admin approve or send each one to full edit. */
export function ReviewProductsDialog({ open, onClose, farmers, onApproved, onEdit }: ReviewProductsDialogProps) {
  const [rows, setRows] = useState<Product[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  // The dialog instance may stay mounted while `open` toggles (mirrors
  // ai-import-dialog.tsx); an in-flight drain/approve from a closed session must
  // not poison state after the dialog is reopened. Bumped on every close.
  const sessionRef = useRef(0);

  const farmerName = useMemo(() => new Map(farmers.map((f) => [f.id, f.name])), [farmers]);

  useEffect(() => {
    if (!open) return;
    const session = ++sessionRef.current;
    setRows(null);
    setLoadErr(null);
    setRowErr({});
    (async () => {
      try {
        const all: Product[] = [];
        let cursor: string | undefined;
        do {
          const page = await listPendingProducts(cursor);
          if (session !== sessionRef.current) return; // dialog closed/reopened meanwhile
          all.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (session !== sessionRef.current) return;
        setRows(all);
      } catch (e) {
        if (session !== sessionRef.current) return;
        setLoadErr(errMsg(e));
        setRows([]);
      }
    })();
  }, [open]);

  function close() {
    sessionRef.current++; // invalidate any drain/approve still in flight
    onClose();
  }

  if (!open) return null;

  async function onApprove(p: Product) {
    const session = sessionRef.current;
    setBusyId(p.id);
    setRowErr((prev) => {
      if (!(p.id in prev)) return prev;
      const next = { ...prev };
      delete next[p.id];
      return next;
    });
    try {
      const updated = await approveProduct(p.id);
      if (session !== sessionRef.current) return;
      setRows((prev) => (prev ? prev.filter((row) => row.id !== p.id) : prev));
      onApproved(updated);
    } catch (e) {
      if (session !== sessionRef.current) return;
      setRowErr((prev) => ({ ...prev, [p.id]: errMsg(e) }));
    } finally {
      if (session === sessionRef.current) setBusyId(null);
    }
  }

  function onEditClick(p: Product) {
    onEdit(p);
    close();
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={close}>
      <div
        className="animate-ff-pop max-h-[92vh] w-[560px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">Продукти за проверка</h2>
          <button
            onClick={close}
            aria-label="Затвори"
            className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2"
          >
            <X size={18} />
          </button>
        </div>

        {rows === null ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-ff-ink-2">
            <Loader2 className="h-7 w-7 animate-spin" />
            <span className="text-[14px] font-semibold">Зареждане…</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-8">
            <p className="text-[14px] font-semibold text-ff-muted">
              {loadErr ? <span className="text-ff-red">{loadErr}</span> : 'Няма продукти за проверка.'}
            </p>
            <Button variant="ghost" type="button" className="rounded-sm" onClick={close}>
              Затвори
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((p) => (
              <div key={p.id} className="flex flex-col gap-2 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[14.5px] font-bold">{p.name}</div>
                    <div className="text-[12px] text-ff-muted">
                      {[p.farmerId ? farmerName.get(p.farmerId) ?? null : null, p.unit].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <span className="ff-fig shrink-0 text-[15px] font-extrabold">{moneyFromStotinki(p.priceStotinki)}</span>
                </div>

                {rowErr[p.id] && <p className="text-[12.5px] font-semibold text-ff-red">{rowErr[p.id]}</p>}

                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    type="button"
                    className="flex-1 rounded-sm"
                    disabled={busyId === p.id}
                    onClick={() => void onApprove(p)}
                  >
                    {busyId === p.id ? 'Одобряване…' : 'Одобри'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className="flex-1 rounded-sm"
                    disabled={busyId === p.id}
                    onClick={() => onEditClick(p)}
                  >
                    Редактирай
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
