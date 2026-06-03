'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarDays,
  ChevronDown,
  Navigation,
  Truck,
  Home,
  Flag,
  MapPin,
  Clock,
  Route as RouteIcon,
  HelpCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import type { RouteResult, RouteStop, RouteEndMode, RouteOrderMode } from '@/lib/types';
import { StopList } from './stop-list';
import { RouteMap } from './route-map';

const cn = (...c: (string | false)[]) => c.filter(Boolean).join(' ');

const ORDER_OPTIONS: { mode: RouteOrderMode; label: string; Icon: typeof Home; hint: string }[] = [
  {
    mode: 'slots',
    label: 'По часови слот',
    Icon: Clock,
    hint: 'Подрежда доставките по часа на слота — първо 11:00, после 12:00, после 13:00.',
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
  { mode: 'last', label: 'Едностранно', Icon: Flag, hint: 'Маршрутът свършва при последната доставка — без връщане.' },
  { mode: 'custom', label: 'По избор', Icon: MapPin, hint: 'Завършваш на друг адрес (задава се в Настройки).' },
];

// Google Maps consumer dir links accept ~9 waypoints; bigger routes are split
// into chained legs (each leg's destination is the next leg's origin).
const WAYPOINTS_PER_LEG = 9;
const NODES_PER_LEG = WAYPOINTS_PER_LEG + 2; // origin + 9 waypoints + destination

type Point = { address: string | null; lat: number | null; lng: number | null };

/** Coordinate string when geocoded, else the address (URLSearchParams encodes it). */
const pt = (p: Point) => (p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : p.address ?? '');

/** Build one Google Maps directions URL for a sequence of nodes (origin → … → destination). */
function legUrl(nodes: Point[], navigate: boolean): string {
  const params = new URLSearchParams({ api: '1', travelmode: 'driving' });
  const o = pt(nodes[0]);
  if (o) params.set('origin', o);
  params.set('destination', pt(nodes[nodes.length - 1]));
  if (navigate) params.set('dir_action', 'navigate');
  let url = `https://www.google.com/maps/dir/?${params.toString()}`;
  const mids = nodes.slice(1, -1).map(pt).filter(Boolean);
  if (mids.length) url += `&waypoints=${mids.map(encodeURIComponent).join('|')}`;
  return url;
}

/** Farm → stops as one or more chained Google Maps legs (≤9 waypoints each). */
function dirUrls(origin: Point, stops: RouteStop[], end: Point | null, navigate = false): string[] {
  if (!stops.length) return [];
  const points: Point[] = [origin, ...stops];
  if (end && (end.lat != null || end.address)) points.push(end);
  const urls: string[] = [];
  let i = 0;
  while (i < points.length - 1) {
    const seg = points.slice(i, i + NODES_PER_LEG);
    urls.push(legUrl(seg, navigate));
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

export function RouteClient({ route, dateLabel }: { route: RouteResult; dateLabel: string }) {
  const router = useRouter();
  const { stops, origin, end, orderMode } = route;
  const [activeId, setActiveId] = useState<string | null>(stops[0]?.id ?? null);
  const [showHelp, setShowHelp] = useState(false);

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

  const orderHint = ORDER_OPTIONS.find((o) => o.mode === orderMode)?.hint ?? '';
  const endHint = END_OPTIONS.find((o) => o.mode === end.mode)?.hint ?? '';

  const openRoute = (navigate: boolean) => {
    const urls = dirUrls(origin, stops, endPoint, navigate);
    if (!urls.length) {
      toast.error('Няма спирки за маршрут');
      return;
    }
    urls.forEach((u) => window.open(u, '_blank', 'noopener'));
    if (urls.length > 1) {
      toast.success(`Дълъг маршрут — отворен в ${urls.length} части в Google Maps`);
    } else {
      toast.success(navigate ? 'Навигацията се отваря в Google Maps' : 'Маршрутът се отваря в Google Maps');
    }
  };

  const onOpenMaps = (s: RouteStop) => {
    window.open(stopUrl(origin, s), '_blank', 'noopener');
  };
  const onCall = (s: RouteStop) => {
    if (s.phone) window.open(`tel:${s.phone.replace(/\s+/g, '')}`, '_self');
    toast.info(`Обаждане до ${s.customer ?? 'клиента'}…`);
  };

  return (
    <div className="animate-ff-fade-up">
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
          <div className="flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm">
            <CalendarDays size={17} />
            <span className="capitalize">{dateLabel}</span>
            <ChevronDown size={16} className="text-ff-muted" />
          </div>
          <button
            onClick={() => setShowHelp((v) => !v)}
            title="Какво правят бутоните?"
            className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 py-2.5 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm transition hover:bg-ff-surface-2"
          >
            <HelpCircle size={16} /> Помощ
          </button>
        </div>
      </div>

      {/* plain-language hint for the active choices */}
      <p className="mb-3 text-[12.5px] text-ff-muted">
        {orderHint} {endHint}
      </p>

      {/* expandable explainer — for farmers who aren't used to the tech */}
      {showHelp && (
        <div className="mb-4 rounded-xl border border-ff-border bg-ff-surface-2 p-4 text-[13px] leading-relaxed text-ff-ink-2 shadow-ff-sm">
          <h3 className="mb-2 text-[13.5px] font-extrabold text-ff-ink">Какво прави всеки бутон</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              <b>По часови слот</b> — реди доставките по час: първо 11:00, после 12:00, после 13:00.
            </li>
            <li>
              <b>Най-кратък път</b> — реди ги така, че да изминеш най-малко километри (без оглед на часа).
            </li>
            <li>
              <b>Към дома / Едностранно / По избор</b> — къде свършваш след последната доставка: при
              базата, при последния клиент, или на друг адрес (задава се в Настройки).
            </li>
            <li>
              <b>Google Maps</b> — отваря целия маршрут в Google Maps, за да го видиш на картата.
            </li>
            <li>
              <b>Старт</b> — пуска навигация „завой по завой“ в Google Maps на телефона.
            </li>
            <li>
              На картата: <b>★</b> = твоята база, <b>номерата</b> = редът на доставките, <b>⚑</b> =
              краят на маршрута.
            </li>
          </ul>
        </div>
      )}

      <div className="grid h-[calc(100vh-var(--topbar-h)-152px)] min-h-[460px] grid-cols-[380px_1fr] items-stretch gap-4 max-[900px]:h-auto max-[900px]:min-h-0 max-[900px]:grid-cols-1">
        {/* stops list */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <div className="flex items-center justify-between gap-2.5 border-b border-ff-border-2 px-[18px] pb-[13px] pt-4">
            <h2 className="text-[16px] font-extrabold">Маршрут за доставка</h2>
            <div className="flex gap-2">
              <button
                onClick={() => openRoute(false)}
                disabled={!stops.length}
                title="Отваря целия маршрут в Google Maps за преглед"
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Navigation size={15} /> Google Maps
              </button>
              <button
                onClick={() => openRoute(true)}
                disabled={!stops.length}
                title="Пуска навигация „завой по завой“ в Google Maps"
                className="inline-flex items-center gap-1.5 rounded-[9px] bg-ff-green-100 px-[11px] py-[7px] text-[13px] font-bold text-ff-green-800 transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Truck size={15} /> Старт
              </button>
            </div>
          </div>
          <StopList
            stops={stops}
            activeId={activeId}
            onPick={setActiveId}
            onOpenMaps={onOpenMaps}
            onCall={onCall}
          />
        </div>

        {/* map */}
        <div className="relative overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:order-[-1] max-[900px]:h-[340px]">
          <RouteMap stops={stops} origin={origin} end={end} activeId={activeId} onPick={setActiveId} />
        </div>
      </div>
    </div>
  );
}
