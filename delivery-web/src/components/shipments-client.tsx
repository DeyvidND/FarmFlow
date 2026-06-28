'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { RefreshCw, FileDown, Package, Upload } from 'lucide-react';
import {
  ApiError, listEcontShipments, listSpeedyShipments, refreshShipment, downloadLabel,
  type ShipmentRow, type ShipmentStatus, type Carrier,
} from '@/lib/api-client';
import { SenderStrip } from './sender-strip';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const STATUS_LABEL: Record<ShipmentStatus, string> = {
  pending: 'Чакаща',
  created: 'Създадена',
  shipped: 'Изпратена',
  delivered: 'Доставена',
  returned: 'Върната',
  refused: 'Отказана',
};

// Earthy palette only — there is no dedicated blue token, so created/shipped reuse
// the gray-badge + amber tones; delivered = green; returned/refused = red.
const statusPill = (s: ShipmentStatus): string => {
  switch (s) {
    case 'delivered': return 'bg-ff-green-50 text-ff-green-700';
    case 'shipped': return 'bg-ff-amber-softer text-ff-amber-600';
    case 'created': return 'bg-ff-amber-soft text-ff-amber-600';
    case 'returned':
    case 'refused': return 'bg-[#FBE9E7] text-ff-red';
    case 'pending':
    default: return 'bg-ff-badge-bg text-ff-badge-ink';
  }
};

