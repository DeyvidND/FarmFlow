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
  PlusCircle,
  SlidersHorizontal,
  MoreHorizontal,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { asLegIndex } from '@/lib/types';
import {
  getOrder,
  getRouteAssignments,
  measureRoute,
  rebalanceRoute,
  setOrderCourier,
  setOrderSequence,
  shiftDeliveryWindow,
  updateOrderStatus,
  updateTenant,
} from '@/lib/api-client';
import type { MultiRouteResult, CourierRoute, RouteAssignment, RouteStop, RouteEndMode } from '@/lib/types';
import type { Order } from '@/lib/types';
import type { OrderStatus } from '@/lib/utils';
import { moneyFromStotinki } from '@/lib/utils';
import { OrderPanel } from '@/components/orders/order-panel';
import { useRole } from '@/components/layout/role-context';
import { nextUnfinishedId, nextUnfinishedAfter, resolveRemainingStart } from './route-finish';
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
import { CourierStartsModal } from './courier-starts-modal';
import { CourierAssignmentBoard } from './courier-assignment-board';
import { deriveLegCount, isBoardActive } from './courier-assignment';
import { hasPinCausedImbalance } from './pin-imbalance';
import { DeliveryWindowsModal } from './delivery-windows-modal';
import { AddOrdersModal } from './add-orders-modal';
import { RouteMenu } from './route-menu';
import { RouteSettingsDrawer } from './route-settings-drawer';

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

/** On phones a new browser tab is disruptive and clutters the tab strip — navigate the
 *  current tab so the OS deep-links the Google Maps / Waze app instead. Desktop keeps a
 *  new tab so the panel stays put. Not used for multi-leg opens (those need the panel to
 *  survive so the remaining-leg buttons stay tappable). */
const navTarget = () => (isMobileBrowser() ? '_self' : '_blank');

const isIOSBrowser = () =>
  typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Google Maps APP deep link for a single destination ("lat,lng" or address text).
 *  iOS → the comgooglemaps scheme; Android → an intent:// that carries a web fallback,
 *  so a phone without the app lands on Maps web instead of an ERR_UNKNOWN_URL_SCHEME
 *  page. Returns null when there is no usable destination. */
function mapsAppUrl(dest: string, webUrl: string): string | null {
  if (!dest) return null;
  const d = encodeURIComponent(dest);
  if (isIOSBrowser()) return `comgooglemaps://?daddr=${d}&directionsmode=driving`;
  return (
    `intent://maps.google.com/maps?daddr=${d}&directionsmode=driving` +
    `#Intent;scheme=https;package=com.google.android.apps.maps;` +
    `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`
  );
}

/** Waze APP deep link for a single destination (same fallback strategy as maps). */
function wazeAppUrl(
  t: { lat: number | null; lng: number | null; address: string | null },
  webUrl: string,
): string | null {
  const q =
    t.lat != null && t.lng != null
      ? `ll=${encodeURIComponent(`${t.lat},${t.lng}`)}`
      : t.address?.trim()
        ? `q=${encodeURIComponent(t.address.trim())}`
        : '';
  if (!q) return null;
  if (isIOSBrowser()) return `waze://?${q}&navigate=yes`;
  return (
    `intent://waze.com/ul?${q}&navigate=yes` +
    `#Intent;scheme=https;package=com.waze;` +
    `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`
  );
}

/** Open an external navigation target so the FarmFlow tab SURVIVES — like a `tel:`
 *  link. Desktop opens a new tab. On mobile the maps/Waze app is launched in place and
 *  the panel stays loaded underneath, so coming back to the browser shows the route,
 *  not a blank new tab (and not the panel navigated away to Maps web). On iOS the app
 *  scheme silently no-ops when the app is missing, so a short timer falls back to the
 *  web URL; Android's intent:// carries its own fallback, so no timer is needed. */
