'use client';

import { useMemo, useState } from 'react';
import { Search, CreditCard, Check, X } from 'lucide-react';
import { dmy } from '@/lib/utils';
import type { PlatformStripeAccount } from '@/lib/api-client';

type StatusKey = 'active' | 'review' | 'incomplete';

const STATUS: Record<StatusKey, { label: string; bg: string; ink: string; dot: string }> = {
  active: { label: 'Активна', bg: 'bg-ff-green-100', ink: 'text-ff-green-700', dot: 'bg-ff-green-500' },
  review: { label: 'В проверка', bg: 'bg-ff-amber-soft', ink: 'text-ff-amber-600', dot: 'bg-ff-amber' },
  incomplete: { label: 'Непълна', bg: 'bg-ff-surface-2', ink: 'text-ff-muted', dot: 'bg-ff-muted-2' },
};

function statusKey(r: PlatformStripeAccount): StatusKey {
  if (r.chargesEnabled && r.payoutsEnabled) return 'active';
  if (r.detailsSubmitted) return 'review';
  return 'incomplete';
}

function StatusBadge({ k }: { k: StatusKey }) {
  const s = STATUS[k];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-xs font-bold ${s.bg} ${s.ink}`}
    >
      <span className={`h-[7px] w-[7px] rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function Cap({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[12.5px] font-semibold ${on ? 'text-ff-green-700' : 'text-ff-muted-2'}`}
    >
      {on ? <Check size={14} /> : <X size={14} />} {label}
    </span>
  );
}

export function StripeAccountsClient({ initial }: { initial: PlatformStripeAccount[] }) {
  const [q, setQ] = useState('');

  const filtered = initial.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q.toLowerCase()) ||
      (r.email ?? '').toLowerCase().includes(q.toLowerCase()),
  );

  const active = useMemo(
    () => initial.filter((r) => r.chargesEnabled && r.payoutsEnabled).length,
    [initial],
  );
  const pending = initial.length - active;

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">
            Stripe плащания
          </h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            Кои ферми са свързали Stripe и приемат ли вече картови плащания.
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

      {/* summary */}
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-ff-green-100 bg-ff-green-50 px-5 py-4 shadow-ff-sm">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
          <CreditCard size={22} />
        </span>
        <div className="flex flex-1 flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">
              Свързани ферми
            </div>
            <div className="ff-fig text-[24px] font-extrabold text-ff-green-800">{initial.length}</div>
          </div>
          <div className="text-[13.5px] text-ff-ink-2">
            <span className="ff-fig font-bold">{active}</span> активни ·{' '}
            <span className="ff-fig font-bold">{pending}</span> в процес
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* desktop table */}
        <table className="w-full border-collapse max-[760px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Ферма', 'Имейл', 'Възможности', 'Статус', 'Обновено'].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted"
                >
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
                <td className="px-5 py-3.5">
                  <div className="flex flex-col gap-1">
                    <Cap on={r.chargesEnabled} label="Карти" />
                    <Cap on={r.payoutsEnabled} label="Изплащания" />
                  </div>
                </td>
                <td className="px-5 py-3.5">
                  <StatusBadge k={statusKey(r)} />
                </td>
                <td className="px-5 py-3.5 text-[13.5px] text-ff-ink-2">{dmy(r.statusUpdatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* mobile cards */}
        <div className="hidden flex-col max-[760px]:flex">
          {filtered.map((r) => (
            <div
              key={r.tenantId}
              className="flex flex-col gap-2 border-b border-ff-border-2 px-4 py-3.5 last:border-0"
            >
              <div className="flex items-start justify-between gap-2.5">
                <div className="min-w-0">
                  <div className="text-[15.5px] font-extrabold">{r.name}</div>
                  <div className="text-[12.5px] text-ff-muted">{r.email ?? '—'}</div>
                </div>
                <StatusBadge k={statusKey(r)} />
              </div>
              <div className="flex items-center gap-4">
                <Cap on={r.chargesEnabled} label="Карти" />
                <Cap on={r.payoutsEnabled} label="Изплащания" />
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-ff-muted">
            {initial.length === 0
              ? 'Все още няма ферми, свързали Stripe.'
              : 'Няма намерени ферми.'}
          </p>
        )}
      </div>
    </div>
  );
}
