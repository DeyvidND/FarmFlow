'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Star } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, getTenant, listProductOptions, updateTenant } from '@/lib/api-client';
import type { ProductOption } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/**
 * «Продукт на седмицата» panel rendered on the Products page.
 * Self-contained: loads and saves tenant settings directly.
 * The product can also be set with the star on a product card — both write the same tenant field.
 */
export function ProductOfWeekPanel() {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  const [productId, setProductId] = useState<string>('');
  const [note, setNote] = useState('');
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([getTenant(), listProductOptions().catch(() => [] as ProductOption[])])
      .then(([t, opts]) => {
        if (!alive) return;
        setEnabled(t.productOfWeekEnabled);
        setMode(t.productOfWeekMode ?? 'manual');
        setProductId(t.productOfWeekId ?? '');
        setNote(t.productOfWeekNote ?? '');
        setProducts(opts);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  async function onToggle(v: boolean) {
    setEnabled(v); // optimistic
    if (v) setOpen(true);
    try {
      await updateTenant({ productOfWeekEnabled: v });
      toast.success(v ? 'Продукт на седмицата — включен' : 'Продукт на седмицата — изключен');
    } catch (e) {
      setEnabled(!v); // rollback
      toast.error(errMsg(e));
    }
  }

  async function onSave() {
    setSaving(true);
    try {
      await updateTenant({
        productOfWeekMode: mode,
        productOfWeekId: mode === 'manual' ? productId || null : undefined,
        productOfWeekNote: note.trim() || null,
      });
      toast.success('Записано');
      setOpen(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ff-surface-2 text-ff-amber">
            <Star size={20} />
          </span>
          <div>
            <h2 className="text-[16px] font-extrabold">Продукт на седмицата</h2>
            <p className="mt-0.5 max-w-[440px] text-[13px] leading-snug text-ff-ink-2">
              Откроява един продукт на видно място в сайта. Избери го ръчно (със звездата на продукта)
              или остави системата да го сменя автоматично всяка седмица.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ToggleSwitch checked={enabled} disabled={!loaded} onChange={onToggle} />
          {enabled && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="rounded-lg border border-ff-border p-1.5 text-ff-ink-2 hover:bg-ff-surface-2"
              aria-label={open ? 'Скрий настройки' : 'Покажи настройки'}
            >
              {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
        </div>
      </div>

      {enabled && open && (
        <div className="mt-5 flex flex-col gap-4 border-t border-ff-border-2 pt-5">
          <div className="flex flex-wrap gap-2">
            {(['manual', 'auto'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-lg border px-3.5 py-2 text-[13px] font-bold transition-colors ${
                  mode === m
                    ? 'border-ff-green-700 bg-ff-green-50 text-ff-green-800'
                    : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2'
                }`}
              >
                {m === 'manual' ? 'Ръчен избор' : 'Автоматично (всяка седмица)'}
              </button>
            ))}
          </div>

          {mode === 'manual' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-bold text-ff-ink-2">Продукт</span>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className="rounded-lg border border-ff-border bg-ff-surface px-3 py-2.5 text-[14px] font-semibold"
              >
                <option value="">— Без избран —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ff-ink-2">Кратко описание (по избор)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder={'напр. „Сезонна ягода, набрана тази сутрин“'}
              className="resize-none rounded-lg border border-ff-border bg-ff-surface px-3 py-2.5 text-[14px]"
            />
          </label>

          <div>
            <Button variant="primary" onClick={onSave} disabled={saving} className="rounded-sm">
              {saving ? 'Зареждане…' : 'Запази'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
