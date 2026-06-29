'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Search, Check, ChevronRight, FlaskConical } from 'lucide-react';
import { cn, eur } from '@/lib/utils';
import { listAllFarmers, type GlobalFarmer, type Paginated } from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';

function CarrierPill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-bold',
        on ? 'bg-ff-green-50 text-ff-green-700' : 'bg-ff-surface-2 text-ff-muted-2',
      )}
    >
      {on && <Check size={11} />}
      {label}
    </span>
  );
}

export function ProducersClient({ initial }: { initial: Paginated<GlobalFarmer> }) {
  const { items, loadMore, hasMore, loading } = usePaginatedList<GlobalFarmer>(initial, listAllFarmers);
  // Drain remaining pages so the client search covers EVERY farmer, not just page 1.
  // Platform-total producers is a small set (tens), so this is scale-appropriate.
  useEffect(() => {
    if (hasMore && !loading) void loadMore();
  }, [hasMore, loading, loadMore]);

  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const rows = items.filter(
    (f) =>
      !needle ||
      f.name.toLowerCase().includes(needle) ||
      f.tenantName.toLowerCase().includes(needle) ||
      (f.loginEmail ?? '').toLowerCase().includes(needle),
  );

  const withLogin = items.filter((f) => f.hasLogin).length;
  const withCourier = items.filter((f) => f.courierEnabled).length;

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Производители</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            Всички фермери от всички ферми · {items.length} общо · {withLogin} с достъп · {withCourier} с куриер
          </p>
        </div>
        <div className="relative w-[300px] max-[560px]:w-full">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ff-muted">
            <Search size={18} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Търси по фермер, ферма или имейл…"
            className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-11 pr-3 text-[14.5px] shadow-ff-sm outline-none focus:border-ff-green-500"
          />
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {['Фермер', 'Ферма', 'Вход', 'Куриер', 'Свързани', 'Продукти', 'Поръчки', 'Пратки', 'НП чака'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-4 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className="border-b border-ff-border-2 align-top last:border-0">
                  <td className="px-4 py-3">
                    <div className="text-[13.5px] font-bold text-ff-ink">{f.name}</div>
                    {f.role && <div className="text-[12px] text-ff-muted">{f.role}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/tenants/${f.tenantId}`}
                      className="inline-flex items-center gap-1 text-[13px] font-bold text-ff-green-700 no-underline hover:underline"
                    >
                      {f.tenantName}
                      <ChevronRight size={14} className="text-ff-muted-2" />
                    </Link>
                    {f.isDemo && (
                      <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-[#EEF4FF] px-2 py-0.5 text-[11px] font-bold text-[#3457B1]">
                        <FlaskConical size={10} /> ДЕМО
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[13px] text-ff-ink-2">
                    {f.hasLogin ? (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {f.loginEmail ?? '—'}
                        {f.invitePending && (
                          <span className="rounded-full bg-ff-amber-soft px-2 py-0.5 text-[11px] font-bold text-ff-amber-600">покана</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-ff-muted-2">няма достъп</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2.5 py-1 text-[12px] font-bold',
                        f.courierEnabled ? 'bg-ff-green-50 text-ff-green-700' : 'bg-ff-surface-2 text-ff-muted-2',
                      )}
                    >
                      {f.courierEnabled ? 'Вкл' : 'Изкл'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <CarrierPill on={f.econtConnected} label="Еконт" />
                      <CarrierPill on={f.speedyConnected} label="Speedy" />
                    </div>
                  </td>
                  <td className="ff-fig px-4 py-3 text-[13.5px] text-ff-ink-2">{f.products}</td>
                  <td className="ff-fig px-4 py-3 text-[13.5px] text-ff-ink-2">{f.courierOrders}</td>
                  <td className="ff-fig whitespace-nowrap px-4 py-3 text-[13.5px] text-ff-ink-2">
                    {f.shipments}
                    {f.draftShipments > 0 && <span className="ml-1 text-[12px] text-ff-amber-600">+{f.draftShipments} чернови</span>}
                  </td>
                  <td className="ff-fig px-4 py-3 text-[13.5px] font-bold text-ff-ink">{eur(f.codPendingStotinki)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-ff-muted">
            {needle ? 'Няма намерени фермери.' : 'Все още няма фермери.'}
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
