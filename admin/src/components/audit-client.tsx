'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, ShieldAlert, User, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listAuditLogs, type AuditLog, type Paginated } from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';

const methodTone = (m: string) =>
  m === 'DELETE'
    ? 'bg-[#FBE9E7] text-ff-red'
    : m === 'POST'
      ? 'bg-ff-green-50 text-ff-green-700'
      : m === 'PATCH' || m === 'PUT'
        ? 'bg-ff-amber-soft text-ff-amber-600'
        : 'bg-ff-surface-2 text-ff-ink-2';

const statusTone = (s: number | null) =>
  s == null ? 'text-ff-muted' : s >= 500 ? 'text-ff-red' : s >= 400 ? 'text-ff-amber-600' : 'text-ff-green-700';

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function Actor({ a }: { a: AuditLog }) {
  if (a.actorType === 'admin') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px]">
        <ShieldAlert size={14} className="text-[#3457B1]" />
        <span className="font-bold text-[#3457B1]">{a.actorEmail ?? 'Платформа'}</span>
      </span>
    );
  }
  if (a.actorType === 'user') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-ff-ink-2">
        <User size={14} className="text-ff-muted" />
        {a.actorEmail ?? '—'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ff-muted">
      <Server size={14} /> система
    </span>
  );
}

export function AuditClient({ initial }: { initial: Paginated<AuditLog> }) {
  const { items, loadMore, hasMore, loading } = usePaginatedList<AuditLog>(initial, listAuditLogs);
  const [q, setQ] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  const needle = q.trim().toLowerCase();
  const rows = items.filter(
    (a) =>
      (!errorsOnly || (a.statusCode ?? 0) >= 400) &&
      (!needle ||
        a.path.toLowerCase().includes(needle) ||
        (a.actorEmail ?? '').toLowerCase().includes(needle) ||
        (a.tenantName ?? '').toLowerCase().includes(needle)),
  );

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Одит</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            Последни действия (промени) във всички ферми. Филтрите важат за заредените редове.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 max-[560px]:w-full">
          <button
            type="button"
            onClick={() => setErrorsOnly((v) => !v)}
            className={cn(
              'inline-flex h-11 items-center gap-2 rounded-xl border px-4 text-[13.5px] font-bold shadow-ff-sm',
              errorsOnly
                ? 'border-ff-red bg-[#FBE9E7] text-ff-red'
                : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
            )}
          >
            <ShieldAlert size={16} /> Само грешки
          </button>
          <div className="relative w-[260px] max-[560px]:w-full">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ff-muted">
              <Search size={18} />
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Търси по път, имейл, ферма…"
              className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-11 pr-3 text-[14.5px] shadow-ff-sm outline-none focus:border-ff-green-500"
            />
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {['Време', 'Кой', 'Действие', 'Път', 'Статус', 'Ферма'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-4 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-ff-border-2 last:border-0">
                  <td className="ff-fig whitespace-nowrap px-4 py-2.5 text-[13px] text-ff-muted">{fmtTime(a.createdAt)}</td>
                  <td className="px-4 py-2.5">
                    <Actor a={a} />
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={cn('inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-bold', methodTone(a.action))}>{a.action}</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12.5px] text-ff-ink-2">{a.path}</td>
                  <td className={cn('ff-fig px-4 py-2.5 text-[13px] font-bold', statusTone(a.statusCode))}>{a.statusCode ?? '—'}</td>
                  <td className="px-4 py-2.5 text-[13px]">
                    {a.tenantId ? (
                      <Link href={`/tenants/${a.tenantId}`} className="font-bold text-ff-green-700 no-underline hover:underline">
                        {a.tenantName ?? a.tenantId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-ff-muted-2">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-ff-muted">
            {needle || errorsOnly ? 'Няма съвпадащи редове в заредените.' : 'Все още няма записи.'}
          </p>
        )}
      </div>

      {hasMore && (
        <div className="mt-5 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
          >
            {loading ? 'Зареждане…' : 'Зареди още'}
          </button>
        </div>
      )}
    </div>
  );
}
