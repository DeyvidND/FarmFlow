'use client';

import * as React from 'react';
import { Search, Truck, Printer, Navigation, X, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SHIPMENT_META, SHORT_METHOD, lv } from '@/lib/delivery-data';
import type { Shipment, ShipmentStatus } from '@/lib/types';
import { listShipments, createShipment, voidShipment, refreshShipment, ApiError } from '@/lib/api-client';
import { DSection, DBadge, Segmented, fieldCls } from './ui';

type Toast = { success: (m: string) => void; info?: (m: string) => void; error: (m: string) => void };

const STATUS_OPTS: { value: ShipmentStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Всички' },
  { value: 'pending', label: 'Чака' },
  { value: 'created', label: 'Създадена' },
  { value: 'shipped', label: 'Изпратена' },
  { value: 'delivered', label: 'Доставена' },
];

const actBtnCls =
  'grid h-8 w-8 place-items-center rounded-sm border border-ff-border bg-ff-surface text-ff-ink-2 transition-colors hover:bg-ff-green-50 hover:text-ff-green-700';

export function ShipmentsTable({ toast }: { toast: Toast }) {
  const [rows, setRows] = React.useState<Shipment[]>([]);
  const reload = React.useCallback(async () => {
    try {
      setRows(await listShipments());
    } catch {
      /* leave current rows */
    }
  }, []);
  React.useEffect(() => {
    void reload();
  }, [reload]);
  const [status, setStatus] = React.useState<ShipmentStatus | 'all'>('all');
  const [method, setMethod] = React.useState<string>('all');
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState<string[]>([]);
  const [track, setTrack] = React.useState<Shipment | null>(null);

  const shown = rows.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      (method === 'all' || r.method === method) &&
      (q === '' ||
        r.customerName.toLowerCase().includes(q.toLowerCase()) ||
        r.orderNumber.includes(q) ||
        (r.trackingNumber || '').includes(q)),
  );
  const toggleSel = (id: string) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allSel = shown.length > 0 && shown.every((r) => sel.includes(r.orderId));

  const createLabel = async (id: string) => {
    try {
      await createShipment(id);
      await reload();
      toast.success('Товарителницата е създадена');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Неуспешно създаване');
    }
  };
  const voidLabel = async (r: Shipment) => {
    if (!r.shipmentId) return;
    try {
      await voidShipment(r.shipmentId);
      await reload();
      toast.info?.('Товарителницата е отказана');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Неуспешно анулиране');
    }
  };
  const refreshTrack = async (r: Shipment) => {
    if (!r.shipmentId) return;
    try {
      await refreshShipment(r.shipmentId);
      await reload();
      toast.success('Проследяването е обновено');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Неуспешно обновяване');
    }
  };
  const copyTrack = (t: string) => {
    navigator.clipboard?.writeText(t.replace(/\s/g, ''));
    toast.success('Номерът е копиран');
  };
  const printOne = (r: Shipment) => {
    if (!r.shipmentId) return;
    window.open(`/bff/econt/shipments/${r.shipmentId}/label.pdf`, '_blank', 'noopener');
  };
  const bulkCreate = () => {
    sel.forEach((id) => {
      const r = rows.find((x) => x.orderId === id);
      if (r && r.status === 'pending') createLabel(id);
    });
    setSel([]);
  };
  const printSelected = () => {
    const ids = sel
      .map((id) => rows.find((x) => x.orderId === id)?.shipmentId)
      .filter((x): x is string => !!x);
    if (!ids.length) {
      toast.info?.('Избери товарителници със създаден етикет');
      return;
    }
    window.open(`/bff/econt/labels.pdf?ids=${ids.join(',')}`, '_blank', 'noopener');
  };

  const grid = 'grid-cols-[32px_72px_1.2fr_0.9fr_1fr_1.2fr_0.8fr_110px]';

  return (
    <DSection
      title="Товарителници и проследяване"
      helper="Поръчки с доставка през Еконт. Създавай и проследявай товарителници."
      info={
        <>
          Тук виждаш <b>всички поръчки за доставка</b>. С едно натискане създаваш товарителница (иконата
          с камион), печаташ я или проследяваш къде е пратката.
        </>
      }
    >
      {/* filters */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-ff-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Търси клиент, № поръчка или товарителница…"
            className={cn(fieldCls, 'pl-9')}
          />
        </div>
        <Segmented value={status} onChange={setStatus} options={STATUS_OPTS} />
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className={cn(fieldCls, 'w-auto cursor-pointer appearance-none')}
        >
          <option value="all">Всички методи</option>
          <option value="econtOffice">Еконт офис</option>
          <option value="econtAddress">Еконт адрес</option>
          <option value="ownSlots">Лична</option>
        </select>
      </div>

      {/* bulk toolbar */}
      {sel.length > 0 && (
        <div className="mb-3 flex items-center gap-2.5 rounded-[10px] border border-ff-green-100 bg-ff-green-50 px-3.5 py-2.5">
          <span className="text-[13.5px] font-bold text-ff-green-800">Избрани: {sel.length}</span>
          <div className="ml-auto flex gap-2">
            <Button variant="soft" size="sm" onClick={bulkCreate}>
              <Truck size={15} /> Създай товарителници ({sel.length})
            </Button>
            <Button variant="ghost" size="sm" onClick={printSelected}>
              <Printer size={15} /> Принтирай избраните
            </Button>
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <div className="mx-auto mb-3.5 grid h-14 w-14 place-items-center rounded-[14px] bg-ff-surface-2 text-ff-muted-2">
            <Truck size={28} />
          </div>
          <div className="mb-1 text-[15px] font-extrabold text-ff-ink">Все още няма товарителници</div>
          <p className="text-[13.5px] text-ff-ink-2">
            Когато създадеш товарителница за поръчка, тя ще се появи тук.
          </p>
        </div>
      ) : (
        <>
          {/* desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-ff-border md:block">
            <div
              className={cn(
                'grid gap-3 border-b border-ff-border bg-ff-surface-2 px-4 py-2.5 text-[11.5px] font-extrabold uppercase tracking-[0.03em] text-ff-muted',
                grid,
              )}
            >
              <span>
                <input
                  type="checkbox"
                  checked={allSel}
                  onChange={() => setSel(allSel ? [] : shown.map((r) => r.orderId))}
                  className="h-4 w-4 accent-ff-green-600"
                />
              </span>
              <span>Поръчка</span>
              <span>Клиент</span>
              <span>Метод</span>
              <span>Статус</span>
              <span>Товарителница</span>
              <span className="text-right">Цена</span>
              <span />
            </div>
            {shown.map((r) => (
              <div
                key={r.orderId}
                className={cn(
                  'grid items-center gap-3 border-b border-ff-border-2 px-4 py-3 text-[13.5px]',
                  grid,
                )}
              >
                <span>
                  <input
                    type="checkbox"
                    checked={sel.includes(r.orderId)}
                    onChange={() => toggleSel(r.orderId)}
                    className="h-4 w-4 accent-ff-green-600"
                  />
                </span>
                <span className="font-extrabold text-ff-ink">№ {r.orderNumber}</span>
                <span className="text-ff-ink">{r.customerName}</span>
                <span className="text-ff-ink-2">{SHORT_METHOD[r.method]}</span>
                <span>
                  <DBadge tone={SHIPMENT_META[r.status].tone}>{SHIPMENT_META[r.status].label}</DBadge>
                </span>
                <span>
                  {r.trackingNumber ? (
                    <button
                      type="button"
                      onClick={() => copyTrack(r.trackingNumber!)}
                      title="Копирай"
                      className="ff-fig inline-flex items-center gap-1.5 text-[13px] font-bold text-ff-green-700"
                    >
                      {r.trackingNumber} <Copy size={14} />
                    </button>
                  ) : (
                    <span className="text-ff-muted">—</span>
                  )}
                </span>
                <span className="ff-fig text-right font-bold text-ff-ink">
                  {r.priceStotinki ? lv(r.priceStotinki) : '—'}
                </span>
                <span className="flex justify-end gap-1.5">
                  {r.status === 'pending' ? (
                    <button className={actBtnCls} title="Създай товарителница" onClick={() => createLabel(r.orderId)}>
                      <Truck size={16} />
                    </button>
                  ) : (
                    <>
                      <button className={actBtnCls} title="Принтирай" onClick={() => printOne(r)}>
                        <Printer size={16} />
                      </button>
                      <button className={actBtnCls} title="Проследи" onClick={() => setTrack(r)}>
                        <Navigation size={16} />
                      </button>
                      <button
                        className={cn(actBtnCls, 'hover:text-ff-red')}
                        title="Откажи"
                        onClick={() => voidLabel(r)}
                      >
                        <X size={16} />
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>

          {/* mobile cards */}
          <div className="flex flex-col gap-2.5 md:hidden">
            {shown.map((r) => (
              <div key={r.orderId} className="rounded-xl border border-ff-border bg-ff-surface p-3.5">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-ff-ink">№ {r.orderNumber}</span>
                  <DBadge tone={SHIPMENT_META[r.status].tone}>{SHIPMENT_META[r.status].label}</DBadge>
                </div>
                <div className="mt-1 text-[14px] font-bold text-ff-ink">{r.customerName}</div>
                <div className="mt-0.5 text-[12.5px] text-ff-muted">
                  {SHORT_METHOD[r.method]}
                  {r.priceStotinki ? ` · ${lv(r.priceStotinki)}` : ''}
                </div>
                {r.trackingNumber && (
                  <button
                    type="button"
                    onClick={() => copyTrack(r.trackingNumber!)}
                    className="ff-fig mt-1.5 inline-flex items-center gap-1.5 text-[13px] font-bold text-ff-green-700"
                  >
                    {r.trackingNumber} <Copy size={14} />
                  </button>
                )}
                <div className="mt-2.5 flex gap-1.5">
                  {r.status === 'pending' ? (
                    <Button variant="soft" size="sm" onClick={() => createLabel(r.orderId)}>
                      <Truck size={15} /> Създай
                    </Button>
                  ) : (
                    <>
                      <button className={actBtnCls} title="Принтирай" onClick={() => printOne(r)}>
                        <Printer size={16} />
                      </button>
                      <button className={actBtnCls} title="Проследи" onClick={() => setTrack(r)}>
                        <Navigation size={16} />
                      </button>
                      <button
                        className={cn(actBtnCls, 'hover:text-ff-red')}
                        title="Откажи"
                        onClick={() => voidLabel(r)}
                      >
                        <X size={16} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {track && (
        <TrackingModal
          shipment={track}
          onClose={() => setTrack(null)}
          onRefresh={() => refreshTrack(track)}
        />
      )}
    </DSection>
  );
}

function TrackingModal({ shipment, onClose, onRefresh }: { shipment: Shipment; onClose: () => void; onRefresh: () => void }) {
  const hist = shipment.history || [];
  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="animate-ff-pop max-h-[92vh] w-[440px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-ff-border-2 px-[22px] pb-4 pt-5">
          <div>
            <div className="mb-0.5 text-[12.5px] font-bold uppercase tracking-[0.02em] text-ff-muted">
              Проследяване · Поръчка № {shipment.orderNumber}
            </div>
            <h2 className="ff-fig font-display text-[20px] font-extrabold text-ff-ink">
              {shipment.trackingNumber || '—'}
            </h2>
            <div className="mt-2">
              <DBadge tone={SHIPMENT_META[shipment.status].tone}>
                {SHIPMENT_META[shipment.status].label}
              </DBadge>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRefresh}
              className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-ff-border bg-ff-surface-2 text-ff-ink-2 hover:bg-ff-green-50"
              title="Обнови"
            >
              <Navigation size={18} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Затвори"
              className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-ff-border bg-ff-surface-2 text-ff-ink-2 hover:bg-ff-green-50"
            >
              <X size={19} />
            </button>
          </div>
        </div>
        <div className="px-[22px] py-5">
          {hist.length === 0 ? (
            <p className="py-5 text-center text-[13.5px] text-ff-muted">
              Все още няма събития по проследяването.
            </p>
          ) : (
            <div className="flex flex-col">
              {hist.map((h, i) => {
                const last = i === hist.length - 1;
                return (
                  <div key={i} className="flex gap-3.5">
                    <div className="flex flex-col items-center">
                      <span
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 rounded-full border-2',
                          last
                            ? 'border-ff-green-600 bg-ff-green-600'
                            : 'border-ff-muted-2 bg-ff-green-100',
                        )}
                      />
                      {!last && <span className="my-0.5 w-0.5 flex-1 bg-ff-border" style={{ minHeight: 26 }} />}
                    </div>
                    <div className={last ? 'pb-0' : 'pb-[18px]'}>
                      <div
                        className={cn(
                          'text-[14px] font-bold',
                          last ? 'text-ff-green-800' : 'text-ff-ink',
                        )}
                      >
                        {h.label}
                      </div>
                      {h.location && <div className="mt-px text-[12.5px] text-ff-ink-2">{h.location}</div>}
                      <div className="mt-0.5 text-[12px] text-ff-muted">{h.at}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
