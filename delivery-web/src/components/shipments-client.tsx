'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { RefreshCw, FileDown, Package, Upload, FilePlus, Truck, CheckCircle2, Info, ChevronDown, SlidersHorizontal, Layers } from 'lucide-react';
import {
  ApiError, listEcontShipments, listSpeedyShipments, refreshShipment, downloadLabel,
  finalizeCourierDraft, requestCourier, carrierTrackUrl,
  listConsolidationSuggestions,
  type ShipmentRow, type ShipmentStatus, type Carrier, type DraftOverrides, type ConsolidationSuggestion,
} from '@/lib/api-client';
import { SenderStrip } from './sender-strip';
import { ConsolidationModal } from './consolidation-modal';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const STATUS_LABEL: Record<ShipmentStatus, string> = {
  pending: 'Чакаща',
  created: 'Създадена',
  shipped: 'Изпратена',
  delivered: 'Доставена',
  returned: 'Върната',
  refused: 'Отказана',
  consolidated: 'Обединена',
};

// created/shipped used to share the same amber tone and were hard to tell apart
// at a glance — 'shipped' (in transit, nothing to do) now gets a one-off blue,
// distinct from 'created' (still amber — waiting on a handover action).
// delivered = green; returned/refused = red.
const statusPill = (s: ShipmentStatus): string => {
  switch (s) {
    case 'delivered': return 'bg-ff-green-50 text-ff-green-700';
    case 'shipped': return 'bg-[#E3EAFB] text-[#3355BB]';
    case 'created': return 'bg-ff-amber-soft text-ff-amber-600';
    case 'returned':
    case 'refused': return 'bg-[#FBE9E7] text-ff-red';
    // Superseded by a consolidation master — no waybill of its own ever gets created,
    // so it reads as neither good nor bad, just inert; same neutral badge token as the
    // "Общо" total chip, not one of the active-status colors above.
    case 'consolidated':
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
const money = (st: number | null | undefined) => (st == null ? '—' : `${(st / 100).toFixed(2)} €`);

// A courier DRAFT: an order-backed row with no waybill yet (the farmer must pick a
// carrier and create the товарителница). Finalized rows have a trackingNumber; order-less
// manual rows have no orderId, so neither is offered the picker. A 'consolidated' child
// also has no trackingNumber (its own waybill will never be created — it's folded into
// the collector's master shipment), so it must be excluded explicitly here or it would
// wrongly offer the "Създай товарителница" CTA for a row that can't take that action.
const isCourierDraft = (r: ShipmentRow): r is ShipmentRow & { orderId: string } =>
  !r.trackingNumber && !!r.orderId && r.status !== 'consolidated';

// A row whose courier pickup has already been requested — show the badge, never re-offer.
const courierRequested = (r: ShipmentRow) => !!r.courierRequestStatus;

// A finalized waybill that is ready to hand over and hasn't been picked up / closed yet.
// These are the rows eligible for a courier-pickup request (or for the farmer to drop off
// at an office themselves). Drafts, already-requested rows, and finished/problem rows opt out.
const isShippable = (r: ShipmentRow): r is ShipmentRow & { shipmentId: string } =>
  !!r.shipmentId && !!r.trackingNumber && !courierRequested(r) &&
  !['delivered', 'returned', 'refused'].includes(r.status);

export function ShipmentsClient() {
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Per-draft chosen carrier (keyed by rowKey); defaults to Econt when unset.
  const [draftCarrier, setDraftCarrier] = useState<Record<string, Carrier>>({});
  // Which draft rows have their „Детайли на пратката" editor open (keyed by rowKey).
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());
  // Per-draft package overrides, held as raw input strings (parsed at create time).
  const [details, setDetails] = useState<Record<string, { weightKg?: string; contents?: string; parcelCount?: string; declaredValueEur?: string; returnReceipt?: boolean }>>({});

  const toggleDetails = (rowKey: string) =>
    setOpenDetails((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
      return next;
    });
  const setDetail = (rowKey: string, k: 'weightKg' | 'contents' | 'parcelCount' | 'declaredValueEur', v: string) =>
    setDetails((m) => ({ ...m, [rowKey]: { ...m[rowKey], [k]: v } }));
  const setReturnReceipt = (rowKey: string, v: boolean) =>
    setDetails((m) => ({ ...m, [rowKey]: { ...m[rowKey], returnReceipt: v } }));
  // Rows the farmer has ticked for a batched courier pickup (keyed by rowKey).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [requesting, setRequesting] = useState(false);
  // Multi-farmer consolidation suggestions (admin-only server flag) + the one
  // currently open in the merge modal, if any.
  const [suggestions, setSuggestions] = useState<ConsolidationSuggestion[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState<ConsolidationSuggestion | null>(null);
  // The handover tip starts collapsed (matches SSR), then auto-opens on a farmer's first
  // visit only — so a newcomer reads the print-vs-courier choice, but a returning farmer
  // isn't re-nagged. Marked seen the moment it auto-opens.
  const tipRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    try {
      if (localStorage.getItem('ff-delivery-handover-tip-seen') !== '1') {
        if (tipRef.current) tipRef.current.open = true;
        localStorage.setItem('ff-delivery-handover-tip-seen', '1');
      }
    } catch { /* ignore (private mode) */ }
  }, []);

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
    setSelected(new Set()); // a fresh list invalidates the old selection
    setLoading(false);
  }, []);

  // Consolidation suggestions are an optional, admin-only add-on to the shipments
  // list — fetched separately from `load` so a failure (feature disabled, non-admin)
  // never blocks or errors the main table. Fails silently to an empty list.
  const loadSuggestions = useCallback(() => {
    listConsolidationSuggestions().then(setSuggestions).catch(() => setSuggestions([]));
  }, []);

  useEffect(() => { void load(); loadSuggestions(); }, [load, loadSuggestions]);

  // Rows the farmer can request a pickup for, and the live selection over them.
  const shippable = useMemo(() => rows.filter(isShippable), [rows]);
  const selectedRows = useMemo(() => shippable.filter((r) => selected.has(r.rowKey)), [shippable, selected]);
  const allSelected = shippable.length > 0 && selectedRows.length === shippable.length;

  // Group by what the farmer needs to DO with the row: drafts need a waybill
  // first; everything else already has one. A mixed table with 3 different
  // action-sets in one list reads as noise — sort drafts to the top and label
  // the two sections so it's obvious why row A has different buttons than row B.
  // `filter` preserves within-group order, so this is a stable partition.
  const sortedRows = useMemo(() => {
    const drafts = rows.filter(isCourierDraft);
    const rest = rows.filter((r) => !isCourierDraft(r));
    return [...drafts, ...rest];
  }, [rows]);
  const draftCount = useMemo(() => rows.filter(isCourierDraft).length, [rows]);
  const showSectionHeaders = draftCount > 0 && draftCount < rows.length;

  const toggleRow = (rowKey: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => (prev.size === shippable.length ? new Set() : new Set(shippable.map((r) => r.rowKey))));

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

  // Turn the row's raw detail inputs into a clean overrides payload (empty → undefined,
  // so an untouched draft sends nothing and the backend uses the farm defaults).
  function overridesFor(rowKey: string): DraftOverrides {
    const d = details[rowKey] ?? {};
    const out: DraftOverrides = {};
    const w = parseFloat(d.weightKg ?? '');
    if (Number.isFinite(w) && w > 0) out.weightKg = w;
    if (d.contents?.trim()) out.contents = d.contents.trim();
    const p = parseInt(d.parcelCount ?? '', 10);
    if (Number.isFinite(p) && p > 1) out.parcelCount = p;
    const v = parseFloat(d.declaredValueEur ?? '');
    if (Number.isFinite(v) && v > 0) out.declaredValueStotinki = Math.round(v * 100);
    // Обратна разписка — only meaningful (and only sent) when Speedy is the chosen carrier.
    if (d.returnReceipt && (draftCarrier[rowKey] ?? 'econt') === 'speedy') out.returnReceipt = true;
    return out;
  }

  // Finalize a courier draft into a real waybill with the farmer's chosen carrier +
  // any per-shipment overrides (weight / contents / parcels / insurance).
  async function createWaybill(r: ShipmentRow & { orderId: string }) {
    const carrier = draftCarrier[r.rowKey] ?? 'econt';
    setBusyKey(r.rowKey);
    try {
      await finalizeCourierDraft(carrier, r.orderId, overridesFor(r.rowKey));
      toast.success('Товарителницата е създадена');
      await load(); // row flips to a finalized waybill (number + label PDF).
    } catch (e) { toast.error(errMsg(e)); } finally { setBusyKey(null); }
  }

  // Request a courier to collect the ticked waybills. The pickup endpoint is per-carrier,
  // so split the selection by carrier and fire one request each; report per carrier so a
  // partial failure (e.g. one carrier not activated) still confirms the other.
  async function requestPickup() {
    if (selectedRows.length === 0) return;
    const byCarrier = new Map<Carrier, string[]>();
    for (const r of selectedRows) {
      if (!r.shipmentId) continue;
      byCarrier.set(r.carrier, [...(byCarrier.get(r.carrier) ?? []), r.shipmentId]);
    }
    setRequesting(true);
    try {
      const results = await Promise.allSettled(
        [...byCarrier.entries()].map(([carrier, ids]) =>
          requestCourier(carrier, ids).then(() => ({ carrier, count: ids.length })),
        ),
      );
      let ok = 0;
      for (const res of results) {
        if (res.status === 'fulfilled') { ok += res.value.count; }
        else { toast.error(errMsg(res.reason)); }
      }
      if (ok > 0) toast.success(`Заявен куриер за ${ok} ${ok === 1 ? 'пратка' : 'пратки'}`);
      await load(); // requested rows come back with a courierRequestStatus → badge, out of selection.
    } finally { setRequesting(false); }
  }

  const btn = 'inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-2.5 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2 disabled:opacity-50';
  // The "Създай товарителница" CTA — green, matching the page's primary action style.
  const ctaBtn = 'inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-ff-green-700 px-2.5 text-[12.5px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-50';
  const carrierSelect = 'h-10 rounded-lg border border-ff-border bg-ff-surface px-2 text-[12.5px] font-bold text-ff-ink-2';

  const total = rows.length;
  const by = (s: ShipmentStatus) => rows.filter((r) => r.status === s).length;
  const summary = [
    { label: 'Общо', n: total, cls: 'bg-ff-badge-bg text-ff-badge-ink' },
    { label: 'Доставени', n: by('delivered'), cls: 'bg-ff-green-50 text-ff-green-700' },
    { label: 'Изпратени', n: by('shipped'), cls: 'bg-[#E3EAFB] text-[#3355BB]' },
    { label: 'Създадени', n: by('created') + by('pending'), cls: 'bg-ff-amber-soft text-ff-amber-600' },
    { label: 'Проблемни', n: by('returned') + by('refused'), cls: 'bg-[#FBE9E7] text-ff-red' },
  ];

  // Reusable carrier picker for a draft row (controlled via draftCarrier state).
  const CarrierPicker = ({ r, className }: { r: ShipmentRow; className?: string }) => (
    <select
      aria-label="Куриер за товарителницата"
      value={draftCarrier[r.rowKey] ?? 'econt'}
      disabled={busyKey === r.rowKey}
      onChange={(e) => setDraftCarrier((m) => ({ ...m, [r.rowKey]: e.target.value as Carrier }))}
      className={`${carrierSelect} ${className ?? ''}`}
    >
      <option value="econt">Econt</option>
      <option value="speedy">Speedy</option>
    </select>
  );

  // Waybill number that links to the carrier's public tracking page (same link the
  // buyer gets by email). Drafts have no number yet → plain dash.
  const TrackingLink = ({ r }: { r: ShipmentRow }) =>
    r.trackingNumber ? (
      <a
        href={carrierTrackUrl(r.carrier, r.trackingNumber)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-ff-green-700 hover:underline"
        title="Проследи пратката при куриера"
      >
        {r.trackingNumber}
      </a>
    ) : (
      <>—</>
    );

  // The „Куриер заявен" badge shown once a pickup has been requested for a row.
  const RequestedPill = () => (
    <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-50 px-2.5 py-1 text-[12px] font-bold text-ff-green-700">
      <CheckCircle2 size={13} /> Куриер заявен
    </span>
  );

  const Checkbox = ({ r, className }: { r: ShipmentRow; className?: string }) => (
    <input
      type="checkbox"
      aria-label="Избери за заявка на куриер"
      checked={selected.has(r.rowKey)}
      onChange={() => toggleRow(r.rowKey)}
      className={`h-4 w-4 shrink-0 cursor-pointer accent-ff-green-700 ${className ?? ''}`}
    />
  );

  const detailInput = 'h-9 w-full rounded-lg border border-ff-border bg-ff-surface px-2.5 text-[13px] font-semibold text-ff-ink outline-none focus:border-ff-green-500 disabled:opacity-50';

  // Per-shipment package editor for a draft. Each field carries a one-line hint so the
  // farmer knows exactly what it controls; an empty field = the farm's saved default.
  const DraftDetails = ({ r }: { r: ShipmentRow }) => {
    const d = details[r.rowKey] ?? {};
    const Field = ({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) => (
      <label className="flex flex-col gap-1">
        <span className="text-[12.5px] font-bold text-ff-ink">{label}</span>
        {children}
        <span className="text-[11px] leading-snug text-ff-muted">{hint}</span>
      </label>
    );
    return (
      <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
        <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] font-bold text-ff-ink-2">
          <SlidersHorizontal size={14} className="text-ff-green-700" /> Детайли на пратката
          <span className="font-semibold text-ff-muted">· празно поле = по подразбиране от фермата</span>
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Тегло (кг)" hint="Колко тежи пратката. Влияе на цената при куриера — грешно тегло = грешна сметка или отказ.">
            <input type="number" min="0" step="0.1" inputMode="decimal" placeholder="напр. 2" value={d.weightKg ?? ''} disabled={busyKey === r.rowKey} onChange={(e) => setDetail(r.rowKey, 'weightKg', e.target.value)} className={detailInput} />
          </Field>
          <Field label="Брой колети" hint="На колко отделни кашона е разделена пратката. По подразбиране 1.">
            <input type="number" min="1" step="1" inputMode="numeric" placeholder="1" value={d.parcelCount ?? ''} disabled={busyKey === r.rowKey} onChange={(e) => setDetail(r.rowKey, 'parcelCount', e.target.value)} className={detailInput} />
          </Field>
          <Field label="Съдържание" hint="Какво има вътре — напр. мед, буркани. Изписва се на товарителницата.">
            <input type="text" maxLength={100} placeholder="напр. мед, буркани" value={d.contents ?? ''} disabled={busyKey === r.rowKey} onChange={(e) => setDetail(r.rowKey, 'contents', e.target.value)} className={detailInput} />
          </Field>
          <Field label="Обявена стойност (€)" hint="Застрахова пратката за тази сума при щета или загуба. Празно = без застраховка.">
            <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="без" value={d.declaredValueEur ?? ''} disabled={busyKey === r.rowKey} onChange={(e) => setDetail(r.rowKey, 'declaredValueEur', e.target.value)} className={detailInput} />
          </Field>
        </div>
        {/* Обратна разписка — Speedy-only service (verified live); shown only when Speedy is
            the chosen carrier so it never appears as a no-op for an Econt draft. */}
        {(draftCarrier[r.rowKey] ?? 'econt') === 'speedy' && (
          <label className="mt-3.5 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={d.returnReceipt ?? false}
              disabled={busyKey === r.rowKey}
              onChange={(e) => setReturnReceipt(r.rowKey, e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-ff-green-700"
            />
            <span>
              <span className="text-[12.5px] font-bold text-ff-ink">Обратна разписка</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-ff-muted">
                Клиентът подписва разписка при доставка и тя се връща при теб — доказателство, че е получено.
              </span>
            </span>
          </label>
        )}
      </div>
    );
  };

  // Compact toggle that opens the per-shipment details editor on a draft row.
  const DetailsToggle = ({ r, full }: { r: ShipmentRow; full?: boolean }) => (
    <button
      onClick={() => toggleDetails(r.rowKey)}
      disabled={busyKey === r.rowKey}
      aria-expanded={openDetails.has(r.rowKey)}
      title="Детайли на пратката (тегло, колети, застраховка)"
      className={btn + (full ? ' h-11' : '')}
    >
      <SlidersHorizontal size={14} /> <span className={full ? '' : 'max-xl:hidden'}>Детайли</span>
    </button>
  );

  // Section divider between drafts ("need a waybill") and finalized rows
  // ("already have one") — only shown when the table actually mixes both,
  // otherwise it's a redundant single label above an unbroken list.
  const SectionHeader = ({ kind }: { kind: 'draft' | 'final' }) => {
    const n = kind === 'draft' ? draftCount : rows.length - draftCount;
    const label = kind === 'draft' ? `Чакат товарителница (${n})` : `Готови пратки (${n})`;
    const Icon = kind === 'draft' ? FilePlus : CheckCircle2;
    return (
      <div className="mt-4 mb-1.5 flex items-center gap-2 px-1 first:mt-0">
        <Icon size={14} className="text-ff-green-700" />
        <span className="text-[12px] font-extrabold uppercase tracking-[0.03em] text-ff-muted">{label}</span>
      </div>
    );
  };

  return (
    <div className="animate-ff-fade-up pb-24">
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

      {/* How to hand over a parcel — the farmer's choice, in plain words. Collapsed by
          default so it doesn't crowd the table once they know it. */}
      <details ref={tipRef} className="group mt-4 rounded-xl border border-ff-green-100 bg-ff-green-50 px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 [&::-webkit-details-marker]:hidden">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ff-green-100 text-ff-green-700">
            <Truck size={15} />
          </span>
          <span className="text-[13.5px] font-extrabold text-ff-ink">Как да предадеш готовите пратки?</span>
          <ChevronDown size={16} className="ml-auto shrink-0 text-ff-green-700 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          <div className="rounded-lg border border-ff-green-100 bg-ff-surface px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[13px] font-bold text-ff-ink">
              <FileDown size={14} className="text-ff-green-700" /> Принтирам и занасям
            </div>
            <p className="mt-1 text-[12.5px] leading-snug text-ff-ink-2">
              Сваляш етикета, лепиш го на кашона и сам го носиш до офис на куриера (или го даваш на минаващ куриер). Без чакане.
            </p>
          </div>
          <div className="rounded-lg border border-ff-green-100 bg-ff-surface px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[13px] font-bold text-ff-ink">
              <Truck size={14} className="text-ff-green-700" /> Куриер идва да вземе
            </div>
            <p className="mt-1 text-[12.5px] leading-snug text-ff-ink-2">
              Маркираш готовите пратки и заявяваш куриер да мине и да ги вземе наведнъж — не ставаш от фермата.
            </p>
          </div>
        </div>
        <div className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-snug text-ff-ink-2">
          <Info size={13} className="mt-px shrink-0 text-ff-green-700" />
          <span>
            Кое е по-изгодно — зависи от теб и деня. При 1–2 пратки често е по-бързо да отскочиш до офиса, особено ако бездруго минаваш натам.
            Съберат ли се повече (горе-долу от 3–4 нагоре) или офисът е далеч, заявката за куриер обикновено си струва. Решаваш ти за всяка партида.
          </span>
        </div>
      </details>

      {/* Consolidation suggestions — same-address orders from ≥2 farmers, waiting on a
          single courier draft each. Only appears when the server flag is on and there's
          something to merge; clicking opens the collector/carrier picker modal. */}
      {suggestions.length > 0 && (
        <div className="mt-4 space-y-2">
          {suggestions.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-3 rounded-xl border border-ff-green-100 bg-ff-green-50 px-3.5 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ff-green-100 text-ff-green-700">
                  <Layers size={15} />
                </span>
                <div className="min-w-0 text-[13px]">
                  <div className="font-bold text-ff-ink">Обедини {s.members.length} пратки → 1 товарителница</div>
                  <div className="truncate text-ff-muted">{s.customerName ?? 'Клиент'} · {s.deliveryCity ?? '—'} · {s.deliveryAddress ?? '—'}</div>
                </div>
              </div>
              <button type="button" onClick={() => setActiveSuggestion(s)} className={ctaBtn + ' shrink-0'} title="Обедини в 1 товарителница">
                <Layers size={14} /> Обедини
              </button>
            </div>
          ))}
        </div>
      )}

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
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Избери всички готови за куриер"
                      checked={allSelected}
                      disabled={shippable.length === 0}
                      onChange={toggleAll}
                      className="h-4 w-4 cursor-pointer accent-ff-green-700 disabled:opacity-40"
                    />
                  </th>
                  {['Получател', 'Куриер', 'Метод', 'Статус', 'Товарителница', 'НП (ст.)', 'Цена (ст.)', ''].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r, i) => {
                  const draft = isCourierDraft(r);
                  const canShip = isShippable(r);
                  return (
                    <Fragment key={r.rowKey}>
                    {showSectionHeaders && i === 0 && (
                      <tr><td colSpan={9} className="border-b border-ff-border-2 px-3 pt-3 pb-1"><SectionHeader kind="draft" /></td></tr>
                    )}
                    {showSectionHeaders && i === draftCount && (
                      <tr><td colSpan={9} className="border-b border-ff-border-2 px-3 pt-3 pb-1"><SectionHeader kind="final" /></td></tr>
                    )}
                    <tr className="border-b border-ff-border-2 last:border-0">
                      <td className="px-3 py-2.5">{canShip ? <Checkbox r={r} /> : null}</td>
                      <td className="px-3 py-2.5 font-semibold text-ff-ink">{r.receiver || '—'}</td>
                      {/* For a draft the carrier isn't decided yet → show a dash, not a carrier name. */}
                      <td className="px-3 py-2.5 text-ff-ink-2">{draft ? '—' : carrierLabel(r.carrier)}</td>
                      <td className="px-3 py-2.5 text-ff-ink-2">{r.method ?? '—'}</td>
                      <td className="px-3 py-2.5"><StatusPill s={r.status} /></td>
                      <td className="px-3 py-2.5 ff-fig text-ff-ink-2"><TrackingLink r={r} /></td>
                      <td className="px-3 py-2.5 ff-fig text-ff-ink-2">{money(r.codAmountStotinki)}</td>
                      <td className="px-3 py-2.5 ff-fig text-ff-ink-2">{money(r.priceStotinki)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {draft ? (
                            <>
                              <CarrierPicker r={r} />
                              <DetailsToggle r={r} />
                              <button onClick={() => createWaybill(r)} disabled={busyKey === r.rowKey} className={ctaBtn} title="Създай товарителница">
                                <FilePlus size={14} /> Създай товарителница
                              </button>
                            </>
                          ) : (
                            <>
                              {courierRequested(r) && <RequestedPill />}
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
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {draft && openDetails.has(r.rowKey) && (
                      <tr className="border-b border-ff-border-2 last:border-0">
                        <td colSpan={9} className="px-3 pb-3.5 pt-0">
                          <DraftDetails r={r} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* mobile cards */}
          <div className="mt-4 hidden flex-col gap-3 max-[900px]:flex">
            {sortedRows.map((r, i) => {
              const draft = isCourierDraft(r);
              const canShip = isShippable(r);
              return (
                <Fragment key={r.rowKey}>
                {showSectionHeaders && i === 0 && <SectionHeader kind="draft" />}
                {showSectionHeaders && i === draftCount && <SectionHeader kind="final" />}
                <div className="rounded-xl border border-ff-border bg-ff-surface p-3.5 shadow-ff-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2.5">
                      {canShip && <Checkbox r={r} className="mt-1" />}
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-bold text-ff-ink">{r.receiver || '—'}</div>
                        <div className="mt-0.5 text-[12.5px] font-semibold text-ff-muted">{(draft ? '—' : carrierLabel(r.carrier))} · {r.method ?? '—'}</div>
                      </div>
                    </div>
                    <StatusPill s={r.status} />
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-[13px]">
                    <dt className="text-ff-muted">Товарителница</dt>
                    <dd className="ff-fig text-right text-ff-ink-2"><TrackingLink r={r} /></dd>
                    <dt className="text-ff-muted">НП</dt>
                    <dd className="ff-fig text-right text-ff-ink-2">{money(r.codAmountStotinki)}</dd>
                    <dt className="text-ff-muted">Цена</dt>
                    <dd className="ff-fig text-right text-ff-ink-2">{money(r.priceStotinki)}</dd>
                  </dl>
                  {draft ? (
                    <>
                      <div className="mt-3 flex gap-2">
                        <CarrierPicker r={r} className="h-11" />
                        <DetailsToggle r={r} full />
                      </div>
                      {openDetails.has(r.rowKey) && <div className="mt-3"><DraftDetails r={r} /></div>}
                      <button onClick={() => createWaybill(r)} disabled={busyKey === r.rowKey} className={ctaBtn + ' mt-3 h-11 w-full'}>
                        <FilePlus size={15} /> Създай товарителница
                      </button>
                    </>
                  ) : r.shipmentId ? (
                    <>
                      {courierRequested(r) && <div className="mt-3"><RequestedPill /></div>}
                      <div className="mt-3 flex gap-2">
                        <button onClick={() => refresh(r)} disabled={busyKey === r.rowKey} className={btn + ' h-11 flex-1'}>
                          <RefreshCw size={15} className={busyKey === r.rowKey ? 'animate-spin' : ''} /> Опресни
                        </button>
                        <button onClick={() => label(r)} disabled={busyKey === r.rowKey} className={btn + ' h-11 flex-1'}>
                          <FileDown size={15} /> Етикет
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
                </Fragment>
              );
            })}
          </div>
        </>
      )}

      {/* Sticky pickup bar — appears only while rows are ticked. Keeps the courier action
          one tap away no matter how far the farmer has scrolled. */}
      {selectedRows.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ff-border bg-ff-surface/95 px-4 py-3 shadow-ff-lg backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13.5px] font-extrabold text-ff-ink">
                {selectedRows.length} {selectedRows.length === 1 ? 'избрана пратка' : 'избрани пратки'}
              </div>
              <div className="truncate text-[12px] text-ff-muted">Куриерът ще мине и ще ги вземе от адреса ти.</div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setSelected(new Set())} disabled={requesting} className={btn + ' h-11'}>
                Откажи
              </button>
              <button onClick={requestPickup} disabled={requesting} className={ctaBtn + ' h-11 px-4'}>
                <Truck size={16} /> {requesting ? 'Заявявам…' : 'Заяви куриер да вземе'}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeSuggestion && (
        <ConsolidationModal
          suggestion={activeSuggestion}
          onClose={() => setActiveSuggestion(null)}
          onDone={() => {
            setActiveSuggestion(null);
            loadSuggestions();
            void load(); // re-fetch shipments: master row's COD is summed, children flip to 'consolidated'.
          }}
        />
      )}
    </div>
  );
}
