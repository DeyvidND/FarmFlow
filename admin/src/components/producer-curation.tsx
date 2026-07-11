'use client';

import { useState } from 'react';
import { Star, Crown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { setProductFeatured, setFarmerTier, setFarmerOfWeek, type FarmerDetail } from '@/lib/api-client';

const TIERS: { value: number; label: string }[] = [
  { value: 1, label: 'Базов' },
  { value: 2, label: 'Бранд идентичност' },
  { value: 3, label: 'Собствен сайт' },
];

export function ProducerCuration({ farmer: f }: { farmer: FarmerDetail }) {
  const [tier, setTier] = useState(f.tier);
  const [fow, setFow] = useState(f.isFarmerOfWeek);
  const [feat, setFeat] = useState<Record<string, boolean>>(
    Object.fromEntries(f.products.map((p) => [p.id, p.featured])),
  );
  const [busy, setBusy] = useState<string | null>(null);

  const onTier = async (v: number) => {
    const prev = tier;
    setTier(v);
    setBusy('tier');
    try {
      await setFarmerTier(f.id, v);
    } catch {
      setTier(prev);
    } finally {
      setBusy(null);
    }
  };

  const onFow = async () => {
    const next = !fow;
    setFow(next);
    setBusy('fow');
    try {
      await setFarmerOfWeek(f.id, next);
    } catch {
      setFow(!next);
    } finally {
      setBusy(null);
    }
  };

  const onFeat = async (id: string) => {
    const next = !feat[id];
    setFeat((s) => ({ ...s, [id]: next }));
    setBusy(id);
    try {
      await setProductFeatured(id, next);
    } catch {
      setFeat((s) => ({ ...s, [id]: !next }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <h2 className="text-[15px] font-extrabold">Маркетплейс</h2>

      {/* tier + фермер на седмицата */}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-ff-muted">Тиър</span>
          <div className="inline-flex rounded-lg border border-ff-border bg-ff-surface-2 p-0.5">
            {TIERS.map((t) => (
              <button
                key={t.value}
                type="button"
                disabled={busy === 'tier'}
                onClick={() => onTier(t.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[12.5px] font-bold transition-colors disabled:opacity-60',
                  tier === t.value ? 'bg-ff-green-700 text-white' : 'text-ff-ink-2 hover:bg-ff-surface',
                )}
              >
                {t.value} · {t.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          disabled={busy === 'fow'}
          onClick={onFow}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-bold transition-colors disabled:opacity-60',
            fow
              ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700'
              : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
          )}
        >
          <Crown size={15} /> {fow ? 'Фермер на седмицата ✓' : 'Направи фермер на седмицата'}
        </button>
      </div>

      {/* хит products */}
      <div className="mt-5">
        <div className="mb-2 text-[13px] font-bold text-ff-muted">Продукти · маркирай „Хит&quot;</div>
        {f.products.length === 0 ? (
          <p className="text-[13px] text-ff-muted-2">Няма продукти.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
            {f.products.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy === p.id}
                onClick={() => onFeat(p.id)}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] font-semibold transition-colors disabled:opacity-60',
                  feat[p.id]
                    ? 'border-ff-amber-600 bg-ff-amber-soft text-ff-amber-600'
                    : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Star size={14} className={feat[p.id] ? 'fill-current' : ''} />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