const StatusPill = ({ s }: { s: ShipmentStatus }) => (
  <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-bold ${statusPill(s)}`}>
    {STATUS_LABEL[s] ?? s}
  </span>
);

const carrierLabel = (c: Carrier) => (c === 'speedy' ? 'Speedy' : 'Econt');
const money = (st: number | null | undefined) => (st == null ? '—' : `${st} ст.`);

export function ShipmentsClient() {
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Fetch both carriers in parallel; a failure on one must NOT blank the other.
    const [econt, speedy] = await Promise.allSettled([listEcontShipments(), listSpeedyShipments()]);
    const merged: ShipmentRow[] = [];
    if (econt.status === 'fulfilled') merged.push(...econt.value);
    else toast.error(`Econt: ${errMsg(econt.reason)}`);
    if (speedy.status === 'fulfilled') merged.push(...speedy.value);
    else toast.error(`Speedy: ${errMsg(speedy.reason)}`);
    // Newest first: the lists already come ordered newest→oldest per carrier; keep
    // econt then speedy interleaving stable (no reliable cross-carrier timestamp).
    setRows(merged);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function refresh(r: ShipmentRow) {
    if (!r.shipmentId) return;
    setBusyKey(r.rowKey);
    try {
      await refreshShipment(r.carrier, r.shipmentId);
      toast.success('Статусът е опреснен');
      await load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusyKey(null); }
  }

  async function label(r: ShipmentRow) {
    if (!r.shipmentId) return;
    setBusyKey(r.rowKey);
    try { await downloadLabel(r.carrier, r.shipmentId); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusyKey(null); }
  }

  const btn = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-2.5 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2 disabled:opacity-50';

  const total = rows.length;
  const by = (s: ShipmentStatus) => rows.filter((r) => r.status === s).length;
  const summary = [
    { label: 'Общо', n: total, cls: 'bg-ff-badge-bg text-ff-badge-ink' },
    { label: 'Доставени', n: by('delivered'), cls: 'bg-ff-green-50 text-ff-green-700' },
    { label: 'Изпратени', n: by('shipped'), cls: 'bg-ff-amber-softer text-ff-amber-600' },
    { label: 'Създадени', n: by('created') + by('pending'), cls: 'bg-ff-amber-soft text-ff-amber-600' },
    { label: 'Проблемни', n: by('returned') + by('refused'), cls: 'bg-[#FBE9E7] text-ff-red' },
  ];

  return (
    <div className="animate-ff-fade-up">
      <SenderStrip />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Пратки</h1>
          <p className="mt-1 text-[13.5px] text-ff-muted">Всички създадени пратки от Econt и Speedy.</p>
        </div>
        <button onClick={() => void load()} disabled={loading} className={btn + ' h-10 px-3'}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> <span className="max-sm:hidden">Опресни</span>
        </button>
      </div>

      {loading && rows.length === 0 ? (
        <p className="mt-6 text-[14px] text-ff-muted">Зареждам…</p>
      ) : rows.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-xl border border-dashed border-ff-border bg-ff-surface py-14 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-ff-green-50">
            <Package size={28} className="text-ff-green-600" />
          </div>
          <p className="mt-3 text-[15px] font-bold text-ff-ink-2">Няма пратки</p>
          <p className="mt-1 text-[13px] text-ff-muted">Създадените пратки ще се появят тук.</p>
          <Link href="/import" className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95">
            <Upload size={16} /> Внеси пратки
          </Link>
        </div>
      ) : (
        <>
          {/* summary chips */}
          <div className="mt-4 flex flex-wrap gap-2">
            {summary.map((c) => (
              <span key={c.label} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-bold ${c.cls}`}>
                <span className="ff-fig">{c.n}</span> {c.label}
              </span>
            ))}
          </div>

          {/* desktop table */}
          <div className="mt-4 overflow-x-auto rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:hidden">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                  {['Получател', 'Куриер', 'Метод', 'Статус', 'Товарителница', 'НП (ст.)', 'Цена (ст.)', ''].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rowKey} className="border-b border-ff-border-2 last:border-0">
                    <td className="px-3 py-2.5 font-semibold text-ff-ink">{r.receiver || '—'}</td>
                    <td className="px-3 py-2.5 text-ff-ink-2">{carrierLabel(r.carrier)}</td>
                    <td className="px-3 py-2.5 text-ff-ink-2">{r.method ?? '—'}</td>
                    <td className="px-3 py-2.5"><StatusPill s={r.status} /></td>
                    <td className="px-3 py-2.5 ff-fig text-ff-ink-2">{r.trackingNumber || '—'}</td>
                    <td className="px-3 py-2.5 ff-fig text-ff-ink-2">{money(r.codAmountStotinki)}</td>
                    <td className="px-3 py-2.5 ff-fig text-ff-ink-2">{money(r.priceStotinki)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-1.5">
                        {r.shipmentId && (
                          <button onClick={() => refresh(r)} disabled={busyKey === r.rowKey} className={btn} title="Опресни статус">
                            <RefreshCw size={14} className={busyKey === r.rowKey ? 'animate-spin' : ''} />
                          </button>
                        )}
                        {r.shipmentId && (
                          <button onClick={() => label(r)} disabled={busyKey === r.rowKey} className={btn} title="Свали етикет">
                            <FileDown size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* mobile cards */}
          <div className="mt-4 hidden flex-col gap-3 max-[900px]:flex">
            {rows.map((r) => (
              <div key={r.rowKey} className="rounded-xl border border-ff-border bg-ff-surface p-3.5 shadow-ff-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-bold text-ff-ink">{r.receiver || '—'}</div>
                    <div className="mt-0.5 text-[12.5px] font-semibold text-ff-muted">{carrierLabel(r.carrier)} · {r.method ?? '—'}</div>
                  </div>
                  <StatusPill s={r.status} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-[13px]">
                  <dt className="text-ff-muted">Товарителница</dt>
                  <dd className="ff-fig text-right text-ff-ink-2">{r.trackingNumber || '—'}</dd>
                  <dt className="text-ff-muted">НП</dt>
                  <dd className="ff-fig text-right text-ff-ink-2">{money(r.codAmountStotinki)}</dd>
                  <dt className="text-ff-muted">Цена</dt>
                  <dd className="ff-fig text-right text-ff-ink-2">{money(r.priceStotinki)}</dd>
                </dl>
                {r.shipmentId && (
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => refresh(r)} disabled={busyKey === r.rowKey} className={btn + ' h-11 flex-1'}>
                      <RefreshCw size={15} className={busyKey === r.rowKey ? 'animate-spin' : ''} /> Опресни
                    </button>
                    <button onClick={() => label(r)} disabled={busyKey === r.rowKey} className={btn + ' h-11 flex-1'}>
                      <FileDown size={15} /> Етикет
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
