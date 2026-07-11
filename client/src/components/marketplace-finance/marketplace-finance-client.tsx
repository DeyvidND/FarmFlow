'use client';

import { useState } from 'react';
import {
  type CommissionSummary,
  type VendorCharge,
  generateVendorCharges,
  listVendorCharges,
  updateVendorCharge,
} from '@/lib/api-client';

const euro = (stotinki: number) => `${(stotinki / 100).toFixed(2)} €`;
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const currentPeriod = () => new Date().toISOString().slice(0, 7);

const CHARGE_LABEL: Record<VendorCharge['status'], string> = {
  due: 'Дължима', paid: 'Платена', waived: 'Опростена',
};

export function MarketplaceFinanceClient({
  initialSummary, initialCharges,
}: {
  initialSummary: CommissionSummary; initialCharges: VendorCharge[];
}) {
  const [summary] = useState(initialSummary);
  const [charges, setCharges] = useState(initialCharges);
  const [period, setPeriod] = useState(currentPeriod());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() { setCharges(await listVendorCharges()); }

  async function onGenerate() {
    setBusy(true); setMsg(null);
    try {
      const r = await generateVendorCharges(period);
      setMsg(`Създадени ${r.created} такси (${r.skipped} пропуснати).`);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Грешка при генериране.');
    } finally { setBusy(false); }
  }

  async function onMark(id: string, status: VendorCharge['status']) {
    setBusy(true);
    try { await updateVendorCharge(id, { status }); await refresh(); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-xl font-semibold">Финанси на пазара</h1>
        <p className="text-sm text-muted-foreground">
          Комисиона по производители и месечни такси. Ти събираш парите — тук само се води кой колко дължи.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-medium">Комисиона</h2>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {summary.commissionEnabled ? `включена · ${pct(summary.defaultRateBps)}` : 'изключена'}
          </span>
        </div>
        {summary.farmers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Още няма записани продажби по производители.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2">Производител</th>
                <th className="py-2 text-right">Поръчки</th>
                <th className="py-2 text-right">Оборот</th>
                <th className="py-2 text-right">Комисиона</th>
              </tr>
            </thead>
            <tbody>
              {summary.farmers.map((f) => (
                <tr key={f.farmerId} className="border-b last:border-0">
                  <td className="py-2">{f.farmerName ?? '—'}</td>
                  <td className="py-2 text-right">{f.orderCount}</td>
                  <td className="py-2 text-right">{euro(f.grossStotinki)}</td>
                  <td className="py-2 text-right">{euro(f.commissionStotinki)}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-2">Общо</td>
                <td />
                <td className="py-2 text-right">{euro(summary.totalGrossStotinki)}</td>
                <td className="py-2 text-right">{euro(summary.totalCommissionStotinki)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Месечни такси</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2026-07"
            className="h-9 w-28 rounded-md border px-2 text-sm"
            aria-label="Период (YYYY-MM)"
          />
          <button
            onClick={onGenerate}
            disabled={busy}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            Генерирай месеца
          </button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </div>
        {charges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Няма генерирани такси. Генерирането изисква включено абонаментно таксуване в настройките.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2">Производител</th>
                <th className="py-2">Месец</th>
                <th className="py-2 text-right">Такса</th>
                <th className="py-2">Статус</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="py-2">{c.farmerName ?? '—'}</td>
                  <td className="py-2">{c.period}</td>
                  <td className="py-2 text-right">{euro(c.feeStotinki)}</td>
                  <td className="py-2">{CHARGE_LABEL[c.status]}</td>
                  <td className="py-2 text-right">
                    {c.status !== 'paid' && (
                      <button onClick={() => onMark(c.id, 'paid')} disabled={busy}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-accent">
                        Платена
                      </button>
                    )}{' '}
                    {c.status === 'due' && (
                      <button onClick={() => onMark(c.id, 'waived')} disabled={busy}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-accent">
                        Опрости
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
