'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarDays,
  ChevronDown,
  Navigation,
  CheckCircle2,
  Home,
  Flag,
  HelpCircle,
  Settings,
  AlertTriangle,
  ArrowUpDown,
  Wand2,
  X,
  ClipboardList,
  PackageCheck,
  Clock,
  PlusCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getOrder,
  measureRoute,
  setOrderCourier,
  setOrderSequence,
  updateOrderStatus,
  updateTenant,
} from '@/lib/api-client';
import type { MultiRouteResult, CourierRoute, RouteStop, RouteEndMode } from '@/lib/types';
import type { Order } from '@/lib/types';
import type { OrderStatus } from '@/lib/utils';
import { moneyFromStotinki } from '@/lib/utils';
import { OrderPanel } from '@/components/orders/order-panel';
import { useRole } from '@/components/layout/role-context';
import { nextUnfinishedId } from './route-finish';
import { StopList } from './stop-list';
import { EditAddressModal } from './edit-address-modal';
import { RouteMap, ROUTE_COLORS } from './route-map';
import { LocationRouteCard } from './location-route-card';
import { isMajorRoadAddress } from './major-road';
import { WazeStepper } from './waze-stepper';
import { buildWazeTargets, wazeUrl } from './waze';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { reconcileOrder } from './route-order';
import { ReorderStopsModal } from './reorder-stops-modal';
import { RouteDaySuggesterModal } from './route-day-suggester-modal';
import { CourierHomesModal } from './courier-homes-modal';
import { DeliveryWindowsModal } from './delivery-windows-modal';
import { AddOrdersModal } from './add-orders-modal';

// Re-exported so callers only need to import from one place.
export { ROUTE_COLORS };

const cn = (...c: (string | false)[]) => c.filter(Boolean).join(' ');

const END_OPTIONS: { mode: RouteEndMode; label: string; Icon: typeof Home; hint: string }[] = [
  { mode: 'home', label: 'Към дома', Icon: Home, hint: 'След последната доставка се връщаш до базата.' },
  { mode: 'last', label: 'Край при клиента', Icon: Flag, hint: 'Маршрутът свършва при последната доставка — без връщане до базата.' },
];

// Google Maps consumer dir links cap waypoints PER PLATFORM: up to 9 on desktop
// browsers but only 3 on mobile browsers (per Google's Maps URLs docs). Farmers
// are mostly on phones, so detect mobile and split into more, smaller chained
// legs there — otherwise the device silently drops every waypoint past the 3rd.
const WAYPOINTS_PER_LEG_DESKTOP = 9;
const WAYPOINTS_PER_LEG_MOBILE = 3;

const isMobileBrowser = () =>
  typeof navigator !== 'undefined' &&
  /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(navigator.userAgent);

/** Nodes per Google Maps directions leg = origin + N waypoints + destination. */
const nodesPerLeg = () =>
  (isMobileBrowser() ? WAYPOINTS_PER_LEG_MOBILE : WAYPOINTS_PER_LEG_DESKTOP) + 2;

type Point = { address: string | null; lat: number | null; lng: number | null };

/** Coordinate string when geocoded, else the address (URLSearchParams encodes it). */
const pt = (p: Point) => (p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : p.address ?? '');

/** Build one Google Maps directions URL for a sequence of nodes (origin → … → destination). */
function legUrl(nodes: Point[]): string {
  const params = new URLSearchParams({ api: '1', travelmode: 'driving' });
  const o = pt(nodes[0]);
  if (o) params.set('origin', o);
  params.set('destination', pt(nodes[nodes.length - 1]));
  let url = `https://www.google.com/maps/dir/?${params.toString()}`;
  const mids = nodes.slice(1, -1).map(pt).filter(Boolean);
  if (mids.length) url += `&waypoints=${mids.map(encodeURIComponent).join('|')}`;
  return url;
}

/** Farm → stops as one or more chained Google Maps legs (≤9 waypoints each). */
function dirUrls(origin: Point, stops: RouteStop[], end: Point | null): string[] {
  if (!stops.length) return [];
  const perLeg = nodesPerLeg(); // 11 on desktop, 5 on mobile
  const points: Point[] = [origin, ...stops];
  if (end && (end.lat != null || end.address)) points.push(end);
  const urls: string[] = [];
  let i = 0;
  while (i < points.length - 1) {
    const seg = points.slice(i, i + perLeg);
    urls.push(legUrl(seg));
    i += seg.length - 1; // each leg's destination is the next leg's origin
  }
  return urls;
}

