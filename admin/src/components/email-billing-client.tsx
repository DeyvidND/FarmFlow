'use client';

import { useState } from 'react';
import { Search, Mail } from 'lucide-react';
import { dmy, eur } from '@/lib/utils';
import type { PlatformEmailBilling } from '@/lib/api-client';

function pct(margin: number, revenue: number): string {
  if (revenue <= 0) return '—';
  return `${Math.round((margin / revenue) * 100)}%`;
}

export function EmailBillingClient({ initial }: { initial: PlatformEmailBilling }) {
  const [q, setQ] = useState('');
  const { rows, totals } = initial;

  const filtered = rows.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q.toLowerCase()) ||
      (r.email ?? '').toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Имейл сметки</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            Бюлетините се таксуват автоматично през Stripe (€0.000555 на получател) към абонамента на фермата.
            Долу виждаш приход, разход (Resend) и твоята печалба.
          </p>
        </div>
        <div className="relative w-[280px] max-[560px]:w-full">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ff-muted">
            <Search size={18} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Търси по ферма или имейл…"
            className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-11 pr-3 text-[14.5px] shadow-ff-sm outline-none focus:border-ff-green-500"
          />
        </div>
      </div>

      {/* grand totals — revenue / cost / margin */}
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-ff-green-100 bg-ff-green-50 px-5 py-4 shadow-ff-sm">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
          <Mail size={22} />
        </span>
        <div className="flex flex-1 flex-wrap items-baseline gap-x-8 gap-y-2">
          <Stat label="Приход" value={eur(totals.revenueStotinki)} strong />
          <Stat label="Разход (Resend)" value={eur(totals.costStotinki)} />
          <Stat
            label={`Печалба (${pct(totals.marginStotinki, totals.revenueStotinki)})`}
            value={eur(totals.marginStotinki)}
            strong
          />
          <div className="text-[13.5px] text-ff-ink-2">
            <span className="ff-fig font-bold">{rows.length}</span> ферми ·{' '}
            <span className="ff-fig font-bold">{totals.recipientTotal}</span> имейла
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* desktop table */}
        <table className="w-full border-collapse max-[760px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Ферма', 'Имейли', 'Приход', 'Разход', 'Печалба', 'Последно'].map((h) => (
                <th key={h} className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.tenantId} className="border-b border-ff-border-2 last:border-0">
                <td className="px-5 py-3.5">
                  <div className="text-[14.5px] font-bold">{r.name}</div>
                  <div className="text-xs text-ff-muted-2">{r.email ?? `/${r.slug}`}</div>
                </td>
                <td className="ff-fig px-5 py-3.5 text-[14px] font-bold">{r.recipientTotal}</td>
                <td className="ff-fig px-5 py-3.5 text-[14px] font-bold text-ff-green-800">{eur(r.totalStotinki)}</td>
                <td className="ff-fig px-5 py-3.5 text-[13.5px] text-ff-ink-2">{eur(r.costStotinki)}</td>
                <td className="ff-fig px-5 py-3.5 text-[15px] font-extrabold text-ff-green-800">
                  {eur(r.marginStotinki)}
                  <span className="ml-1 text-[12px] font-semibold text-ff-muted">{pct(r.marginStotinki, r.totalStotinki)}</span>
                </td>
                <td className="px-5 py-3.5 text-[13.5px] text-ff-ink-2">{dmy(r.lastPushAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* mobile cards */}
        <div className="hidden flex-col max-[760px]:flex">
          {filtered.map((r) => (
            <div key={r.tenantId} className="flex flex-col gap-2 border-b border-ff-border-2 px-4 py-3.5 last:border-0">
              <div className="flex items-start justify-between gap-2.5">
                <div className="min-w-0">
                  <div className="text-[15.5px] font-extrabold">{r.name}</div>
                  <div className="text-[12.5px] text-ff-muted">{r.email ?? '—'}</div>
                </div>
                <div className="text-right">
                  <div className="ff-fig text-[16px] font-extrabold text-ff-green-800">{eur(r.marginStotinki)}</div>
                  <div className="text-[11px] text-ff-muted">печалба</div>
                </div>
              </div>
              <div className="text-[12.5px] text-ff-muted">
                <span className="ff-fig">{r.recipientTotal}</span> имейла · приход {eur(r.totalStotinki)} · разход {eur(r.costStotinki)}
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-ff-muted">
            {rows.length === 0 ? 'Все още няма изпратени бюлетини.' : 'Няма намерени ферми.'}
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">{label}</div>
      <div className={`ff-fig text-[22px] font-extrabold ${strong ? 'text-ff-green-800' : 'text-ff-ink-2'}`}>{value}</div>
    </div>
  );
}
