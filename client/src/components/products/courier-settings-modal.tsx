'use client';

import { useEffect, useRef, useState } from 'react';
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
  const [state, setState] = useState<Map<string, boolean>>(new Map());
  const originalRef = useRef<Map<string, boolean>>(new Map());

  const farmerName = new Map(farmers.map((f) => [f.id, f.name]));

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setState(new Map());
    originalRef.current = new Map();
    listProductOptions()
      .then((ps) => {
        setProds(ps);
        const m = new Map(ps.map((p) => [p.id, p.courierDisabled]));
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
    const updates = prods
      .filter((p) => state.get(p.id) !== originalRef.current.get(p.id))
      .map((p) => ({ id: p.id, courierDisabled: state.get(p.id)! }));
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

  if (!open) return null;

  const blockedCount = Array.from(state.values()).filter(Boolean).length;
  const changedCount = prods.filter((p) => state.get(p.id) !== originalRef.current.get(p.id)).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-ff-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-ff-border px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700">
            <PackageX size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ff-ink">Настройки за куриер</h2>
            <p className="text-xs text-ff-muted">Включи/изключи куриерска доставка за всеки продукт</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded p-1 text-ff-muted transition-colors hover:bg-ff-surface-2 hover:text-ff-ink"
          >
            <X size={16} />
          </button>
        </div>

        {/* Legend */}
        <div className="flex shrink-0 items-center gap-4 border-b border-ff-border bg-ff-surface-2 px-5 py-2 text-[11px] text-ff-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-ff-border-2" />
            С куриер (зелено)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-amber-500" />
            Само на място
          </span>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-ff-muted">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : prods.length === 0 ? (
            <p className="py-10 text-center text-sm text-ff-muted">Няма продукти</p>
          ) : (
            <ul className="divide-y divide-ff-border">
              {prods.map((p) => {
                const off = state.get(p.id) ?? false;
                const changed = state.get(p.id) !== originalRef.current.get(p.id);
                return (
                  <li
                    key={p.id}
                    className={`flex items-center gap-3 px-5 py-3 transition-colors ${
                      changed ? 'bg-ff-surface-2' : ''
                    }`}
                  >
                    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${
                      off ? 'bg-amber-100 text-amber-600' : 'bg-ff-surface-2 text-ff-muted'
                    }`}>
                      {off ? <PackageX size={14} /> : <PackageCheck size={14} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ff-ink">{p.name}</p>
                      {multiFarmer && p.farmerId && (
                        <p className="truncate text-xs text-ff-muted">{farmerName.get(p.farmerId) ?? '—'}</p>
                      )}
                    </div>
                    {changed && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                        променено
                      </span>
                    )}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={off}
                      onClick={() => toggle(p.id)}
                      title={off ? 'Само на място — кликни за куриер' : 'С куриер — кликни за блокиране'}
                      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${
                        off ? 'bg-amber-500' : 'bg-ff-border-2'
                      }`}
                    >
                      <span
                        className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all ${
                          off ? 'left-[19px]' : 'left-[3px]'
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
            {blockedCount > 0
              ? `${blockedCount} без куриер`
              : 'Всички с куриер'}
            {changedCount > 0 && (
              <span className="ml-2 font-semibold text-amber-700">· {changedCount} промени</span>
            )}
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
