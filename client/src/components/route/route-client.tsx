'use client';

import { useState } from 'react';
import { CalendarDays, ChevronDown, Navigation, Truck } from 'lucide-react';
import { toast } from 'sonner';
import type { RouteResult, RouteStop } from '@/lib/types';
import { StopList } from './stop-list';
import { RouteMap } from './route-map';

const MAX_WAYPOINTS = 9; // Google Maps dir deep-link practical waypoint cap.

type Point = { address: string | null; lat: number | null; lng: number | null };

/** Coordinate string when geocoded, else the address (URLSearchParams encodes it). */
const pt = (p: Point) => (p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : p.address ?? '');

function dirUrl(origin: Point, stops: RouteStop[], navigate = false): string | null {
  if (!stops.length) return null;
  const params = new URLSearchParams({ api: '1', travelmode: 'driving' });
  const o = pt(origin);
  if (o) params.set('origin', o);
  params.set('destination', pt(stops[stops.length - 1]));
  if (navigate) params.set('dir_action', 'navigate');
  let url = `https://www.google.com/maps/dir/?${params.toString()}`;
  const mids = stops.slice(0, -1).slice(0, MAX_WAYPOINTS).map(pt).filter(Boolean);
  if (mids.length) url += `&waypoints=${mids.map(encodeURIComponent).join('|')}`;
  return url;
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
  const { stops, origin } = route;
  const [activeId, setActiveId] = useState<string | null>(stops[0]?.id ?? null);

  const dist = fmtDist(route.totalDistanceM);
  const dur = fmtDur(route.totalDurationS);
  const summary = `${stops.length} ${stops.length === 1 ? 'спирка' : 'спирки'}${dist ? ` · ${dist}` : ''}${dur ? ` · ~${dur}` : ''}`;

  const openRoute = (navigate: boolean) => {
    const url = dirUrl(origin, stops, navigate);
    if (!url) {
      toast.error('Няма спирки за маршрут');
      return;
    }
    window.open(url, '_blank', 'noopener');
    toast.success(navigate ? 'Навигацията се отваря в Google Maps' : 'Маршрутът се отваря в Google Maps');
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
      {/* summary + date pick */}
      <div className="mb-[18px] flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-ff-muted">{summary}</p>
        <div className="flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm">
          <CalendarDays size={17} />
          <span className="capitalize">{dateLabel}</span>
          <ChevronDown size={16} className="text-ff-muted" />
        </div>
      </div>

      <div className="grid h-[calc(100vh-var(--topbar-h)-152px)] min-h-[460px] grid-cols-[380px_1fr] items-stretch gap-4 max-[900px]:h-auto max-[900px]:min-h-0 max-[900px]:grid-cols-1">
        {/* stops list */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <div className="flex items-center justify-between gap-2.5 border-b border-ff-border-2 px-[18px] pb-[13px] pt-4">
            <h2 className="text-[16px] font-extrabold">Маршрут за доставка</h2>
            <div className="flex gap-2">
              <button
                onClick={() => openRoute(false)}
                disabled={!stops.length}
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Navigation size={15} /> Google Maps
              </button>
              <button
                onClick={() => openRoute(true)}
                disabled={!stops.length}
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
          <RouteMap stops={stops} activeId={activeId} onPick={setActiveId} />
        </div>
      </div>
    </div>
  );
}
