'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { HandCoins, Users, Sprout, ChevronRight, FlaskConical, RefreshCw } from 'lucide-react';
import { cn, eur } from '@/lib/utils';
import {
  ApiError,
  listBrandCharges,
  getBrandCommission,
  generateBrandCharges,
  updateBrandCharge,
  type MarketplaceBrand,
  type CommissionSummary,
  type VendorCharge,
  type VendorChargeStatus,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const currentPeriod = () => new Date().toISOString().slice(0, 7);

const CHARGE_LABEL: Record<VendorChargeStatus, string> = {
  due: 'Дължима',
  paid: 'Платена',
  waived: 'Опростена',
};
const CHARGE_TONE: Record<VendorChargeStatus, string> = {
  due: 'bg-ff-amber-soft text-ff-amber-600',
  paid: 'bg-ff-green-50 text-ff-green-700',
  waived: 'bg-ff-surface-2 text-ff-muted',
};

function BrandCard({
  b,
  active,
  onSelect,
}: {
  b: MarketplaceBrand;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors',
        active
          ? 'border-ff-green-500 bg-ff-green-50'
          : 'border-ff-border bg-ff-surface shadow-ff-sm hover:border-ff-green-500 hover:bg-ff-surface-2',
      )}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-ff-green-700 text-ff-green-on">
        <Users size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[15px] font-extrabold text-ff-ink">{b.name}</span>
          {b.isDemo && (
            <span className="inline-flex items-center gap-1 rounded-full bg-ff-demo-soft px-2 py-0.5 text-[11px] font-bold text-ff-demo">
              <FlaskConical size={10} /> ДЕМО
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[12.5px] text-ff-muted">
          /{b.slug} · {b.farmerCount} произв. ·{' '}
          {b.commissionEnabled ? `комисиона ${pct(b.defaultRateBps)}` : 'комисиона изкл.'}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="ff-fig block text-[15px] font-extrabold text-ff-ink">{eur(b.totalCommissionStotinki)}</span>
        <span className="block text-[11.5px] text-ff-muted">комисиона</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-ff-muted-2" />
    </button>
  );
}

function CommissionTable({ summary }: { summary: CommissionSummary }) {
  return (
    <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <div className="flex items-center gap-2 border-b border-ff-border bg-ff-surface-2 px-4 py-3">
        <Sprout size={15} className="text-ff-green-700" />
        <h3 className="text-[13px] font-extrabold uppercase tracking-[0.04em] text-ff-ink-2">Комисиона по производители</h3>
        <span
          className={cn(
            'ml-auto rounded-full px-2.5 py-0.5 text-[12px] font-bold',
            summary.commissionEnabled ? 'bg-ff-green-50 text-ff-green-700' : 'bg-ff-surface text-ff-muted',
          )}
        >
          {summary.commissionEnabled ? `включена · ${pct(summary.defaultRateBps)}` : 'изключена'}
        </span>
      </div>
      {summary.farmers.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13.5px] text-ff-muted">Още няма записани продажби по производители.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ff-border text-left">
                {['Производител', 'Поръчки', 'Оборот', 'Комисиона'].map((h, i) => (
                  <th
                    key={h}
                    className={cn(
                      'px-4 py-2.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-ink-2',
                      i > 0 && 'text-right',
                    )}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.farmers.map((f) => (
                <tr key={f.farmerId} className="border-b border-ff-border-2 last:border-0">
                  <td className="px-4 py-2.5 text-[13.5px] font-semibold text-ff-ink">{f.farmerName ?? '—'}</td>
                  <td className="ff-fig px-4 py-2.5 text-right text-[13.5px] text-ff-ink-2">{f.orderCount}</td>
                  <td className="ff-fig px-4 py-2.5 text-right text-[13.5px] text-ff-ink-2">{eur(f.grossStotinki)}</td>
                  <td className="ff-fig px-4 py-2.5 text-right text-[13.5px] font-bold text-ff-ink">{eur(f.commissionStotinki)}</td>
                </tr>
              ))}
              <tr className="bg-ff-surface-2 font-bold">
                <td className="px-4 py-2.5 text-[13.5px] text-ff-ink">Общо</td>
                <td />
                <td className="ff-fig px-4 py-2.5 text-right text-[13.5px] text-ff-ink">{eur(summary.totalGrossStotinki)}</td>
                <td className="ff-fig px-4 py-2.5 text-right text-[14px] text-ff-green-800">{eur(summary.totalCommissionStotinki)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MarketplaceFinanceClient({ initialBrands }: { initialBrands: MarketplaceBrand[] }) {
  const [brands] = useState(initialBrands);
  const [selectedId, setSelectedId] = useState<string | null>(initialBrands[0]?.id ?? null);
  const [summary, setSummary] = useState<CommissionSummary | null>(null);
  const [charges, setCharges] = useState<VendorCharge[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState(currentPeriod());
  const [busy, setBusy] = useState(false);

  const selected = brands.find((b) => b.id === selectedId) ?? null;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([getBrandCommission(id), listBrandCharges(id)]);
      setSummary(s);
      setCharges(c);
    } catch (e) {
      toast.error(errMsg(e));
      setSummary(null);
      setCharges([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void load(selectedId);
  }, [selectedId, load]);

  async function onGenerate() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const r = await generateBrandCharges(selectedId, period);
      toast.success(`Създадени ${r.created} такси (${r.skipped} пропуснати).`);
      setCharges(await listBrandCharges(selectedId));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onMark(chargeId: string, status: VendorChargeStatus) {
    if (!selectedId) return;
    setBusy(true);
    try {
      await updateBrandCharge(selectedId, chargeId, { status });
      setCharges(await listBrandCharges(selectedId));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-ff-fade-up flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Финанси на пазара</h1>
        <p className="mt-0.5 text-[13.5px] text-ff-muted">
          Комисиона по производители и месечни такси на всеки бранд. Тук само се води кой колко дължи — парите се събират извън системата.
        </p>
      </div>

      {brands.length === 0 ? (
        <div className="rounded-xl border border-ff-border bg-ff-surface p-10 text-center shadow-ff-sm">
          <HandCoins size={28} className="mx-auto text-ff-muted-2" />
          <p className="mt-2 text-[14px] font-semibold text-ff-ink-2">Няма пазарни брандове.</p>
          <p className="mt-0.5 text-[13px] text-ff-muted">
            Марткетплейс финансите се появяват, щом има бранд с няколко производители.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(280px,340px)_1fr]">
          {/* Brand list */}
          <div className="flex flex-col gap-2.5">
            {brands.map((b) => (
              <BrandCard key={b.id} b={b} active={b.id === selectedId} onSelect={() => setSelectedId(b.id)} />
            ))}
          </div>

          {/* Selected brand detail */}
          <div className="flex min-w-0 flex-col gap-5">
            {loading ? (
              <div className="rounded-xl border border-ff-border bg-ff-surface p-10 text-center text-[13.5px] text-ff-muted shadow-ff-sm">
                Зареждане…
              </div>
            ) : selected && summary ? (
              <>
                <CommissionTable summary={summary} />

                <section className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
                  <div className="flex flex-wrap items-center gap-3 border-b border-ff-border bg-ff-surface-2 px-4 py-3">
                    <h3 className="text-[13px] font-extrabold uppercase tracking-[0.04em] text-ff-ink-2">Месечни такси</h3>
                    <div className="ml-auto flex items-center gap-2">
                      <input
                        value={period}
                        onChange={(e) => setPeriod(e.target.value)}
                        placeholder="2026-07"
                        aria-label="Период (YYYY-MM)"
                        className="h-9 w-28 rounded-lg border border-ff-border bg-ff-surface px-2.5 font-mono text-[13px] outline-none focus:border-ff-green-500"
                      />
                      <button
                        type="button"
                        onClick={onGenerate}
                        disabled={busy}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ff-green-700 px-3 text-[13px] font-bold text-white hover:brightness-95 disabled:opacity-60"
                      >
                        <RefreshCw size={14} /> Генерирай месеца
                      </button>
                    </div>
                  </div>
                  {charges.length === 0 ? (
                    <p className="px-4 py-8 text-center text-[13.5px] text-ff-muted">
                      Няма генерирани такси. Изисква включено абонаментно таксуване за бранда.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr className="border-b border-ff-border text-left">
                            {['Производител', 'Месец', 'Такса', 'Статус', ''].map((h, i) => (
                              <th
                                key={h || 'act'}
                                className={cn(
                                  'px-4 py-2.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-ink-2',
                                  i === 2 && 'text-right',
                                )}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {charges.map((c) => (
                            <tr key={c.id} className="border-b border-ff-border-2 last:border-0">
                              <td className="px-4 py-2.5 text-[13.5px] font-semibold text-ff-ink">{c.farmerName ?? '—'}</td>
                              <td className="ff-fig px-4 py-2.5 text-[13px] text-ff-ink-2">{c.period}</td>
                              <td className="ff-fig px-4 py-2.5 text-right text-[13.5px] font-bold text-ff-ink">{eur(c.feeStotinki)}</td>
                              <td className="px-4 py-2.5">
                                <span className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-bold', CHARGE_TONE[c.status])}>
                                  {CHARGE_LABEL[c.status]}
                                </span>
                              </td>
                              <td className="px-4 py-2.5">
                                <div className="flex justify-end gap-1.5">
                                  {c.status !== 'paid' && (
                                    <button
                                      type="button"
                                      onClick={() => onMark(c.id, 'paid')}
                                      disabled={busy}
                                      className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1 text-[12px] font-bold text-ff-ink-2 hover:bg-ff-surface-2 disabled:opacity-60"
                                    >
                                      Платена
                                    </button>
                                  )}
                                  {c.status === 'due' && (
                                    <button
                                      type="button"
                                      onClick={() => onMark(c.id, 'waived')}
                                      disabled={busy}
                                      className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1 text-[12px] font-bold text-ff-ink-2 hover:bg-ff-surface-2 disabled:opacity-60"
                                    >
                                      Опрости
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </>
            ) : (
              <div className="rounded-xl border border-ff-border bg-ff-surface p-10 text-center text-[13.5px] text-ff-muted shadow-ff-sm">
                Избери бранд отляво.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
