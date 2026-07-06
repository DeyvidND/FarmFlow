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
  Clock,
  Route as RouteIcon,
  HelpCircle,
  Settings,
  AlertTriangle,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { setStopLocation, updateOrderStatus } from '@/lib/api-client';
import type { RouteResult, RouteStop, RouteEndMode, RouteOrderMode } from '@/lib/types';
import { StopList } from './stop-list';
import { RouteMap } from './route-map';
import { LocationRouteCard } from './location-route-card';
import { WazeStepper } from './waze-stepper';
import { buildWazeTargets, wazeUrl } from './waze';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const cn = (...c: (string | false)[]) => c.filter(Boolean).join(' ');

const ORDER_OPTIONS: { mode: RouteOrderMode; label: string; Icon: typeof Home; hint: string }[] = [
  {
    mode: 'slots',
    label: 'По час',
    Icon: Clock,
    hint: 'Подрежда доставките по запазения час — първо 11:00, после 12:00, после 13:00.',
  },
  {
    mode: 'distance',
    label: 'Най-кратък път',
    Icon: RouteIcon,
    hint: 'Подрежда доставките така, че да изминеш най-малко километри (без оглед на часовете).',
  },
];

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

export function RouteClient({
  route,
  dateLabel,
  loadError = false,
  mapsKey,
  placesKey,
}: {
  route: RouteResult;
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
  const { stops, origin, end, orderMode, polyline } = route;
  const [activeId, setActiveId] = useState<string | null>(stops[0]?.id ?? null);
  const [showHelp, setShowHelp] = useState(false);
  const [showLoc, setShowLoc] = useState(false);
  // The un-geocoded stop awaiting a manual pin (set by clicking the map).
  const [placingId, setPlacingId] = useState<string | null>(null);
  // Remaining legs of a long (>9-waypoint) route — opened one-by-one on click so
  // each is a real user gesture (a burst of window.open() gets popup-blocked).
  const [extraLegs, setExtraLegs] = useState<string[]>([]);

  // Waze step-by-step navigator: which target is next, and whether the panel is
  // open. `wazeIdx` reaches `wazeTargets.length` when every stop is done.
  const [showWaze, setShowWaze] = useState(false);
  const [wazeIdx, setWazeIdx] = useState(0);
  const wazeTargets = useMemo(
    () => buildWazeTargets(stops, end, origin),
    [stops, end, origin],
  );

  // Restore Waze progress for THIS date (survives reload / phone lock). Clamp to
  // the current target count. Keyed on the date only so re-ordering mid-run
  // doesn't reset the pointer.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`ff:waze:${route.date}`);
      const n = raw == null ? 0 : parseInt(raw, 10);
      setWazeIdx(Number.isFinite(n) ? Math.min(Math.max(n, 0), wazeTargets.length) : 0);
    } catch {
      setWazeIdx(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.date]);

  // Persist progress on every change.
  useEffect(() => {
    try {
      localStorage.setItem(`ff:waze:${route.date}`, String(wazeIdx));
    } catch {
      /* localStorage unavailable (private mode) — progress just won't persist */
    }
  }, [wazeIdx, route.date]);

  const dist = fmtDist(route.totalDistanceM);
  const dur = fmtDur(route.totalDurationS);
  const summary = `${stops.length} ${stops.length === 1 ? 'спирка' : 'спирки'}${dist ? ` · ${dist}` : ''}${dur ? ` · ~${dur}` : ''}`;

  // Where the route ends, for the Google Maps deep link (null = end at last stop).
  const endPoint: Point | null =
    end.mode !== 'last' && (end.lat != null || end.address)
      ? { address: end.address, lat: end.lat, lng: end.lng }
      : null;

  // Navigate keeping the other options; override only what changed.
  const go = (over: { end?: RouteEndMode; order?: RouteOrderMode }) =>
    router.push(
      `/route?date=${route.date}&end=${over.end ?? end.mode}&order=${over.order ?? orderMode}`,
    );
  const setEnd = (mode: RouteEndMode) => go({ end: mode });
  const setOrder = (mode: RouteOrderMode) => go({ order: mode });
  const setDate = (date: string) =>
    router.push(`/route?date=${date}&end=${end.mode}&order=${orderMode}`);

  const orderHint = ORDER_OPTIONS.find((o) => o.mode === orderMode)?.hint ?? '';
  const endHint = END_OPTIONS.find((o) => o.mode === end.mode)?.hint ?? '';

  const openRoute = () => {
    const urls = dirUrls(origin, stops, endPoint);
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

  // Bulk "finish the day" action: marks every stop's order as delivered.
  // Does not touch payment/COD fields — those are a separate, existing flow.
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const finishDay = async () => {
    setFinishing(true);
    const results = await Promise.allSettled(
      stops.map((s) => updateOrderStatus(s.id, 'delivered')),
    );
    setFinishing(false);
    setConfirmFinish(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === 0) {
      toast.success(`Всички ${stops.length} спирки маркирани като доставени`);
    } else {
      toast.error(`${stops.length - failed}/${stops.length} маркирани, ${failed} неуспешни — опитай пак`);
    }
    router.refresh();
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

  // Manual-pin flow: the stop being placed + the map-click handler that saves it.
  const placingStop = placingId ? (stops.find((s) => s.id === placingId) ?? null) : null;
  const onPlaceOnMap = async (lat: number, lng: number) => {
    if (!placingId) return;
    try {
      await setStopLocation(placingId, { lat, lng });
      toast.success('Пинът е поставен на картата');
      setPlacingId(null);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Неуспешно записване');
    }
  };

  // Stops whose address couldn't be geocoded — no map pin. They're still in the
  // list (nothing dropped), but the farmer must be told so a delivery isn't
  // silently missed just because it never showed up on the map.
  const unlocated = stops.filter((s) => s.lat == null || s.lng == null);

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
            — показани са в списъка (с ⚠), но без пин. Провери адреса или се обади на клиента.
          </span>
        </div>
      )}

      {/* summary + ordering + end-mode + date + help */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-ff-muted">{summary}</p>
        <div className="flex flex-wrap items-center gap-2">
          {/* how stops are ordered: by time slot vs shortest distance */}
          <div className="flex items-center gap-1 rounded-xl border border-ff-border bg-ff-surface p-1 shadow-ff-sm">
            {ORDER_OPTIONS.map(({ mode, label, Icon }) => (
              <button
                key={mode}
                onClick={() => setOrder(mode)}
                title={label}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12.5px] font-bold transition',
                  orderMode === mode
                    ? 'bg-ff-green-100 text-ff-green-800'
                    : 'text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          {/* where the van goes after the last delivery */}
          <div className="flex items-center gap-1 rounded-xl border border-ff-border bg-ff-surface p-1 shadow-ff-sm">
            {END_OPTIONS.map(({ mode, label, Icon }) => (
              <button
                key={mode}
                onClick={() => setEnd(mode)}
                title={label}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12.5px] font-bold transition',
                  end.mode === mode
                    ? 'bg-ff-green-100 text-ff-green-800'
                    : 'text-ff-ink-2 hover:bg-ff-surface-2',
                )}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
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

      {/* plain-language hint for the active choices */}
      <p className="mb-3 text-[12.5px] text-ff-muted">
        {orderHint} {endHint}
      </p>

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
              <b>По час</b> — реди доставките по час: първо 11:00, после 12:00, после 13:00.
              Удобно, когато си обещал часове на клиентите.
            </li>
            <li>
              <b>Най-кратък път</b> — реди ги така, че да изминеш най-малко километри (без оглед на часа).
              Удобно, когато искаш да спестиш гориво и време.
            </li>
            <li>
              <b>Към дома / Край при клиента / По избор</b> — къде свършваш след последната доставка: при
              базата, при последния клиент, или на друг адрес. Изборът тук важи{' '}
              <b>само за този преглед</b>; стойността по подразбиране се задава от бутона{' '}
              <b>Локация</b> горе.
            </li>
            <li>
              <b>Google Maps</b> — отваря целия маршрут в Google Maps, за да го видиш на картата.
            </li>
            <li>
              <b>Завърших доставките</b> — маркира всички спирки за деня като доставени
              (след потвърждение). Не пипа информацията дали парите са получени — това е
              отделно.
            </li>
            <li>
              <b>Waze</b> — навигация спирка по спирка. Waze води до една спирка наведнъж; цъкни
              „Навигирай“, закарай, после мини на следващата. Помни докъде си стигнал за деня.
            </li>
            <li>
              При всяка спирка виждаш <b>телефон и имейл</b> — натисни ги за обаждане/писмо, или
              иконата за копиране. <b>Карти</b> отваря само тази спирка.
            </li>
            <li>
              <b>⚠ не е на картата</b> — адресът не можа да се намери, затова няма пин. Спирката пак
              е в списъка. Натисни <b>Намери / постави на картата</b> при спирката: въведи по-точен
              адрес (<b>Намери</b>), или избери <b>Постави на картата</b> и кликни точното място на
              картата. Така пинът се запазва и спирката влиза в маршрута.
            </li>
            <li>
              Много спирки? Google показва до 9 на компютър и до 3 на телефон — затова при дълъг
              маршрут се появяват бутони <b>Отсечка 2, 3…</b> за останалите.
            </li>
            <li>
              На картата: <b>★</b> = твоята база, <b>номерата</b> = редът на доставките, <b>⚑</b> =
              краят на маршрута.
            </li>
          </ul>
          </div>
        </div>
      )}

      <div className="grid h-[calc(100vh-var(--topbar-h)-152px)] min-h-[460px] grid-cols-[380px_1fr] items-stretch gap-4 max-[900px]:h-auto max-[900px]:min-h-0 max-[900px]:grid-cols-1">
        {/* stops list */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-ff-border-2 px-[18px] pb-[13px] pt-4">
            <h2 className="text-[16px] font-extrabold">Маршрут за доставка</h2>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => openRoute()}
                disabled={!stops.length}
                title="Отваря целия маршрут в Google Maps за преглед"
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Navigation size={15} /> Google Maps
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
                disabled={!stops.length}
                title="Маркира всички спирки за днес като доставени"
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-100 px-[11px] py-[7px] text-[13px] font-bold text-ff-green-800 transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle2 size={15} /> Завърших доставките
              </button>
            </div>
          </div>
          <StopList
            stops={stops}
            activeId={activeId}
            onPick={setActiveId}
            onOpenMaps={onOpenMaps}
            onCall={onCall}
            onEmail={onEmail}
            onFixed={() => router.refresh()}
            placingId={placingId}
            onStartPlace={(id) => {
              setActiveId(id);
              setPlacingId(id);
            }}
            onCancelPlace={() => setPlacingId(null)}
          />
        </div>

        {/* map */}
        <div className="relative overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:order-[-1] max-[900px]:h-[340px]">
          {placingStop && (
            <div className="absolute inset-x-0 top-0 z-[2] flex flex-wrap items-center justify-center gap-2 bg-ff-amber-600/95 px-3 py-2 text-center text-[12.5px] font-bold text-white">
              Кликни на картата, за да поставиш пин за {placingStop.customer ?? 'клиента'}
              <button
                onClick={() => setPlacingId(null)}
                className="rounded-md bg-white/20 px-2 py-0.5 transition hover:bg-white/30"
              >
                Отказ
              </button>
            </div>
          )}
          <RouteMap
            stops={stops}
            origin={origin}
            end={end}
            polyline={polyline}
            activeId={activeId}
            onPick={setActiveId}
            placing={placingId != null}
            onMapClick={onPlaceOnMap}
            apiKey={mapsKey}
          />
        </div>
      </div>

      {confirmFinish && (
        <ConfirmDialog
          title="Завърши доставките за днес?"
          message={`Всички ${stops.length} спирки ще бъдат маркирани като доставени.`}
          confirmLabel="Завърших"
          busy={finishing}
          onCancel={() => setConfirmFinish(false)}
          onConfirm={finishDay}
        />
      )}
    </div>
  );
}
