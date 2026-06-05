'use client';

import { useMemo, useState } from 'react';
import { Search, Mail } from 'lucide-react';
import { dmy, eur } from '@/lib/utils';
import type { PlatformEmailBilling } from '@/lib/api-client';

export function EmailBillingClient({ initial }: { initial: PlatformEmailBilling[] }) {
  const [q, setQ] = useState('');

  const filtered = initial.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q.toLowerCase()) ||
      (r.email ?? '').toLowerCase().includes(q.toLowerCase()),
  );

  const totalOwed = useMemo(() => initial.reduce((s, r) => s + r.totalStotinki, 0), [initial]);
  const totalPushes = useMemo(() => initial.reduce((s, r) => s + r.pushCount, 0), [initial]);

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Имейл сметки</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            Колко дължи всяка ферма за изпратени бюлетини. Плащанията събираш ти, ръчно.
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

      {/* grand total */}
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-ff-green-100 bg-ff-green-50 px-5 py-4 shadow-ff-sm">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
          <Mail size={22} />
        </span>
        <div className="flex flex-1 flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Общо дължимо</div>
            <div className="ff-fig text-[24px] font-extrabold text-ff-green-800">{eur(totalOwed)}</div>
          </div>
          <div className="text-[13.5px] text-ff-ink-2">
            <span className="ff-fig font-bold">{initial.length}</span> ферми ·{' '}
            <span className="ff-fig font-bold">{totalPushes}</span> изпращания
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* desktop table */}
        <table className="w-full border-collapse max-[760px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Ферма', 'Имейл', 'Изпращания', 'Последно', 'Дължима сума'].map((h) => (
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
                  <div className="text-xs text-ff-muted-2">/{r.slug}</div>
                </td>
                <td className="px-5 py-3.5 text-[13.5px] text-ff-ink-2">{r.email ?? '—'}</td>
                <td className="ff-fig px-5 py-3.5 text-[14px] font-bold">{r.pushCount}</td>
                <td className="px-5 py-3.5 text-[13.5px] text-ff-ink-2">{dmy(r.lastPushAt)}</td>
                <td className="ff-fig px-5 py-3.5 text-[15px] font-extrabold text-ff-green-800">
                  {eur(r.totalStotinki)}
                </td>
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
                <div className="ff-fig text-[16px] font-extrabold text-ff-green-800">{eur(r.totalStotinki)}</div>
              </div>
              <div className="text-[12.5px] text-ff-muted">
                <span className="ff-fig">{r.pushCount}</span> изпращания · последно {dmy(r.lastPushAt)}
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-ff-muted">
            {initial.length === 0 ? 'Все още няма изпратени бюлетини.' : 'Няма намерени ферми.'}
          </p>
        )}
      </div>
    </div>
  );
}
