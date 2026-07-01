'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, PackageCheck, PackageX, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, listProductOptions, updateCourierBatch } from '@/lib/api-client';
import type { Farmer, ProductOption } from '@/lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  farmers?: Farmer[];
  multiFarmer?: boolean;
  onSaved?: (patches: { id: string; courierDisabled: boolean }[]) => void;
}

export function CourierSettingsModal({ open, onClose, farmers = [], multiFarmer = false, onSaved }: Props) {
  const [prods, setProds] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // state stores courierENABLED (= !courierDisabled): true = с куриер, false = само на място
  const [state, setState] = useState<Map<string, boolean>>(new Map());
  const originalRef = useRef<Map<string, boolean>>(new Map());
  const [farmerFilter, setFarmerFilter] = useState<string>('all');

  const farmerName = useMemo(() => new Map(farmers.map((f) => [f.id, f.name])), [farmers]);
  const farmerCourier = useMemo(() => new Map(farmers.map((f) => [f.id, f.courierEnabled ?? false])), [farmers]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setState(new Map());
    setFarmerFilter('all');
    originalRef.current = new Map();
    listProductOptions()
      .then((ps) => {
        setProds(ps);
        // invert: enabled = NOT disabled
        const m = new Map(ps.map((p) => [p.id, !p.courierDisabled]));
        originalRef.current = new Map(m);
        setState(m);
      })
      .catch(() => toast.error('Грешка при зареждане'))
      .finally(() => setLoading(false));
  }, [open]);

  const toggle = (id: string) =>
    setState((prev) => {
      const next = new Map(prev);
      next.set(id, !next.get(id));
      return next;
    });

  async function save() {
    // compare courierDisabled (inverted back)
    const updates = prods
      .filter((p) => state.get(p.id) !== originalRef.current.get(p.id))
      .map((p) => ({ id: p.id, courierDisabled: !state.get(p.id) }));
    if (!updates.length) { onClose(); return; }
    setSaving(true);
    try {
      await updateCourierBatch(updates);
      toast.success(`Запазено (${updates.length} ${updates.length === 1 ? 'продукт' : 'продукта'})`);
      onSaved?.(updates);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка при запис');
    } finally {
      setSaving(false);
    }
  }

  const displayed = useMemo(
    () => (farmerFilter === 'all' ? prods : prods.filter((p) => p.farmerId === farmerFilter)),
    [prods, farmerFilter],
  );

  // Farmers that actually have products
  const activeFarmers = useMemo(() => {
    const ids = new Set(prods.map((p) => p.farmerId).filter(Boolean));
    return farmers.filter((f) => ids.has(f.id));
  }, [prods, farmers]);

  const changedCount = prods.filter((p) => state.get(p.id) !== originalRef.current.get(p.id)).length;
  const blockedCount = prods.filter((p) => state.get(p.id) === false).length;
  const enabledCount = prods.length - blockedCount;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-ff-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-ff-border px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-green-100 text-green-700">
            <PackageCheck size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ff-ink">Настройки за куриер</h2>
            <p className="text-xs text-ff-muted">
              {enabledCount} с куриер · {blockedCount} без куриер
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded p-1 text-ff-muted transition-colors hover:bg-ff-surface-2 hover:text-ff-ink"
          >
            <X size={16} />
          </button>
        </div>

        {/* Explanation */}
        <div className="shrink-0 border-b border-ff-border bg-ff-surface-2 px-5 py-3">
          <p className="text-xs text-ff-muted leading-relaxed">
            <span className="inline-flex items-center gap-1 font-semibold text-green-700">● Зелено</span> — изпраща се с куриер (Еконт / Спиди).{' '}
            <span className="inline-flex items-center gap-1 font-semibold text-ff-ink-2">● Сиво</span> — без куриер, но се продава нормално при лична доставка, вземане от място и местна доставка до адрес.
          </p>
        </div>

        {/* Farmer filter */}
        {multiFarmer && activeFarmers.length > 1 && (
          <div className="shrink-0 border-b border-ff-border px-5 py-2.5">
            <select
              value={farmerFilter}
              onChange={(e) => setFarmerFilter(e.target.value)}
              className="w-full rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-medium text-ff-ink focus:outline-none"
            >
              <option value="all">Всички фермери</option>
              {activeFarmers.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Product list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-ff-muted">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : displayed.length === 0 ? (
            <p className="py-10 text-center text-sm text-ff-muted">Няма продукти</p>
          ) : (
            <ul className="divide-y divide-ff-border">
              {displayed.map((p) => {
                const enabled = state.get(p.id) ?? true;
                const changed = state.get(p.id) !== originalRef.current.get(p.id);
                return (
                  <li
                    key={p.id}
                    className={`flex items-center gap-3 px-5 py-3 transition-colors ${
                      changed ? 'bg-blue-50/60' : ''
                    }`}
                  >
                    {/* Status icon */}
                    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${
                      enabled
                        ? 'bg-green-100 text-green-700'
                        : 'bg-amber-100 text-amber-600'
                    }`}>
                      {enabled ? <PackageCheck size={14} /> : <PackageX size={14} />}
                    </span>

                    {/* Name + farmer */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ff-ink">{p.name}</p>
                      {multiFarmer && p.farmerId && (
                        <p className="truncate text-xs text-ff-muted">{farmerName.get(p.farmerId) ?? '—'}</p>
                      )}
                      {!enabled && (
                        <p className="text-[11px] text-ff-muted font-medium mt-0.5">Без куриер · лична / местна доставка</p>
                      )}
                      {p.farmerId && !farmerCourier.get(p.farmerId) && (
                        <p className="text-[10.5px] text-amber-600 mt-0.5">⚠ Фермерът няма активен куриер</p>
                      )}
                    </div>

                    {/* Changed badge */}
                    {changed && (
                      <span className="shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                        промяна
                      </span>
                    )}

                    {/* Toggle — ON = с куриер (green), OFF = без куриер (gray) */}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      onClick={() => toggle(p.id)}
                      title={enabled ? 'С куриер — кликни за блокиране' : 'Само на място — кликни за включване с куриер'}
                      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${
                        enabled ? 'bg-green-500' : 'bg-ff-border-2'
                      }`}
                    >
                      <span
                        className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all ${
                          enabled ? 'left-[19px]' : 'left-[3px]'
                        }`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-ff-border px-5 py-3">
          <span className="text-xs text-ff-muted">
            {changedCount > 0
              ? <span className="font-semibold text-blue-700">{changedCount} несъхранени промени</span>
              : 'Без промени'}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Отказ
            </Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving || loading}>
              {saving && <Loader2 size={14} className="mr-1 animate-spin" />}
              Запази
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