function openExternalNav(webUrl: string, appUrl: string | null) {
  if (!isMobileBrowser()) {
    window.open(webUrl, '_blank', 'noopener');
    return;
  }
  if (!appUrl) {
    window.location.href = webUrl; // same tab — no new-tab clutter
    return;
  }
  if (isIOSBrowser()) {
    let handled = false;
    const cleanup = () => document.removeEventListener('visibilitychange', onHide);
    const onHide = () => {
      if (document.hidden) {
        handled = true;
        window.clearTimeout(timer);
        cleanup();
      }
    };
    const timer = window.setTimeout(() => {
      if (!handled) {
        cleanup();
        window.location.href = webUrl;
      }
    }, 1500);
    document.addEventListener('visibilitychange', onHide);
  }
  window.location.href = appUrl;
}

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
  startAddress: null,
  startLat: null,
  startLng: null,
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
  // Audit follow-up: a manual courier pin can create a real, deliberate
  // imbalance the geographic splitter can't fix (the pinned courier's stops
  // are fixed regardless of geography) — surface a short explanation instead
  // of letting a lopsided day read as "the algorithm is bad at this".
  const pinImbalanceHint = useMemo(() => hasPinCausedImbalance(routes), [routes]);
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

  // The phone's live position — the real „where I am now" (same GPS start
  // Google Maps/Waze use), which unlike the last-finished-stop fallback works
  // even when that stop had no coordinates. Live GPS is a DRIVER concept: the
  // courier is physically on the route, so the remaining line should begin where
  // they actually are. An operator watching from the office has no meaningful
  // position, so we never use theirs. Requested on mount (so a driver re-opening
  // mid-run starts from their spot, not the farm) and refreshed on each finish.
  const [selfPos, setSelfPos] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (!isDriver) {
      setSelfPos(null);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => setSelfPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {}, // denied / unavailable → the last-finished / persisted fallback stands
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  }, [isDriver, finishedIds]);

  // The courier's last delivered-stop position, PERSISTED per day+leg. `finishedIds`
  // is per session and a delivered order also drops out of the confirmed-only route
  // on refetch — so after a reload neither remembers where the courier left off, and
  // the line would snap back to the farm. This restores that anchor across reloads:
  // „start from the last order I marked done", exactly as the operator asked.
  const [persistedStart, setPersistedStart] = useState<{ lat: number; lng: number } | null>(null);
  const startKey = `ff:route-start:${route.date}:${activeCourierIdx}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`ff:route-start:${route.date}:${activeCourierIdx}`);
      const p = raw ? JSON.parse(raw) : null;
      setPersistedStart(p && typeof p.lat === 'number' && typeof p.lng === 'number' ? p : null);
    } catch {
      setPersistedStart(null);
    }
  }, [route.date, activeCourierIdx]);

  // Where the remaining route line starts on the in-app map once the courier is en
  // route: their live GPS if we have it, else the last finished drop (this session),
  // else the persisted last-delivered position (survives reload), else null (start
  // from the farm, as before anything is delivered). Only the drawn line moves — the
  // farm marker and „home" return leg are unchanged.
  const mapStart: { lat: number | null; lng: number | null } | null = resolveRemainingStart({
    isDriver,
    finishedCount: finishedIds.size,
    selfPos,
    lastFinished:
      lastFinishedStop
        ? { lat: lastFinishedStop.lat as number, lng: lastFinishedStop.lng as number }
        : null,
    persisted: persistedStart,
  });

  // Drop the active leg's override — fall back to the server's auto-optimized
  // order (the leg's pins stay; the day-wide undo is rebalanceDay below).
  const resetOrder = () => {
    setManualIds(null);
    try {
      localStorage.removeItem(orderKey);
    } catch {
      /* ignore */
    }
    // Clear the server-side override too (empty stopIds = clear semantics).
    // NB: the server wants the REAL leg number (active.courierIndex), not the
    // tab position — on a board day with a gap (legs [0, 2]) the second tab is
    // leg 2, and a position-keyed clear would target the unassigned leg 1.
    void setOrderSequence({
      date: route.date,
      courierIndex: active.courierIndex,
      stopIds: [],
    }).catch(() => {});
  };

  // Multi-leg save from the reorder modal: each leg's full id list is
  // persisted server-side (route_seq + whole-leg pin — pin and sequence agree
  // by design), so a stop moved into another leg's list is re-pinned there. A
  // leg emptied by moves gets NO call: empty stopIds means "clear the
  // override", and its former stops were already re-pinned by the target
  // leg's own save. Awaited (unlike persistOrder's fire-and-forget) because a
  // cross-leg move only shows up via the refetch — refreshing before the
  // server has the pins would snap stops back to their old legs.
  const persistMultiOrder = async (perLeg: { legIndex: number; ids: string[] }[]) => {
    try {
      await Promise.all(
        perLeg
          .filter((l) => l.ids.length > 0)
          .map((l) =>
            setOrderSequence({ date: route.date, courierIndex: l.legIndex, stopIds: l.ids }),
          ),
      );
    } catch {
      toast.error('Неуспешно запазване на реда');
      return;
    }
    // Update the local overlays per TAB position (the localStorage keys are
    // position-keyed): the active tab in place, the rest so a later tab
    // switch shows the saved order. perLeg is parallel to `routes`.
    perLeg.forEach((l, pos) => {
      try {
        localStorage.setItem(`ff:order:${route.date}:${pos}`, JSON.stringify(l.ids));
      } catch {
        /* ignore */
      }
    });
    setManualIds(perLeg[activeCourierIdx]?.ids ?? null);
    toast.success('Редът е запазен');
    router.refresh();
  };

  // Day-wide reset from the reorder modal: clears every manual courier pin AND
  // manual stop order for the date server-side, then drops the local overlays,
  // so the refetched route is a fresh geographic split. This is the bulk undo
  // for a lopsided day — setOrderSequence pins the whole leg it saves, and
  // without this the only way back was un-pinning stops one at a time.
  const rebalanceDay = async () => {
    try {
      const res = await rebalanceRoute(route.date);
      routes.forEach((_, pos) => {
        try {
          localStorage.removeItem(`ff:order:${route.date}:${pos}`);
        } catch {
          /* ignore */
        }
      });
      setManualIds(null);
      setShowReorder(false);
      toast.success(
        res.cleared > 0
          ? `Върнато на авто-разпределение (${res.cleared} поръчки)`
          : 'Няма ръчни премествания за изчистване',
      );
      router.refresh();
    } catch {
      toast.error('Неуспешно авто-разпределение');
    }
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
  const [showAssignBoard, setShowAssignBoard] = useState(false);
  const [showStarts, setShowStarts] = useState(false);
  // The consolidated „Настройки" drawer (audit P1) — one entry point for the
  // set-once config (base/end, couriers, homes, windows). Stays mounted behind
  // the sub-modal it launches, so closing that modal lands back here.
  const [showSettings, setShowSettings] = useState(false);

  // Per-day courier assignment board (Task C2) — which accounts work today
  // and which leg each drives (`routeCourierAssignments`, Task A1/A2). Fetched
  // independently of the modal's own open state so the couriers-count
  // dropdown's precedence (spec §4.2) is correct even before the farmer ever
  // opens the board. Re-fetched whenever the viewed date changes.
  const [assignments, setAssignments] = useState<RouteAssignment[]>([]);
  useEffect(() => {
    let cancelled = false;
    getRouteAssignments(route.date)
      .then((a) => {
        if (!cancelled) setAssignments(a);
      })
      .catch(() => {
        // Fetch failed — fall back to "no board" so the dropdown stays live
        // (today's behavior) instead of silently locking it.
        if (!cancelled) setAssignments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [route.date]);
  // Precedence (spec §4.2): ≥1 assignment for the date → the board defines
  // the day and the dropdown goes inert; zero assignments → the dropdown's
  // own count applies, unchanged from before this feature.
  const boardActive = isBoardActive(assignments);
  const boardLegCount = deriveLegCount(assignments, route.couriers);
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
  // Re-measure (and swap in) a fresh road line whenever it must start somewhere
  // other than the farm: a manual reorder, any finished stop, OR a courier start
  // anchor (live GPS / last-delivered, incl. one restored from a reload). Without
  // the `mapStart` clause a driver re-opening mid-run would keep the farm-anchored
  // server polyline and the line would still begin at the depot.
  const needsMeasuredPolyline = isManualOrder || finishedIds.size > 0 || mapStart != null;
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
      // Real leg number, not tab position: the server resolves this courier's
      // saved end config (home) via settings.routing.couriers[courierIndex].
      courierIndex: active.courierIndex,
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
              polyline:
                isManualOrder || finishedIds.size > 0 || mapStart != null
                  ? measuredPolyline
                  : r.polyline,
            }
          : r,
      ),
    [routes, activeCourierIdx, remainingStops, isManualOrder, finishedIds, measuredPolyline, mapStart],
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

  // Deep-link START for the ACTIVE courier: their per-courier start override,
  // else the farm base. Google Maps navigation opens from here (until en route,
  // when it switches to live GPS below).
  const activeStart: Point =
    active.startLat != null && active.startLng != null
      ? { address: active.startAddress, lat: active.startLat, lng: active.startLng }
      : { address: origin.address, lat: origin.lat, lng: origin.lng };

  // The end pager in „Настройки" targets ANY courier by tab position (not just
  // the active tab); the ends csv carries every leg. The chosen mode is also
  // saved as the tenant's default (fire-and-forget) so a fresh visit reopens with
  // it instead of resetting — the farmer doesn't have to re-pick every time.
  const setCourierEndAt = (pos: number, mode: RouteEndMode) => {
    const next = routes.map((r, i) => (i === pos ? mode : r.endMode));
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

  const openRoute = () => {
    // Once any stop is finished the courier is en route, not at the farm — omit
    // the origin so Google Maps navigates from the phone's live GPS. Before that
    // (planning the day) keep the farm as the start. Always route the REMAINING
    // stops only.
    const navOrigin: Point =
      finishedIds.size > 0 ? { address: null, lat: null, lng: null } : activeStart;
    const urls = dirUrls(navOrigin, remainingStops, endPoint);
    if (!urls.length) {
      toast.error('Няма спирки за маршрут');
      return;
    }
    // Open the first leg now (this click is the user gesture); queue the rest as
    // buttons so the browser doesn't block a burst of pop-ups. A single-leg route on
    // mobile deep-links the Maps app in-place (navTarget); a multi-leg route must keep
    // the panel alive for the remaining-leg buttons, so it always opens a new tab.
    window.open(urls[0], urls.length > 1 ? '_blank' : navTarget(), 'noopener');
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
    const t = wazeTargets[i];
    const url = wazeUrl(t);
    if (!url) {
      toast.error('Тази спирка не е на картата — провери адреса');
      return;
    }
    openExternalNav(url, wazeAppUrl(t, url));
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

  // The finish button's target: the SELECTED stop (tap any list card or map
  // pin to pick it) when it's still unfinished on this leg, else the first
  // unfinished stop in route order — „Готово" is not strictly sequential, the
  // courier can finish whichever stop they actually delivered. Recomputed each
  // render from the current order.
  const currentFinishId =
    activeId && !finishedIds.has(activeId) && orderedStops.some((s) => s.id === activeId)
      ? activeId
      : nextUnfinishedId(orderedStops, finishedIds);

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

  // Mark the targeted (selected, else first unfinished) stop delivered and
  // advance the highlight to the next unfinished stop AFTER it in route order.
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
      // Remember where the courier now is (this just-delivered drop), so the map
      // still starts the remaining line from here after a reload — when the
      // delivered order has dropped out of the confirmed-only route and this
      // session's `finishedIds` is gone. Only when the stop has coordinates.
      if (cur.lat != null && cur.lng != null) {
        const here = { lat: cur.lat, lng: cur.lng };
        try {
          localStorage.setItem(startKey, JSON.stringify(here));
        } catch {
          /* localStorage unavailable (private mode) — start just won't persist */
        }
        setPersistedStart(here);
      }
      const nextId = nextUnfinishedAfter(orderedStops, next, cur.id);
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
    const web = stopUrl(origin, s);
    openExternalNav(web, mapsAppUrl(pt(s), web));
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
  // Inline stop time edit (WP9): the operator changed a stop's start; the backend
  // shifts that stop + every later stop on its leg by the same delta. Refresh so
  // the whole leg's badges reflect the new times.
  const shiftWindow = async (stopId: string, deltaMin: number) => {
    try {
      const { shifted } = await shiftDeliveryWindow(route.date, stopId, deltaMin);
      router.refresh();
      toast.success(
        shifted > 1 ? `Часът е обновен — и следващите ${shifted - 1} спирки` : 'Часът е обновен',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Неуспешна промяна на часа');
    }
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
          {/* Roadside „Проверка" — the courier's own entry point. It lives HERE,
              not on Днес: a driver login never sees Днес, and this is the screen
              they already have open when they get pulled over. Solid green so it
              is findable one-handed, under stress, without reading. */}
          {isDriver && (
            <Link
              href="/protocols/check"
              className="inline-flex items-center gap-1.5 rounded-xl bg-ff-green-700 px-3 py-2.5 text-[13px] font-bold text-white shadow-ff-sm transition hover:bg-ff-green-800"
            >
              <ShieldCheck size={16} /> Проверка
            </Link>
          )}
          {/* set-once config, collapsed behind one entry point (audit P1); daily
              planning grouped into one menu (audit P4) — both organizer-only */}
          {!isDriver && (
            <>
              <button
                onClick={() => setShowSettings(true)}
                title="Локация, куриери, домове, часове, край на маршрута"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-xl border px-3 py-2.5 text-[13px] font-bold shadow-ff-sm transition',
                  boardActive
                    ? 'border-ff-green-500 bg-ff-green-100 text-ff-green-800'
                    : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Settings size={16} /> Настройки
              </button>
              <RouteMenu
                label="Планирай"
                icon={<SlidersHorizontal size={16} />}
                triggerClassName="rounded-xl border border-ff-border bg-ff-surface px-3 py-2.5 text-[13px] text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2"
                items={[
                  {
                    label: 'Предложи по дни',
                    icon: <Wand2 size={15} />,
                    onSelect: () => setShowDaySuggest(true),
                  },
                  {
                    label: 'Добави поръчки',
                    icon: <PlusCircle size={15} />,
                    onSelect: () => setShowAddOrders(true),
                  },
                  {
                    label: 'Подреди реда',
                    icon: <ArrowUpDown size={15} />,
                    onSelect: () => setShowReorder(true),
                    disabled: allStops.length < 2,
                    tag: isManualOrder ? '· ръчен' : undefined,
                  },
                ]}
              />
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
            ги обиколиш бързо. Започва от базата ти (адресът се задава от <b>Настройки → Локация</b>).
            Смени деня от бутона с календара горе.
          </p>
          <h3 className="mb-2 text-[13.5px] font-extrabold text-ff-ink">Какво прави всеки бутон</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              <b>Настройки</b> (зъбното колело горе) — на едно място са всички еднократни настройки:
              локация на базата, край на маршрута, куриери за деня, домове на куриерите и часове за
              доставка. Настройваш веднъж и се <b>помни</b> за следващите дни.
            </li>
            <li>
              Маршрутът реди доставките автоматично, за да изминеш най-малко километри — без нужда да
              задаваш нещо.
            </li>
            <li>
              <b>Настройки → Куриери</b> — раздели маршрута между няколко души (или в „Куриери за деня“
              задай кой доставя днес и кой курс кара). Всеки получава балансирана част от спирките,
              всички тръгват от базата.
            </li>
            <li>
              <b>Настройки → Край на маршрута</b> (Към дома / Край при клиента) — къде свършваш след
              последната доставка: при базата или при последния клиент. Изборът се <b>помни</b>.
            </li>
            <li>
              <b>Планирай</b> — три помощни действия: „Предложи по дни“ (разпредели поръчките по
              няколко дни спрямо района на клиентите), „Добави поръчки“ (премести поръчки от други дни
              към този маршрут) и „Подреди реда“ (ръчно пренареди спирките).
            </li>
            <li>
              <b>Готово</b> (зеленият бутон) — маркира <b>избраната</b> поръчка като доставена (докосни
              карта от списъка или пин, за да избереш друга; иначе е първата поред), тя изчезва от
              списъка и картата, и се минава на следващата. Останалият маршрут продължава
              от <b>текущата ти позиция</b> (GPS), не от базата — синята точка на картата показва къде
              си. Сгрешил? Горе вдясно излиза „Отмени“ за 10 секунди — връща поръчката.
            </li>
            <li>
              <b>Навигация</b> — избери как да караш: „Google Maps“ отваря целия маршрут (щом завършиш
              първата поръчка, тръгва от <b>твоята GPS позиция</b>, не от базата); „Waze“ е спирка по
              спирка, защото Waze <b>не поддържа маршрути с много спирки</b> — цъкаш „Навигирай“ за
              текущата, закарай, после следващата. Помни докъде си стигнал — отделно за всеки куриер.
            </li>
            <li>
              <b>Поръчка</b> — отваря панела на текущата (маркираната) спирка: детайли, продукти,
              потвърждение, отказ и промяна на статус — без да излизаш от маршрута.
            </li>
            <li>
              <b>Още (⋯) → Завърших доставките</b> — маркира всички спирки за деня (при всички куриери)
              като доставени наведнъж (след потвърждение). Не пипа информацията дали парите са получени
              — това е отделно.
            </li>
            <li>
              При всяка спирка виждаш <b>телефон и имейл</b> — натисни ги за обаждане/писмо, или
              иконата за копиране. <b>Карти</b> отваря само тази спирка.
            </li>
            <li>
              <b>Смени адрес</b> (иконата с карфицата при всяка спирка, или жълтият етикет
              „не е на картата“) — отваря прозорец с два начина да оправиш точката: въведи/потърси
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
                  {/* Real leg number, not tab position — keeps the label in
                      sync with the board („Курс N"), the homes modal
                      („Куриер N") and the windows modal on a gap day. */}
                  Маршрут {r.courierIndex + 1} ({r.stops.length}{' '}
                  {r.stops.length === 1 ? 'спирка' : 'спирки'}
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
            <span>Маршрут {active.courierIndex + 1}:</span>
            <span>Доставки {moneyFromStotinki(active.deliveryFeeStotinki)}</span>
            <span className="text-ff-ink-2">Оборот {moneyFromStotinki(active.totalStotinki)}</span>
          </div>
          {/* audit follow-up: only shown when today's split is meaningfully
              imbalanced AND at least one order is pinned to a courier — a pin
              overrides geography on purpose, so the imbalance isn't a bug. */}
          {pinImbalanceHint && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ff-amber-600">
              <AlertTriangle size={12} className="shrink-0" />
              Разликата в натовареността идва от ръчно преместени поръчки към куриер — не от маршрута.
            </div>
          )}
        </div>
      )}

      <div className="grid h-[calc(100vh-var(--topbar-h)-152px)] min-h-[460px] grid-cols-[380px_1fr] items-stretch gap-4 max-[900px]:h-auto max-[900px]:min-h-0 max-[900px]:grid-cols-1">
        {/* stops list — shows the ACTIVE courier's leg */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-ff-border-2 px-[18px] pb-[13px] pt-4">
            <h2 className="text-[16px] font-extrabold">Маршрут за доставка</h2>
            <div className="flex flex-wrap items-center gap-2">
              {/* primary per-stop action — filled so it clearly leads the row
                  (audit P2) over navigation / details / overflow */}
              <button
                onClick={() => void finishCurrent()}
                disabled={!currentFinishId || finishingOne}
                title={
                  currentFinishId
                    ? `Завърши избраната поръчка (остават ${orderedStops.filter((s) => !finishedIds.has(s.id)).length})`
                    : 'Всички поръчки в маршрута са завършени'
                }
                aria-label="Завърши избраната поръчка"
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-700 px-[13px] py-[7px] text-[13px] font-bold text-white shadow-ff-sm transition hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PackageCheck size={15} /> Готово
              </button>
              {/* navigation choice (Google Maps / Waze) behind one control
                  (audit P2) — keeps the card's primary row to three */}
              <RouteMenu
                label="Навигация"
                icon={<Navigation size={15} />}
                align="left"
                triggerClassName={cn(
                  'rounded-[9px] px-[11px] py-[7px] text-[13px]',
                  showWaze
                    ? 'border border-ff-green-500 bg-ff-green-100 text-ff-green-800'
                    : 'border border-ff-green-600 bg-ff-surface text-ff-green-700 hover:bg-ff-green-50',
                )}
                items={[
                  {
                    label: 'Google Maps — целия маршрут',
                    icon: <Navigation size={15} />,
                    onSelect: () => openRoute(),
                    disabled: !stops.length,
                  },
                  {
                    label: showWaze ? 'Скрий Waze' : 'Waze — спирка по спирка',
                    icon: <Navigation size={15} />,
                    onSelect: () => setShowWaze((v) => !v),
                    disabled: !stops.length,
                  },
                ]}
              />
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
              {/* end-of-day bulk finish — rare, confirm-gated — kept out of the
                  primary row in an overflow menu (audit P2) */}
              <RouteMenu
                label="Още"
                title="Още действия"
                iconOnly
                icon={<MoreHorizontal size={18} />}
                triggerClassName="rounded-[9px] border border-ff-border bg-ff-surface px-2 py-[7px] text-ff-ink-2 hover:bg-ff-surface-2"
                items={[
                  {
                    label: 'Завърших доставките (всички)',
                    icon: <CheckCircle2 size={15} />,
                    onSelect: () => setConfirmFinish(true),
                    disabled: !allStops.length,
                  },
                ]}
              />
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
            courierLegs={routes.map((r) => r.courierIndex)}
            onMoveCourier={(id, idx) => void moveCourier(id, idx)}
            onShiftWindow={isDriver ? undefined : (id, delta) => void shiftWindow(id, delta)}
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
          // All legs, not just the active tab, so a stop can be moved to
          // another courier. Labels use the REAL leg number (courierIndex),
          // matching the page tabs on a board day with gaps. The active tab
          // shows its local manual overlay; the rest use server order.
          legs={routes.map((r, i) => ({
            legIndex: r.courierIndex,
            label: `Маршрут ${r.courierIndex + 1}`,
            stops: i === activeCourierIdx ? orderedStops : r.stops,
          }))}
          dateLabel={dateLabel}
          onSave={(perLeg) => {
            void persistMultiOrder(perLeg);
            setShowReorder(false);
          }}
          onRebalance={() => void rebalanceDay()}
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
          legs={route.routes.map((r) => asLegIndex(r.courierIndex))}
          placesKey={placesKey}
          onClose={() => setShowHomes(false)}
          onSaved={() => {
            setShowHomes(false);
            router.refresh();
          }}
        />
      )}
      {showStarts && (
        <CourierStartsModal
          legs={route.routes.map((r) => asLegIndex(r.courierIndex))}
          placesKey={placesKey}
          onClose={() => setShowStarts(false)}
          onSaved={() => {
            setShowStarts(false);
            router.refresh();
          }}
        />
      )}
      {showAssignBoard && (
        <CourierAssignmentBoard
          date={route.date}
          onClose={() => setShowAssignBoard(false)}
          onChanged={(next) => {
            // Reflect the new board immediately (dropdown precedence updates
            // without waiting on the refresh below) and refetch the route so
            // the actual stop split (Task A3's server-side precedence)
            // catches up with the new assignment.
            setAssignments(next);
            router.refresh();
          }}
        />
      )}
      {showWindows && (
        <DeliveryWindowsModal
          date={route.date}
          couriers={route.couriers}
          ends={routes.map((r) => r.endMode).join(',')}
          start={mapStart}
          onClose={() => setShowWindows(false)}
          onChanged={() => router.refresh()}
        />
      )}
      {showAddOrders && (
        <AddOrdersModal
          routeDate={route.date}
          courierCount={route.couriers}
          courierLegs={routes.map((r) => r.courierIndex)}
          onClose={() => setShowAddOrders(false)}
          onAdded={() => router.refresh()}
        />
      )}
      {!isDriver && showSettings && (
        <RouteSettingsDrawer
          baseAddress={origin.address}
          endOptions={END_OPTIONS}
          couriers={routes.map((r) => ({
            label: `Маршрут ${r.courierIndex + 1}`,
            endMode: r.endMode,
            startAddress: r.startAddress,
          }))}
          initialCourierPos={activeCourierIdx}
          onSetEndAt={setCourierEndAt}
          onOpenStarts={() => setShowStarts(true)}
          courierCount={route.couriers}
          onSetCouriers={setCouriers}
          boardActive={boardActive}
          boardLegCount={boardLegCount}
          onOpenLocation={() => setShowLoc(true)}
          onOpenHomes={() => setShowHomes(true)}
          onOpenWindows={() => setShowWindows(true)}
          onOpenBoard={() => setShowAssignBoard(true)}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