function stopUrl(origin: Point, s: RouteStop): string {
  const params = new URLSearchParams({ api: '1', travelmode: 'driving', destination: pt(s) });
  const o = pt(origin);
  if (o) params.set('origin', o);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

const fmtDist = (m: number | null) => (m == null ? null : `${(m / 1000).toFixed(1).replace('.', ',')} км`);
function fmtDur(s: number | null): string | null {
  if (s == null) return null;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}

const EMPTY_ROUTE: CourierRoute = {
  stops: [],
  totalDistanceM: null,
  totalDurationS: null,
  optimized: false,
  polyline: null,
  endMode: 'home',
  endAddress: null,
  endLat: null,
  endLng: null,
  courierIndex: 0,
  name: null,
  itemsSubtotalStotinki: 0,
  deliveryFeeStotinki: 0,
  totalStotinki: 0,
};

export function RouteClient({
  route,
  dateLabel,
  loadError = false,
  mapsKey,
  placesKey,
}: {
  route: MultiRouteResult;
  dateLabel: string;
  /** The route fetch failed (server error / API down) — show an error banner
   *  instead of letting the empty list read as "no deliveries today". */
  loadError?: boolean;
  /** Map key (Maps JavaScript API) — runtime env, kept separate from `placesKey`. */
  mapsKey?: string;
  /** Autocomplete key (Places API New) — runtime env, isolated from `mapsKey`. */
  placesKey?: string;
}) {
  const router = useRouter();
  const { origin, end, routes } = route;
  // A driver only ever sees their own leg (server-filtered) — hide every
  // control that reconfigures the day/route/fleet, keep everything that
  // executes their own stops (finish/undo, navigate, order panel).
  const role = useRole();
  const isDriver = role === 'driver';

  // Which courier's leg is shown in the list/map/Waze — a plain tab index into
  // `routes`. Reset to the first tab whenever the day or courier count changes
  // (a new fetch means the previous tab may no longer correspond to the same leg).
  const [activeCourierIdx, setActiveCourierIdx] = useState(0);
  useEffect(() => {
    setActiveCourierIdx(0);
  }, [route.date, route.couriers]);

  const multi = routes.length > 1;
  const active: CourierRoute = routes[activeCourierIdx] ?? routes[0] ?? EMPTY_ROUTE;
  const { stops } = active;
  // Every stop across every courier — used for the "mark all delivered" bulk
  // action and the unlocated-address warning, both of which must cover the
  // whole day, not just whichever tab happens to be open.
  const allStops = useMemo(() => routes.flatMap((r) => r.stops), [routes]);

  // Per-courier end modes, in courier (tab) order; the active tab's own mode
  // drives the end toggle, the deep links, and the Waze return-home leg.
  const modes = routes.map((r) => r.endMode);
  const activeEndMode: RouteEndMode = modes[activeCourierIdx] ?? end.mode;

  const [activeId, setActiveId] = useState<string | null>(stops[0]?.id ?? null);
  // Bumped on every user stop-pick (list row or map pin) so the map pans+zooms
  // onto that pin. Kept separate from `setActiveId` so courier-switch / initial
  // selection (below) don't move the viewport.
  const [focusNonce, setFocusNonce] = useState(0);
  const pickStop = (id: string) => {
    setActiveId(id);
    setFocusNonce((n) => n + 1);
  };
  // Switching courier tabs (or loading a new day) selects that leg's first stop
  // so the map/list don't keep highlighting a pin that belongs to another courier.
  useEffect(() => {
    setActiveId(active.stops[0]?.id ?? null);
    setFinishedIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCourierIdx, route.date, route.couriers]);

  // ---- Manual delivery order override (per date + courier) ----
  // The server hands back an auto-optimized stop order (fewest km). A farmer who
  // knows the roads can override it — e.g. "deliver through Kavarna first, then
  // down to Varna". The chosen order is kept in localStorage (like the Waze
  // progress below) so it survives a reload, and reconciled against the server's
  // stop set on every fetch: kept for still-present stops, new stops appended in
  // server order, removed stops dropped. `null` = follow the server's auto order.
  const orderKey = `ff:order:${route.date}:${activeCourierIdx}`;
  const [manualIds, setManualIds] = useState<string[] | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`ff:order:${route.date}:${activeCourierIdx}`);
      setManualIds(raw ? (JSON.parse(raw) as string[]) : null);
    } catch {
      setManualIds(null);
    }
  }, [route.date, activeCourierIdx]);

  const orderedStops = useMemo(
    () => reconcileOrder(active.stops, manualIds),
    [active.stops, manualIds],
  );

  const isManualOrder = manualIds != null;

  // Per-order finish: ids marked delivered this session (drive the "next"
  // pointer, drop finished stops from the list/map, and shift the route's start).
  const [finishedIds, setFinishedIds] = useState<Set<string>>(new Set());
  // Stops still to visit — finished ones fall off the list, map, and Google Maps.
  const remainingStops = useMemo(
    () => orderedStops.filter((s) => !finishedIds.has(s.id)),
    [orderedStops, finishedIds],
  );
  // The most recently finished drop (last in visit order). Once en route the map
  // draws the remaining line from here instead of the farm — the courier is
  // physically at their last delivery, not back at base. Null until the first
  // finish, or when that drop has no coordinates (falls back to the farm).
  const lastFinishedStop = useMemo(() => {
    for (let i = orderedStops.length - 1; i >= 0; i--) {
      const s = orderedStops[i];
      if (finishedIds.has(s.id) && s.lat != null && s.lng != null) return s;
    }
    return null;
  }, [orderedStops, finishedIds]);

  // The phone's live position, once the courier is en route (has finished ≥1
  // drop). This is the real „where I am now" — same GPS start Google Maps/Waze
  // use — and, unlike the last-finished-stop fallback, it works even when that
  // stop had no coordinates. Re-requested on every finish (position moves as the
  // courier drives). Cleared back to null when nothing is finished.
  const [selfPos, setSelfPos] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (finishedIds.size === 0) {
      setSelfPos(null);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => setSelfPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {}, // denied / unavailable → the last-finished-stop fallback stands
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  }, [finishedIds]);

  // Where the remaining route line starts on the in-app map once en route: the
  // phone's real position if we have it, else the last finished drop, else null
  // (start from the farm, as before finishing anything).
  const mapStart: { lat: number | null; lng: number | null } | null =
    finishedIds.size === 0
      ? null
      : selfPos ?? (lastFinishedStop ? { lat: lastFinishedStop.lat, lng: lastFinishedStop.lng } : null);

  const persistOrder = (ids: string[]) => {
    setManualIds(ids);
    try {
      localStorage.setItem(orderKey, JSON.stringify(ids));
    } catch {
      /* localStorage unavailable (private mode) — order just won't persist */
    }
    // Best-effort: also persist server-side (route_seq) so slot generation
    // (delivery windows) honours this order too, not just this browser's
    // localStorage. Fire-and-forget — never blocks the UI, errors swallowed
    // (the localStorage copy above already drives this browser's display).
    void setOrderSequence({ date: route.date, courierIndex: activeCourierIdx, stopIds: ids }).catch(
      () => {},
    );
  };

  // Drop the override — fall back to the server's auto-optimized order.
  const resetOrder = () => {
    setManualIds(null);
    try {
      localStorage.removeItem(orderKey);
    } catch {
      /* ignore */
    }
    // Clear the server-side override too (empty stopIds = clear semantics).
    void setOrderSequence({ date: route.date, courierIndex: activeCourierIdx, stopIds: [] }).catch(
      () => {},
    );
  };

  // The compact reorder modal (single line per stop) — the full side-list cards
  // are too tall to reorder without heavy scrolling.
  const [showReorder, setShowReorder] = useState(false);
  // The multi-day suggester — spreads pending address orders across N days by
  // geography (a planning tool over ALL days, not just this leg).
  const [showDaySuggest, setShowDaySuggest] = useState(false);

  const [showHelp, setShowHelp] = useState(false);
  const [showLoc, setShowLoc] = useState(false);
  const [showHomes, setShowHomes] = useState(false);
  const [showWindows, setShowWindows] = useState(false);
  const [showAddOrders, setShowAddOrders] = useState(false);
  // The stop whose address is being edited (drives the „Смени адрес" modal).
  const [editStop, setEditStop] = useState<RouteStop | null>(null);
  // Remaining legs of a long (>9-waypoint) route — opened one-by-one on click so
  // each is a real user gesture (a burst of window.open() gets popup-blocked).
  const [extraLegs, setExtraLegs] = useState<string[]>([]);

  // Waze step-by-step navigator: which target is next, and whether the panel is
  // open. `wazeIdx` reaches `wazeTargets.length` when every stop is done.
  // Targets are always built from the ACTIVE courier's stops.
  const [showWaze, setShowWaze] = useState(false);
  const [wazeIdx, setWazeIdx] = useState(0);
  const wazeTargets = useMemo(
    () =>
      buildWazeTargets(
        orderedStops,
        activeEndMode === 'home'
          ? { mode: 'home', address: origin.address, lat: origin.lat, lng: origin.lng }
          : { mode: 'last', address: null, lat: null, lng: null },
        origin,
      ),
    [orderedStops, origin, activeEndMode],
  );

  // Restore Waze progress for THIS date AND courier (each courier walks their
  // own leg, so their progress pointers must not collide). Clamp to the
  // current target count.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`ff:waze:${route.date}:${activeCourierIdx}`);
      const n = raw == null ? 0 : parseInt(raw, 10);
      setWazeIdx(Number.isFinite(n) ? Math.min(Math.max(n, 0), wazeTargets.length) : 0);
    } catch {
      setWazeIdx(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.date, activeCourierIdx]);

  // Persist progress on every change.
  useEffect(() => {
    try {
      localStorage.setItem(`ff:waze:${route.date}:${activeCourierIdx}`, String(wazeIdx));
    } catch {
      /* localStorage unavailable (private mode) — progress just won't persist */
    }
  }, [wazeIdx, route.date, activeCourierIdx]);

  const dist = fmtDist(active.totalDistanceM);
  const dur = fmtDur(active.totalDurationS);
  // Day-wide delivery money across EVERY courier's leg — shown next to the
  // stop-count summary so the operator sees today's total without adding up
  // each tab by hand.
  const dayTotals = useMemo(
    () =>
      routes.reduce(
        (acc, r) => ({
          deliveryFeeStotinki: acc.deliveryFeeStotinki + r.deliveryFeeStotinki,
          totalStotinki: acc.totalStotinki + r.totalStotinki,
        }),
        { deliveryFeeStotinki: 0, totalStotinki: 0 },
      ),
    [routes],
  );
  // With one courier, the summary is that courier's own stats (as before). With
  // several, lead with the day-wide total — the per-courier distance/duration
  // is already visible on each tab below. Either way, append the day's money.
  const summary =
    (multi
      ? `${allStops.length} ${allStops.length === 1 ? 'спирка' : 'спирки'} общо · ${routes.length} куриера`
      : `${remainingStops.length} ${remainingStops.length === 1 ? 'спирка' : 'спирки'}${dist ? ` · ${dist}` : ''}${dur ? ` · ~${dur}` : ''}`) +
    ` · Оборот ${moneyFromStotinki(dayTotals.totalStotinki)} · Доставки ${moneyFromStotinki(dayTotals.deliveryFeeStotinki)}`;

  // Real road-following polyline for the operator's chosen order (task #5).
  // The server's own polyline was drawn for its own auto order — once the
  // farmer reorders manually or starts finishing stops, it no longer matches
  // the remaining sequence, so we ask the server to measure a fresh one for
  // the actual remaining order. `null` (loading / unavailable) falls back to
  // straight pin-to-pin segments in the map, same as before this fix.
  const [measuredPolyline, setMeasuredPolyline] = useState<string[] | null>(null);
  // Set when the last measure call came back with no usable polyline (quota /
  // API error / nothing to measure) or outright rejected — the map is about to
  // (or already did) fall back to straight pin-to-pin lines, silently, unless
  // this drives a visible warning. Cleared on a good measurement.
  const [routeApiFallback, setRouteApiFallback] = useState(false);
  // Stable signature of the ordered, geocoded remaining stops — recompute the
  // measured polyline only when this (or the mode/date/courier) actually changes.
  const remainingLocatedSig = remainingStops
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => s.id)
    .join(',');
  const needsMeasuredPolyline = isManualOrder || finishedIds.size > 0;
  useEffect(() => {
    if (!needsMeasuredPolyline) {
      setMeasuredPolyline(null);
      setRouteApiFallback(false);
      return;
    }
    const ids = remainingLocatedSig ? remainingLocatedSig.split(',') : [];
    if (!ids.length) {
      setMeasuredPolyline(null);
      setRouteApiFallback(false);
      return;
    }
    let cancelled = false;
    measureRoute({
      date: route.date,
      stopIds: ids,
      courierIndex: activeCourierIdx,
      endMode: activeEndMode,
      // Anchor the measured line to where the courier actually is (live GPS or
      // the last finished drop) once en route, instead of always the depot.
      startLat: mapStart?.lat ?? undefined,
      startLng: mapStart?.lng ?? undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setMeasuredPolyline(res.polyline);
        setRouteApiFallback(res.polyline == null);
      })
      .catch(() => {
        // ignore — leave the polyline as-is (straight-line fallback stands),
        // but surface that it's a fallback rather than silently swapping lines.
        if (!cancelled) setRouteApiFallback(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    remainingLocatedSig,
    isManualOrder,
    finishedIds.size > 0,
    activeCourierIdx,
    activeEndMode,
    route.date,
    mapStart?.lat,
    mapStart?.lng,
  ]);

  // Routes fed to the map: the active courier's leg reflects the (possibly
  // manual) order. Once the order is overridden OR any stop is finished, the
  // server's road geometry (drawn for the full farm→all-stops auto route) no
  // longer matches — swap in the freshly measured polyline for the actual
  // remaining order instead (briefly null = straight lines while it loads).
  const displayRoutes = useMemo(
    () =>
      routes.map((r, i) =>
        i === activeCourierIdx
          ? {
              ...r,
              stops: remainingStops,
              polyline: isManualOrder || finishedIds.size > 0 ? measuredPolyline : r.polyline,
            }
          : r,
      ),
    [routes, activeCourierIdx, remainingStops, isManualOrder, finishedIds, measuredPolyline],
  );

  // Where the van goes after the last delivery, for the Google Maps deep link
  // (null = end at last stop). Shared across all couriers.
  // Deep-link end for the ACTIVE courier: home → back to base, custom → saved end,
  // last → open route (no return leg).
  const endPoint: Point | null =
    activeEndMode === 'home' && (origin.lat != null || origin.address)
      ? { address: origin.address, lat: origin.lat, lng: origin.lng }
      : activeEndMode === 'custom' && (end.lat != null || end.address)
        ? { address: end.address, lat: end.lat, lng: end.lng }
        : null;

  // The end toggle applies to the ACTIVE courier only; the ends csv carries all.
  // The chosen mode is also saved as the tenant's default (fire-and-forget) so a
  // fresh visit reopens with it instead of resetting — the farmer doesn't have to
  // re-pick every time.
  const setCourierEnd = (mode: RouteEndMode) => {
    const next = routes.map((r, i) => (i === activeCourierIdx ? mode : r.endMode));
    router.push(`/route?date=${route.date}&couriers=${route.couriers}&ends=${next.join(',')}`);
    void updateTenant({ routing: { endMode: mode } }).catch(() => {});
  };
  // Changing courier count or date re-splits everyone, so prior per-leg ends no
  // longer map to the same legs — drop ?ends= but carry the active mode forward as
  // the new single default (?end=) so the choice isn't silently reset. The count is
  // also persisted as the tenant default (like the end mode above).
  const setCouriers = (n: number) => {
    router.push(`/route?date=${route.date}&end=${activeEndMode}&couriers=${n}`);
    void updateTenant({ routing: { courierCount: n } }).catch(() => {});
  };
  const setDate = (date: string) =>
    router.push(`/route?date=${date}&end=${activeEndMode}&couriers=${route.couriers}`);

  const endHint = END_OPTIONS.find((o) => o.mode === activeEndMode)?.hint ?? '';

  const openRoute = () => {
    // Once any stop is finished the courier is en route, not at the farm — omit
    // the origin so Google Maps navigates from the phone's live GPS. Before that
    // (planning the day) keep the farm as the start. Always route the REMAINING
    // stops only.
    const navOrigin: Point =
      finishedIds.size > 0 ? { address: null, lat: null, lng: null } : origin;
    const urls = dirUrls(navOrigin, remainingStops, endPoint);
    if (!urls.length) {
      toast.error('Няма спирки за маршрут');
      return;
    }
    // Open the first leg now (this click is the user gesture); queue the rest as
    // buttons so the browser doesn't block a burst of pop-ups.
    window.open(urls[0], '_blank', 'noopener');
    if (urls.length > 1) {
      setExtraLegs(urls.slice(1));
      toast.info(`Дълъг маршрут — ${urls.length} отсечки. Отвори всяка с бутоните долу.`);
    } else {
      setExtraLegs([]);
      toast.success('Маршрутът се отваря в Google Maps');
    }
  };

  // Open Waze for a single target and auto-advance the default to the next one.
  const wazeNavigate = (i: number) => {
    const url = wazeUrl(wazeTargets[i]);
    if (!url) {
      toast.error('Тази спирка не е на картата — провери адреса');
      return;
    }
    window.open(url, '_blank', 'noopener');
    setWazeIdx(Math.min(i + 1, wazeTargets.length));
  };
  const wazePrev = () => setWazeIdx((v) => Math.max(0, v - 1));
  const wazeNext = () => setWazeIdx((v) => Math.min(wazeTargets.length, v + 1));
  const wazeReset = () => setWazeIdx(0);

  // Bulk "finish the day" action: marks every stop's order as delivered, across
  // EVERY courier's leg — not just whichever tab is currently open.
  // Does not touch payment/COD fields — those are a separate, existing flow.
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishingOne, setFinishingOne] = useState(false);
  // Order side panel opened from the route card for the current stop.
  const [panelOrder, setPanelOrder] = useState<Order | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const finishDay = async () => {
    setFinishing(true);
    const results = await Promise.allSettled(
      allStops.map((s) => updateOrderStatus(s.id, 'delivered')),
    );
    setFinishing(false);
    setConfirmFinish(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === 0) {
      toast.success(`Всички ${allStops.length} спирки маркирани като доставени`);
    } else {
      toast.error(`${allStops.length - failed}/${allStops.length} маркирани, ${failed} неуспешни — опитай пак`);
    }
    router.refresh();
  };

  // The first stop not yet finished this session — drives the finish button's
  // target and disabled state. Recomputed each render from the current order.
  const currentFinishId = nextUnfinishedId(orderedStops, finishedIds);

  // Revert an accidental finish: flip the order back to confirmed, un-hide it,
  // and re-select it. Wired to the „Отмени" action on the finish toast.
  const undoFinish = async (stop: RouteStop) => {
    try {
      await updateOrderStatus(stop.id, 'confirmed');
      setFinishedIds((prev) => {
        const n = new Set(prev);
        n.delete(stop.id);
        return n;
      });
      setActiveId(stop.id);
      toast.success(`„${stop.customer ?? 'Клиент'}" върната в маршрута`, { position: 'top-right' });
    } catch {
      toast.error('Неуспешно връщане — опитай пак', { position: 'top-right' });
    }
  };

  // Mark the current (first unfinished) stop delivered and advance the highlight.
  // One click, no dialog — but a generous „Отмени" toast (top-right, 10s) makes an
  // accidental tap a one-touch revert. No router.refresh: the finished stop stays
  // hidden via `finishedIds`, and refreshing would drop the now-delivered order
  // from the list so „Отмени" couldn't bring it back.
  const finishCurrent = async () => {
    if (!currentFinishId) return;
    const cur = orderedStops.find((s) => s.id === currentFinishId);
    if (!cur) return;
    setFinishingOne(true);
    try {
      await updateOrderStatus(cur.id, 'delivered');
      const next = new Set(finishedIds).add(cur.id);
      setFinishedIds(next);
      const nextId = nextUnfinishedId(orderedStops, next);
      setActiveId(nextId ?? cur.id);
      // Count by live membership, not set size — a stop finished here can later
      // drop out of orderedStops via an unrelated refresh, leaving a stale id in
      // `next` that would otherwise undercount (or go negative).
      const remaining = orderedStops.filter((s) => !next.has(s.id)).length;
      // Top-right (per the request) + a generous 10s window so an accidental tap
      // is one „Отмени" away. The global Toaster stays bottom-right for the rest
      // of the app; sonner renders this one in its own top-right stack.
      toast.success(`Махнах „${cur.customer ?? 'Клиент'}"`, {
        description: remaining > 0 ? `Остават ${remaining}` : 'Всички завършени',
        duration: 10000,
        position: 'top-right',
        action: { label: 'Отмени', onClick: () => void undoFinish(cur) },
      });
    } catch {
      toast.error('Неуспешно маркиране — опитай пак');
    } finally {
      setFinishingOne(false);
    }
  };

  // Open the full order side panel for a stop (fetch the order first).
  const openStopPanel = async (stopId: string) => {
    setOpeningId(stopId);
    try {
      setPanelOrder(await getOrder(stopId));
    } catch {
      toast.error('Неуспешно зареждане на поръчката');
    } finally {
      setOpeningId(null);
    }
  };

  // Status action from inside the panel (Потвърди / Маркирай доставена / Откажи /
  // Промени статус) — updates the panel copy and refreshes the route.
  const panelAction = async (status: OrderStatus) => {
    if (!panelOrder) return;
    setPanelBusy(true);
    try {
      // `updateOrderStatus` hits PATCH /orders/:id/status, which returns the
      // raw updated row — no `items` (a separate table, never joined there).
      // Replacing panelOrder wholesale with that response drops `items` and
      // crashes the panel's money summary (`order.items.reduce(...)`).
      // Merge onto the known-good, items-complete order instead.
      const updated = await updateOrderStatus(panelOrder.id, status);
      setPanelOrder((prev) => (prev ? { ...prev, ...updated } : prev));
      toast.success('Статусът е обновен');
      router.refresh();
    } catch {
      toast.error('Неуспешна промяна на статуса');
    } finally {
      setPanelBusy(false);
    }
  };

  // Move an order to another courier's leg, or back to auto-split (task #6).
  // The route refetches on success, which re-runs the geographic split with the
  // pin honoured and recomputes each courier's stops/money.
  const moveCourier = async (stopId: string, idx: number | null) => {
    try {
      await setOrderCourier(stopId, idx);
      router.refresh();
      toast.success(idx === null ? 'Върнато на авто-разпределение' : 'Поръчката е преместена');
    } catch {
      toast.error('Неуспешна промяна на куриера');
    }
  };

  const onOpenMaps = (s: RouteStop) => {
    window.open(stopUrl(origin, s), '_blank', 'noopener');
  };
  const onCall = (s: RouteStop) => {
    if (!s.phone) {
      toast.error('Няма телефон за този клиент');
      return;
    }
    window.open(`tel:${s.phone.replace(/\s+/g, '')}`, '_self');
    toast.info(`Обаждане до ${s.customer ?? 'клиента'}…`);
  };
  const onEmail = (s: RouteStop) => {
    if (s.email) window.open(`mailto:${s.email}`, '_self');
  };

  // Stops whose address couldn't be geocoded — no map pin. They're still in the
  // list (nothing dropped), but the farmer must be told so a delivery isn't
  // silently missed just because it never showed up on the map. Checked across
  // every courier's leg, not just the active tab.
  const unlocated = allStops.filter((s) => s.lat == null || s.lng == null);

  // Located stops sitting on a major road (boulevard/trunk) — the farmer likely
  // wants to nudge the pin to a side street. Informational, across all couriers.
  const onMajorRoad = allStops.filter(
    (s) => s.lat != null && s.lng != null && isMajorRoadAddress(s.address),
  );

  // No base address yet — the route starts from the farm, so without it nothing
  // can be computed. Point the farmer straight at the location card.
  const noOrigin = !origin.address && origin.lat == null && origin.lng == null;

  // Force the base address before the route is usable — the whole feature starts
  // from it. Until it's set, show ONLY the setup card (with Places autocomplete)
  // instead of an empty map that reads as "no deliveries".
  if (noOrigin) {
    return <LocationRouteCard forced placesKey={placesKey} onSaved={() => router.refresh()} />;
  }

  return (
    <div className="animate-ff-fade-up">

      {/* route fetch failed — make it explicit; an empty list must not read as
          "no deliveries today" when the real cause is a server error */}
      {loadError && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5">
          <AlertTriangle size={16} className="text-ff-amber-600" />
          <span className="text-[12.5px] font-bold text-ff-amber-600">
            Маршрутът не можа да се зареди (грешка от сървъра). Това НЕ значи, че няма поръчки.
          </span>
          <button
            onClick={() => router.refresh()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[12.5px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2"
          >
            Опитай пак
          </button>
        </div>
      )}

      {/* guard: some addresses couldn't be placed on the map — they're still in
          the list, but have no pin. Tell the farmer so a stop isn't missed. */}
      {unlocated.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5">
          <AlertTriangle size={16} className="shrink-0 text-ff-amber-600" />
          <span className="text-[12.5px] font-bold text-ff-amber-600">
            {unlocated.length === 1
              ? '1 адрес не е намерен на картата'
              : `${unlocated.length} адреса не са намерени на картата`}{' '}
            — показани са в списъка, но без пин. Натисни иконата за адрес при спирката, за да ги поправиш.
          </span>
        </div>
      )}

      {/* guard: located stops on a big road — nudge to move the pin to a side
          street where the courier can actually stop. Informational only. */}
      {onMajorRoad.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5">
          <AlertTriangle size={16} className="shrink-0 text-ff-amber-600" />
          <span className="text-[12.5px] font-bold text-ff-amber-600">
            {onMajorRoad.length === 1
              ? '1 спирка е на голям път'
              : `${onMajorRoad.length} спирки са на голям път`}{' '}
            — при нужда премести пина на близка уличка (иконата за адрес при спирката).
          </span>
        </div>
      )}

      {/* summary + end-mode + couriers + date + help */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-ff-muted">{summary}</p>
        <div className="flex flex-wrap items-center gap-2">
          {/* end mode (+ its multi-day label) and courier count are day/fleet
              config, organizer-only — a driver's own leg always honours the
              server's default end mode, they just can't change it here */}
          {!isDriver && (
            <>
              {/* where the ACTIVE courier's van goes after its last delivery */}
              {multi && (
                <span className="text-[12px] font-bold text-ff-muted">
                  Край за Маршрут {activeCourierIdx + 1}:
                </span>
              )}
              <div className="flex items-center gap-1 rounded-xl border border-ff-border bg-ff-surface p-1 shadow-ff-sm">
                {END_OPTIONS.map(({ mode, label, Icon }) => (
                  <button
                    key={mode}
                    onClick={() => setCourierEnd(mode)}
                    title={label}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12.5px] font-bold transition',
                      activeEndMode === mode
                        ? 'bg-ff-green-100 text-ff-green-800'
                        : 'text-ff-ink-2 hover:bg-ff-surface-2',
                    )}
                  >
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>
              {/* how many people split today's deliveries */}
              <label className="flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3 py-2.5 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm">
                Куриери
                <select
                  value={route.couriers}
                  onChange={(e) => setCouriers(parseInt(e.target.value, 10))}
                  aria-label="Брой куриери"
                  className="rounded-md border border-ff-border bg-ff-surface-2 px-2 py-1 text-[13px] font-bold text-ff-ink outline-none"
                >
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="relative flex cursor-pointer items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm transition-colors hover:bg-ff-surface-2">
            <CalendarDays size={17} />
            <span className="capitalize">{dateLabel}</span>
            <ChevronDown size={16} className="text-ff-muted" />
            <input
              type="date"
              value={route.date}
              aria-label="Избери дата за маршрута"
              // The input is invisible (opacity-0) over a styled label, so its native
              // calendar icon is hidden too. On desktop a plain click only focuses the
              // field — the picker never opens — so the date button reads as dead. Force
              // the native picker open on click (user gesture); optional-chain for the
              // few browsers without showPicker (they still open on focus/keyboard).
              onClick={(e) => {
                try {
                  (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
                } catch {
                  /* showPicker can throw if not allowed — ignore, fall back to native */
                }
              }}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
          {/* day/fleet planning + config actions — organizer-only, not a
              driver executing their own leg */}
          {!isDriver && (
            <>
              <button
                onClick={() => setShowDaySuggest(true)}
                title="Разпредели поръчките по няколко дни спрямо района на клиентите"
                className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 py-2.5 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm transition hover:bg-ff-surface-2"
              >
                <Wand2 size={16} /> Предложи по дни
              </button>
              <button
                onClick={() => setShowAddOrders(true)}
                title="Премести поръчки от други дни към този маршрут"
                className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 py-2.5 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm transition hover:bg-ff-surface-2"
              >
                <PlusCircle size={16} /> Добави поръчки
              </button>
              <button
                onClick={() => setShowLoc((v) => !v)}
                title="Адрес на базата и край на маршрута"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-xl border px-3 py-2.5 text-[13px] font-bold shadow-ff-sm transition',
                  showLoc
                    ? 'border-ff-green-500 bg-ff-green-100 text-ff-green-800'
                    : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Settings size={16} /> Локация
              </button>
              <button
                onClick={() => setShowHomes(true)}
                title="Задай дом за всеки куриер (край на маршрута)"
                className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 py-2.5 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm transition hover:bg-ff-surface-2"
              >
                <Home size={16} /> Домове
              </button>
              <button
                onClick={() => setShowWindows(true)}
                title="Часове за доставка + известия до клиентите"
                className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 py-2.5 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm transition hover:bg-ff-surface-2"
              >
                <Clock size={16} /> Часове
              </button>
            </>
          )}
          <button
            onClick={() => setShowHelp((v) => !v)}
            title="Какво правят бутоните?"
            className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 py-2.5 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm transition hover:bg-ff-surface-2"
          >
            <HelpCircle size={16} /> Помощ
          </button>
        </div>
      </div>

      {/* base address + default route-end — opened as a modal from the „Локация" button */}
      {showLoc && (
        <LocationRouteCard
          placesKey={placesKey}
          onClose={() => setShowLoc(false)}
          onSaved={() => {
            setShowLoc(false);
            router.refresh();
          }}
        />
      )}

      {/* plain-language hint for the active choice */}
      <p className="mb-3 text-[12.5px] text-ff-muted">{endHint}</p>

      {/* en route: make it explicit the remaining route no longer starts from the
          base — the courier is out delivering. Also an observable signal that the
          "start from where you are" shift is active. */}
      {finishedIds.size > 0 && (
        <p className="mb-3 -mt-1.5 flex items-center gap-1.5 text-[12.5px] font-bold text-ff-green-800">
          <Navigation size={13} />
          {selfPos
            ? 'Маршрутът продължава от текущата ти позиция (GPS), не от базата.'
            : lastFinishedStop
              ? 'Маршрутът продължава от последната завършена спирка, не от базата.'
              : 'Маршрутът продължава напред — навигацията тръгва от текущата ти позиция.'}
        </p>
      )}

      {/* long route: open each remaining leg one-by-one (avoids popup blocking) */}
      {extraLegs.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5">
          <span className="text-[12.5px] font-bold text-ff-amber-600">
            Дълъг маршрут — отвори следващите отсечки:
          </span>
          {extraLegs.map((u, i) => (
            <button
              key={u}
              onClick={() => window.open(u, '_blank', 'noopener')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[12.5px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2"
            >
              <Navigation size={13} /> Отсечка {i + 2}
            </button>
          ))}
        </div>
      )}

      {/* Waze step-by-step navigator — one stop at a time (Waze has no waypoints) */}
      {showWaze && wazeTargets.length > 0 && (
        <WazeStepper
          targets={wazeTargets}
          idx={wazeIdx}
          onNavigate={wazeNavigate}
          onJump={setWazeIdx}
          onPrev={wazePrev}
          onNext={wazeNext}
          onReset={wazeReset}
          onClose={() => setShowWaze(false)}
        />
      )}

      {/* explainer modal — for farmers who aren't used to the tech */}
      {showHelp && (
        <div
          className="animate-ff-fade fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="animate-ff-pop relative max-h-[85vh] w-[560px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface p-6 text-[13px] leading-relaxed text-ff-ink-2 shadow-ff-lg"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Помощ за маршрута"
          >
            <button
              type="button"
              onClick={() => setShowHelp(false)}
              aria-label="Затвори"
              className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2 hover:text-ff-ink"
            >
              <X size={18} />
            </button>
          <h3 className="mb-1.5 pr-8 text-[13.5px] font-extrabold text-ff-ink">Какво е този екран</h3>
          <p className="mb-2.5">
            Маршрутът подрежда <b>потвърдените</b> поръчки за доставка до адрес за избрания ден, за да
            ги обиколиш бързо. Започва от базата ти (адресът от бутона <b>Локация</b> горе). Смени деня
            от бутона с календара горе.
          </p>
          <h3 className="mb-2 text-[13.5px] font-extrabold text-ff-ink">Какво прави всеки бутон</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              <b>Локация</b> — задава адреса на базата (началото на маршрута) и края на маршрута по
              подразбиране. Запазва се и важи за всички следващи дни.
            </li>
            <li>
              Маршрутът реди доставките автоматично, за да изминеш най-малко километри — без нужда да
              задаваш нещо.
            </li>
            <li>
              <b>Куриери</b> — раздели маршрута между няколко души — всеки получава балансирана част от
              спирките, всички тръгват от базата. Броят се <b>помни</b> за следващия път.
            </li>
            <li>
              <b>Към дома / Край при клиента</b> — къде свършваш след последната доставка: при базата
              или при последния клиент. Изборът се <b>помни</b> — следващия път маршрутът се отваря
              както си го оставил.
            </li>
            <li>
              <b>Google Maps</b> — отваря маршрута в Google Maps за навигация. Щом завършиш първата
              поръчка, тръгва от <b>твоята GPS позиция</b> (където си в момента), не от базата, и води
              само до останалите спирки.
            </li>
            <li>
              <b>Завърших доставките</b> — маркира всички спирки за деня (при всички куриери) като
              доставени (след потвърждение). Не пипа информацията дали парите са получени — това е
              отделно.
            </li>
            <li>
              <b>Поръчка</b> (иконата с листа) — отваря панела на текущата (маркираната) спирка:
              детайли, продукти, потвърждение, отказ и промяна на статус — без да излизаш от маршрута.
            </li>
            <li>
              <b>Готово</b> (иконата с кутия и отметка) — маркира текущата поръчка като доставена,
              изчезва от списъка и картата, и се минава на следващата, една по една. Останалият
              маршрут продължава от <b>текущата ти позиция</b> (GPS), не от базата — синята точка на
              картата показва къде си. Сгрешил? Горе вдясно излиза „Отмени&quot; за 10 секунди —
              връща поръчката. За разлика от „Завърших доставките&quot;, което маркира всички наведнъж.
            </li>
            <li>
              <b>Waze</b> — навигация спирка по спирка. За разлика от Google Maps, Waze{' '}
              <b>не поддържа маршрути с много спирки</b> — приема само една дестинация наведнъж.
              Затова тук цъкаш „Навигирай“ за текущата спирка, закарай, после мини на следващата.
              Помни докъде си стигнал за деня — отделно за всеки куриер.
            </li>
            <li>
              При всяка спирка виждаш <b>телефон и имейл</b> — натисни ги за обаждане/писмо, или
              иконата за копиране. <b>Карти</b> отваря само тази спирка.
            </li>
            <li>
              <b>Смени адрес</b> (иконата с карфицата при всяка спирка, или жълтият етикет
              „не е на картата&quot;) — отваря прозорец с два начина да оправиш точката: въведи/потърси
              адрес, или цъкни точното място на малка карта. Запазва се и спирката влиза в маршрута.
            </li>
            <li>
              Много спирки? Google показва до 9 на компютър и до 3 на телефон — затова при дълъг
              маршрут се появяват бутони <b>Отсечка 2, 3…</b> за останалите.
            </li>
            <li>
              На картата: <b>★</b> = твоята база, <b>номерата</b> = редът на доставките (различен цвят
              за всеки куриер), <b>⚑</b> = краят на маршрута.
            </li>
          </ul>
          </div>
        </div>
      )}

      {/* courier tabs — one per leg, each labelled with its own stop count and
          distance/duration; only shown when the day is actually split */}
      {multi && (
        <div className="mb-3">
          <div className="flex flex-wrap gap-2">
            {routes.map((r, i) => {
              const rDist = fmtDist(r.totalDistanceM);
              const rDur = fmtDur(r.totalDurationS);
              const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
              const on = i === activeCourierIdx;
              return (
                <button
                  key={i}
                  onClick={() => setActiveCourierIdx(i)}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px] font-bold transition',
                    on
                      ? 'border-transparent text-white shadow-ff-sm'
                      : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
                  )}
                  style={on ? { backgroundColor: color } : undefined}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: on ? 'rgba(255,255,255,0.9)' : color }}
                  />
                  Маршрут {i + 1} ({r.stops.length} {r.stops.length === 1 ? 'спирка' : 'спирки'}
                  {rDist ? ` · ${rDist}` : ''}
                  {rDur ? ` · ~${rDur}` : ''})
                  {r.endMode === 'home' ? <Home size={12} /> : <Flag size={12} />}
                </button>
              );
            })}
          </div>
          {/* per-courier delivery revenue for the ACTIVE tab (task #6) — the
              day-wide total already sits in the summary line above. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] font-bold text-ff-muted">
            <span>Маршрут {activeCourierIdx + 1}:</span>
            <span>Доставки {moneyFromStotinki(active.deliveryFeeStotinki)}</span>
            <span className="text-ff-ink-2">Оборот {moneyFromStotinki(active.totalStotinki)}</span>
          </div>
        </div>
      )}

      <div className="grid h-[calc(100vh-var(--topbar-h)-152px)] min-h-[460px] grid-cols-[380px_1fr] items-stretch gap-4 max-[900px]:h-auto max-[900px]:min-h-0 max-[900px]:grid-cols-1">
        {/* stops list — shows the ACTIVE courier's leg */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-ff-border-2 px-[18px] pb-[13px] pt-4">
            <h2 className="text-[16px] font-extrabold">Маршрут за доставка</h2>
            <div className="flex flex-wrap gap-2">
              {/* manual stop-order override — an organizer decision (feeds
                  route_seq), not a driver executing their own leg */}
              {!isDriver && (
                <button
                  onClick={() => setShowReorder(true)}
                  disabled={orderedStops.length < 2}
                  title="Подреди ръчно реда на доставка"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-[9px] border px-[11px] py-[7px] text-[13px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50',
                    isManualOrder
                      ? 'border-ff-green-500 bg-ff-green-100 text-ff-green-800'
                      : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
                  )}
                >
                  <ArrowUpDown size={15} /> Подреди реда{isManualOrder ? ' · ръчен' : ''}
                </button>
              )}
              <button
                onClick={() => openRoute()}
                disabled={!stops.length}
                title="Отваря целия маршрут в Google Maps за преглед"
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Navigation size={15} /> Google Maps
              </button>
              <button
                onClick={() => {
                  const id = activeId ?? orderedStops[0]?.id;
                  if (id) void openStopPanel(id);
                }}
                disabled={!orderedStops.length || openingId != null}
                title="Отвори поръчката (детайли, потвърди, откажи)"
                aria-label="Отвори поръчката"
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ClipboardList size={15} /> Поръчка
              </button>
              <button
                onClick={() => void finishCurrent()}
                disabled={!currentFinishId || finishingOne}
                title={
                  currentFinishId
                    ? `Завърши текущата поръчка (остават ${orderedStops.filter((s) => !finishedIds.has(s.id)).length})`
                    : 'Всички поръчки в маршрута са завършени'
                }
                aria-label="Завърши текущата поръчка"
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-100 px-[11px] py-[7px] text-[13px] font-bold text-ff-green-800 transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PackageCheck size={15} /> Готово
              </button>
              <button
                onClick={() => setShowWaze((v) => !v)}
                disabled={!stops.length}
                title="Навигирай маршрута спирка по спирка с Waze"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[9px] border px-[11px] py-[7px] text-[13px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50',
                  showWaze
                    ? 'border-ff-green-500 bg-ff-green-100 text-ff-green-800'
                    : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Navigation size={15} /> Waze
              </button>
              <button
                onClick={() => setConfirmFinish(true)}
                disabled={!allStops.length}
                title="Маркира всички спирки за днес (при всички куриери) като доставени"
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-100 px-[11px] py-[7px] text-[13px] font-bold text-ff-green-800 transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle2 size={15} /> Завърших доставките
              </button>
            </div>
          </div>
          {isManualOrder && (
            <div className="flex items-center justify-between gap-2 border-b border-ff-border-2 bg-ff-green-50 px-[18px] py-1.5">
              <span className="text-[12px] font-semibold text-ff-green-800">Ръчен ред на доставка</span>
              <button
                onClick={resetOrder}
                title="Върни автоматичния ред (най-малко километри)"
                className="text-[12px] font-bold text-ff-ink-2 underline-offset-2 hover:underline"
              >
                Върни авто-реда
              </button>
            </div>
          )}
          <StopList
            stops={remainingStops}
            activeId={activeId}
            onPick={pickStop}
            onOpenMaps={onOpenMaps}
            onCall={onCall}
            onEmail={onEmail}
            onEditAddress={setEditStop}
            courierCount={route.couriers}
            onMoveCourier={(id, idx) => void moveCourier(id, idx)}
          />
        </div>

        {/* map — every courier's route is drawn; the active one is highlighted */}
        <div className="relative overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:order-[-1] max-[900px]:h-[340px]">
          {/* the measured road-following line failed/hit quota — the map is
              drawing straight pin-to-pin segments instead of the real streets;
              say so instead of leaving it silent. */}
          {routeApiFallback && (
            <div className="absolute left-2 top-2 z-[5] flex items-center gap-1.5 rounded-lg border border-ff-amber-soft bg-ff-amber-softer px-2.5 py-1.5 text-[11.5px] font-bold text-ff-amber-600 shadow-ff-sm">
              <AlertTriangle size={13} className="shrink-0" />
              Права линия — реалният път не е наличен (лимит/грешка на картите)
            </div>
          )}
          <RouteMap
            routes={displayRoutes}
            activeRoute={activeCourierIdx}
            origin={origin}
            end={end}
            activeId={activeId}
            onPick={pickStop}
            start={mapStart ?? undefined}
            focusNonce={focusNonce}
            apiKey={mapsKey}
          />
        </div>
      </div>

      {confirmFinish && (
        <ConfirmDialog
          title="Завърши доставките за днес?"
          message={`Всички ${allStops.length} спирки (при всички куриери) ще бъдат маркирани като доставени.`}
          confirmLabel="Завърших"
          busy={finishing}
          onCancel={() => setConfirmFinish(false)}
          onConfirm={finishDay}
        />
      )}

      {panelOrder && (
        <OrderPanel
          order={panelOrder}
          busy={panelBusy}
          onClose={() => setPanelOrder(null)}
          onAction={(s) => void panelAction(s)}
          onSaved={(updated) => {
            setPanelOrder(updated);
            router.refresh();
          }}
        />
      )}

      {editStop && (
        <EditAddressModal
          stop={editStop}
          origin={origin}
          mapsKey={mapsKey}
          placesKey={placesKey}
          onClose={() => setEditStop(null)}
          onSaved={() => {
            setEditStop(null);
            router.refresh();
          }}
        />
      )}

      {!isDriver && showReorder && (
        <ReorderStopsModal
          stops={orderedStops}
          dateLabel={dateLabel}
          isManual={isManualOrder}
          onSave={(ids) => {
            persistOrder(ids);
            setShowReorder(false);
          }}
          onReset={() => {
            resetOrder();
            setShowReorder(false);
          }}
          onClose={() => setShowReorder(false)}
        />
      )}

      {showDaySuggest && (
        <RouteDaySuggesterModal
          onClose={() => setShowDaySuggest(false)}
          onApplied={() => {
            setShowDaySuggest(false);
            // Orders moved across days — reload so the current day's route reflects it.
            router.refresh();
          }}
        />
      )}

      {showHomes && (
        <CourierHomesModal
          courierCount={route.couriers}
          placesKey={placesKey}
          onClose={() => setShowHomes(false)}
          onSaved={() => {
            setShowHomes(false);
            router.refresh();
          }}
        />
      )}
      {showWindows && (
        <DeliveryWindowsModal
          date={route.date}
          couriers={route.couriers}
          ends={routes.map((r) => r.endMode).join(',')}
          onClose={() => setShowWindows(false)}
          onChanged={() => router.refresh()}
        />
      )}
      {showAddOrders && (
        <AddOrdersModal
          routeDate={route.date}
          courierCount={route.couriers}
          onClose={() => setShowAddOrders(false)}
          onAdded={() => router.refresh()}
        />
      )}
    </div>
  );
}
