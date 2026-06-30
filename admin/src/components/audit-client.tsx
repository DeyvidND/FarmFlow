'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Search, ShieldAlert, User, Server, Tractor, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  listAuditLogs,
  listTenants,
  listAllFarmers,
  type AuditLog,
  type Paginated,
} from '@/lib/api-client';

type View = 'all' | 'farm' | 'producer';

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

const TABS: { key: View; label: string; icon: typeof Tractor }[] = [
  { key: 'all', label: 'Всички', icon: Server },
  { key: 'farm', label: 'По ферма', icon: Tractor },
  { key: 'producer', label: 'По производител', icon: Users },
];

export function AuditClient({ initial }: { initial: Paginated<AuditLog> }) {
  const [q, setQ] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  // Drill-down selection
  const [view, setView] = useState<View>('all');
  const [farmId, setFarmId] = useState('');
  const [producerId, setProducerId] = useState('');

  // Picker option lists (first page is plenty for a drill-down on a small platform).
  const [farms, setFarms] = useState<{ id: string; name: string }[]>([]);
  const [producers, setProducers] = useState<{ id: string; name: string; tenantName: string }[]>([]);
  useEffect(() => {
    void listTenants().then((p) => setFarms(p.items.map((t) => ({ id: t.id, name: t.name }))));
    void listAllFarmers().then((p) =>
      setProducers(p.items.map((f) => ({ id: f.id, name: f.name, tenantName: f.tenantName }))),
    );
  }, []);

  // Active feed. 'all' is seeded from SSR; filtered views fetch a fresh first page.
  const [items, setItems] = useState<AuditLog[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false); // load-more
  const [feedLoading, setFeedLoading] = useState(false); // first page after filter change

  const needsPick = (view === 'farm' && !farmId) || (view === 'producer' && !producerId);
  const opts = useMemo(
    () =>
      view === 'farm' && farmId
        ? { tenantId: farmId }
        : view === 'producer' && producerId
          ? { farmerId: producerId }
          : undefined,
    [view, farmId, producerId],
  );
  const feedKey = needsPick ? 'none' : view === 'all' ? 'all' : opts!.tenantId ? `t:${opts!.tenantId}` : `f:${opts!.farmerId}`;

  // Reload the first page whenever the active feed changes. Skip the very first run
  // (the SSR 'all' page is already in state).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (feedKey === 'none') {
      setItems([]);
      setCursor(null);
      return;
    }
    let cancelled = false;
    setFeedLoading(true);
    listAuditLogs(undefined, opts)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .finally(() => {
        if (!cancelled) setFeedLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // opts is keyed by feedKey; re-running on feedKey alone is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedKey]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await listAuditLogs(cursor, opts);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }

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

      {/* Drill-down: by farm or by producer */}
      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <div className="inline-flex rounded-xl border border-ff-border bg-ff-surface p-1 shadow-ff-sm">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setView(t.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-bold transition-colors',
                  view === t.key ? 'bg-ff-green-700 text-white' : 'text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Icon size={15} /> {t.label}
              </button>
            );
          })}
        </div>

        {view === 'farm' && (
          <select
            value={farmId}
            onChange={(e) => setFarmId(e.target.value)}
            className="h-11 min-w-[220px] rounded-xl border border-ff-border bg-ff-surface px-3 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm outline-none focus:border-ff-green-500"
          >
            <option value="">Избери ферма…</option>
            {farms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}

        {view === 'producer' && (
          <select
            value={producerId}
            onChange={(e) => setProducerId(e.target.value)}
            className="h-11 min-w-[260px] rounded-xl border border-ff-border bg-ff-surface px-3 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm outline-none focus:border-ff-green-500"
          >
            <option value="">Избери производител…</option>
            {producers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.tenantName}
              </option>
            ))}
          </select>
        )}
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
            {needsPick
              ? view === 'farm'
                ? 'Избери ферма, за да видиш нейния одит.'
                : 'Избери производител, за да видиш неговия одит.'
              : feedLoading
                ? 'Зареждане…'
                : needle || errorsOnly
                  ? 'Няма съвпадащи редове в заредените.'
                  : view === 'producer'
                    ? 'Няма записи за този производител (данните се събират занапред).'
                    : 'Все още няма записи.'}
          </p>
        )}
      </div>

      {cursor !== null && !needsPick && (
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
