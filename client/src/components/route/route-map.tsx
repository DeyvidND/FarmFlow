'use client';

import { useEffect } from 'react';
import { Plus, Minus } from 'lucide-react';
import {
  APIProvider,
  Map,
  AdvancedMarker,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { cn } from '@/lib/utils';
import type { RouteStop, CourierRoute, MultiRouteResult, RouteEnd, RouteEndMode } from '@/lib/types';

/** One distinct color per courier route (cycles if there are more than 10). */
export const ROUTE_COLORS = [
  '#2c7a3f',
  '#1d6fb8',
  '#c2571d',
  '#7b3fb8',
  '#b83f5e',
  '#3fb8a9',
  '#8a8f1d',
  '#5e5e5e',
  '#b89f1d',
  '#1db884',
];

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
// Reserved demo map id — renders AdvancedMarkers without cloud map styling.
const MAP_ID = 'DEMO_MAP_ID';
const BG_CENTROID = { lat: 42.7339, lng: 25.4858 };

type Origin = MultiRouteResult['origin'];

/** A stop is "on the map" only when it has been geocoded (has both coords). */
const isLocated = (s: RouteStop) => s.lat != null && s.lng != null;

/** Route color for a given route index, cycling through the palette. */
const routeColor = (i: number) => ROUTE_COLORS[i % ROUTE_COLORS.length];

interface RouteMapProps {
  /** One entry per courier — every route is drawn, the active one highlighted. */
  routes: CourierRoute[];
  /** Index into `routes` of the currently selected courier tab. */
  activeRoute: number;
  origin: Origin;
  end: RouteEnd;
  activeId: string | null;
  onPick: (id: string) => void;
  /** Where the ACTIVE courier's remaining line starts, when that isn't the farm
   *  — e.g. the last delivery already finished this session, so the courier is
   *  there now, not back at base. The farm ★ and the „home" return stay anchored
   *  to `origin`; only the drawn line's first point moves. Null / undefined =
   *  start from the farm as before. */
  start?: { lat: number | null; lng: number | null } | null;
  /** Bumped on every user stop-pick; drives a pan+zoom to the active pin. Left
   *  undefined for callers that don't want the map to follow selection. */
  focusNonce?: number;
  /** Maps key from the server (Dokploy runtime env); falls back to the build-time
   *  NEXT_PUBLIC_ constant when absent. */
  apiKey?: string;
}

/**
 * Delivery route map. With a Maps key + geocoded points it renders a real
 * Google map (farm origin + one numbered+colored pin set per courier route +
 * a connecting line per route); otherwise it falls back to the styled demo
 * placeholder (active courier only).
 */
export function RouteMap({
  routes,
  activeRoute,
  origin,
  end,
  activeId,
  onPick,
  start,
  focusNonce,
  apiKey,
}: RouteMapProps) {
  const key = apiKey || MAPS_KEY;
  const hasOrigin = origin.lat != null && origin.lng != null;
  const active = routes[activeRoute] ?? routes[0];
  const activeLocated = (active?.stops ?? []).filter(isLocated);
  // A real map renders whenever we have a Maps key — even with zero stops it
  // shows a genuine Google map (centred on the farm, or the country) instead of
  // the styled placeholder. The demo only stands in for a missing key (local dev).
  const canRenderReal = !!key;

  // A distinct end marker only when the route ends somewhere other than home.
  const customEnd =
    end.mode === 'custom' && end.lat != null && end.lng != null
      ? { lat: end.lat, lng: end.lng }
      : null;

  if (!canRenderReal) {
    return <DemoMap stops={active?.stops ?? []} activeId={activeId} onPick={onPick} />;
  }

  const allLocated = routes.flatMap((r) => r.stops.filter(isLocated));
  const center = hasOrigin
    ? { lat: origin.lat as number, lng: origin.lng as number }
    : allLocated.length > 0
      ? { lat: allLocated[0].lat as number, lng: allLocated[0].lng as number }
      : BG_CENTROID;

  return (
    <APIProvider apiKey={key} language="bg" region="BG">
      <Map
        mapId={MAP_ID}
        defaultCenter={center}
        defaultZoom={11}
        gestureHandling="greedy"
        disableDefaultUI={false}
        style={{ width: '100%', height: '100%' }}
      >
        <FitBounds origin={origin} stops={allLocated} end={customEnd} />
        <PanToActive stops={allLocated} activeId={activeId} nonce={focusNonce ?? 0} />

        {routes.map((r, ri) => (
          <RouteLine
            key={ri}
            origin={origin}
            stops={r.stops.filter(isLocated)}
            endMode={r.endMode}
            polyline={r.polyline}
            color={routeColor(ri)}
            opacity={ri === activeRoute ? 0.9 : 0.45}
            start={ri === activeRoute ? start : undefined}
            legStart={{ lat: r.startLat, lng: r.startLng }}
          />
        ))}

        {hasOrigin && (
          <AdvancedMarker
            position={{ lat: origin.lat as number, lng: origin.lng as number }}
            title={origin.address ?? 'Ферма'}
          >
            <FarmPin />
          </AdvancedMarker>
        )}

        {/* Per-courier start override: a colored ▶ pin where a courier's leg
            begins when that isn't the farm ★ (drawn per leg, colored to match). */}
        {routes.map((r, ri) => {
          if (r.startLat == null || r.startLng == null) return null;
          const atFarm =
            origin.lat != null &&
            origin.lng != null &&
            Math.abs(r.startLat - origin.lat) < 1e-6 &&
            Math.abs(r.startLng - origin.lng) < 1e-6;
          if (atFarm) return null;
          return (
            <AdvancedMarker
              key={`start-${ri}`}
              position={{ lat: r.startLat, lng: r.startLng }}
              title={`Начало · ${r.name ?? `Маршрут ${r.courierIndex + 1}`}`}
            >
              <StartPin color={routeColor(ri)} />
            </AdvancedMarker>
          );
        })}

        {/* Where each courier's leg ENDS — their „У дома" home (task #7) or a
            custom end. Marked with a home pin in the courier's color so a line
            running off to a home no longer reads as a stray remnant. One-way
            legs (mode 'last') and legs that just return to the farm ★ get no
            separate pin (the ★ already marks the farm). */}
        {routes.map((r, ri) => {
          if (r.endMode === 'last' || r.endLat == null || r.endLng == null) return null;
          const atFarm =
            origin.lat != null &&
            origin.lng != null &&
            Math.abs(r.endLat - origin.lat) < 1e-6 &&
            Math.abs(r.endLng - origin.lng) < 1e-6;
          if (atFarm) return null;
          return (
            <AdvancedMarker
              key={`end-${ri}`}
              position={{ lat: r.endLat, lng: r.endLng }}
              title={`Дом · ${r.name ?? `Маршрут ${r.courierIndex + 1}`}`}
            >
              <HomePin color={routeColor(ri)} />
            </AdvancedMarker>
          );
        })}

        {/* „You are here" — where the remaining route now starts once the courier
            is en route (live GPS or the last finished drop), so the line no longer
            reads as starting from the farm. */}
        {start && start.lat != null && start.lng != null && (
          <AdvancedMarker
            position={{ lat: start.lat as number, lng: start.lng as number }}
            title="Ти си тук — маршрутът продължава оттук"
          >
            <SelfPin />
          </AdvancedMarker>
        )}

        {routes.map((r, ri) =>
          r.stops.filter(isLocated).map((s, i) => (
            <AdvancedMarker
              key={s.id}
              position={{ lat: s.lat as number, lng: s.lng as number }}
              onClick={() => onPick(s.id)}
            >
              <NumPin n={i + 1} active={activeId === s.id} color={routeColor(ri)} />
            </AdvancedMarker>
          )),
        )}
      </Map>
    </APIProvider>
  );
}

/** Pin marker content for a delivery stop — colored to match its courier route.
 *  The active stop keeps its route color (no yellow — that read as a stray extra
 *  route on a multi-courier map); it's emphasised with a white ring + scale. */
function NumPin({ n, active, color }: { n: number; active: boolean; color: string }) {
  return (
    <span
      className={cn(
        'grid h-[30px] w-[30px] place-items-center rounded-[50%_50%_50%_2px] shadow-[0_4px_10px_rgba(0,0,0,0.25)]',
        active && 'ring-2 ring-white',
      )}
      style={{ transform: `rotate(45deg) scale(${active ? 1.15 : 1})`, backgroundColor: color }}
    >
      <span
        className="text-[13.5px] font-extrabold text-white"
        style={{ transform: 'rotate(-45deg)' }}
      >
        {n}
      </span>
    </span>
  );
}

function FarmPin() {
  return (
    <span className="grid h-[28px] w-[28px] place-items-center rounded-full bg-white text-[15px] font-bold text-ff-green-800 shadow-ff-md ring-2 ring-ff-green-700">
      ★
    </span>
  );
}

/** Per-courier route end („У дома", task #7) — a home icon bordered in the
 *  courier's route color, so a leg that ends at the courier's home reads as a
 *  real destination, not a stray line running off the map. */
function HomePin({ color }: { color: string }) {
  return (
    <span
      className="grid h-[26px] w-[26px] place-items-center rounded-full bg-white text-[13px] shadow-ff-md"
      style={{ border: `2px solid ${color}` }}
    >
      🏠
    </span>
  );
}

/** Per-courier start override marker — a white ▶ pin bordered in the courier's
 *  route color, so it reads as "this leg begins here" without looking like a
 *  stop pin or the farm ★. */
function StartPin({ color }: { color: string }) {
  return (
    <span
      className="grid h-[22px] w-[22px] place-items-center rounded-full bg-white text-[11px] font-extrabold shadow-ff-md"
      style={{ border: `2px solid ${color}`, color }}
    >
      ▶
    </span>
  );
}

/** „You are here" marker — the courier's current start once en route. A filled
 *  blue dot with a white ring, visually distinct from the farm ★ and the numbered
 *  stop pins. */
function SelfPin() {
  return (
    <span className="grid h-[20px] w-[20px] place-items-center rounded-full bg-[#2563eb] shadow-ff-md ring-[3px] ring-white">
      <span className="h-[7px] w-[7px] rounded-full bg-white" />
    </span>
  );
}

/**
 * Pan + zoom the map onto the active stop's pin whenever the user picks a stop.
 * Keyed only on `nonce` (bumped per user pick) so it never fights the initial
 * fit-all, nor fires when a courier switch auto-selects a leg's first stop.
 */
function PanToActive({
  stops,
  activeId,
  nonce,
}: {
  stops: RouteStop[];
  activeId: string | null;
  nonce: number;
}) {
  const map = useMap();
  useEffect(() => {
    if (!map || !nonce || !activeId) return;
    const s = stops.find((x) => x.id === activeId);
    if (!s || s.lat == null || s.lng == null) return;
    map.panTo({ lat: s.lat, lng: s.lng });
    map.setZoom(15);
    // Only re-run on an explicit user pick — `activeId`/`stops` are read fresh
    // from the render that produced this nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  return null;
}

/** Fit the viewport to the farm + every route's stops (+ custom end). */
function FitBounds({
  origin,
  stops,
  end,
}: {
  origin: Origin;
  stops: RouteStop[];
  end: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  // LatLngBounds lives in the 'core' library, not 'maps'.
  const core = useMapsLibrary('core');
  useEffect(() => {
    if (!map || !core) return;
    const pts: { lat: number; lng: number }[] = [];
    if (origin.lat != null && origin.lng != null) pts.push({ lat: origin.lat, lng: origin.lng });
    stops.forEach((s) => pts.push({ lat: s.lat as number, lng: s.lng as number }));
    if (end) pts.push(end);
    if (!pts.length) return;
    if (pts.length === 1) {
      map.setCenter(pts[0]);
      map.setZoom(14);
      return;
    }
    const bounds = new core.LatLngBounds();
    pts.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 48);
  }, [map, core, origin, stops, end]);
  return null;
}

/**
 * Draw one courier's route line: farm → stops → end (home = back to farm, last
 * = stop, custom = end point). Prefers the real road geometry from the backend
 * (encoded polyline legs decoded via the `geometry` library) so the line
 * follows streets; falls back to straight segments between pins when no
 * geometry is available (maps stub, un-routed order, or a Routes API miss).
 */
function RouteLine({
  origin,
  stops,
  endMode,
  polyline,
  color,
  opacity,
  start,
  legStart,
}: {
  origin: Origin;
  stops: RouteStop[];
  endMode: RouteEndMode;
  polyline?: string[] | null;
  color: string;
  opacity: number;
  start?: { lat: number | null; lng: number | null } | null;
  /** This leg's own start (per-courier base override), used for the straight-
   *  line fallback origin when there's no en-route GPS start. */
  legStart?: { lat: number | null; lng: number | null } | null;
}) {
  const map = useMap();
  const maps = useMapsLibrary('maps');
  const geometry = useMapsLibrary('geometry');
  useEffect(() => {
    if (!map || !maps) return;

    // Preferred: the street-following path computed server-side. One encoded leg
    // per ≤25-stop Routes chunk; decode + concatenate into a single line.
    if (polyline && polyline.length && geometry) {
      const roadPath: { lat: number; lng: number }[] = [];
      for (const leg of polyline) {
        for (const pt of geometry.encoding.decodePath(leg)) {
          roadPath.push({ lat: pt.lat(), lng: pt.lng() });
        }
      }
      if (roadPath.length >= 2) {
        const line = new maps.Polyline({
          path: roadPath,
          strokeColor: color,
          strokeOpacity: opacity,
          strokeWeight: 4,
        });
        line.setMap(map);
        return () => line.setMap(null);
      }
    }

    // Fallback: straight segments through the ordered pins. The line starts from
    // `start` when given (the courier's last finished drop — they're there now),
    // else from the farm; the „home" return always goes back to the farm.
    const path: { lat: number; lng: number }[] = [];
    const home = origin.lat != null && origin.lng != null ? { lat: origin.lat, lng: origin.lng } : null;
    // This leg's base: its per-courier start override, else the farm.
    const legFrom =
      legStart && legStart.lat != null && legStart.lng != null
        ? { lat: legStart.lat, lng: legStart.lng }
        : home;
    // En-route GPS start wins; otherwise begin from this courier's own base.
    const from =
      start && start.lat != null && start.lng != null ? { lat: start.lat, lng: start.lng } : legFrom;
    if (from) path.push(from);
    stops.forEach((s) => path.push({ lat: s.lat as number, lng: s.lng as number }));
    if (endMode === 'home' && home) {
      path.push(home);
    }
    if (path.length < 2) return;
    const line = new maps.Polyline({
      path,
      strokeColor: color,
      strokeOpacity: opacity,
      strokeWeight: 3,
    });
    line.setMap(map);
    return () => line.setMap(null);
  }, [map, maps, geometry, origin, stops, endMode, polyline, color, opacity, start, legStart]);
  return null;
}

/* ----------------------------- demo fallback ---------------------------- */

/** Deterministic demo-map position (%) for a stop when no real geo is available. */
function demoPos(i: number, n: number): { x: number; y: number } {
  const x = n <= 1 ? 50 : 15 + (i / (n - 1)) * 70;
  const y = Math.min(82, Math.max(14, 38 + Math.sin(i * 1.3 + 0.5) * 20));
  return { x, y };
}

/** No Maps key configured (local dev) — shows the active courier's stops only. */
function DemoMap({
  stops,
  activeId,
  onPick,
}: {
  stops: RouteStop[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const pts = stops.map((_, i) => demoPos(i, stops.length));

  return (
    <div className="absolute inset-0 bg-[#E9E7DF]">
      {/* subtle grid + fake roads */}
      <svg width="100%" height="100%" className="absolute inset-0">
        <defs>
          <pattern id="ffgrid" width="46" height="46" patternUnits="userSpaceOnUse">
            <path d="M46 0H0V46" fill="none" stroke="#D8D5CA" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ffgrid)" />
        <path d="M-20 70 Q 200 40 420 130 T 900 180" fill="none" stroke="#D2CFC3" strokeWidth="11" strokeLinecap="round" />
        <path d="M120 -20 Q 180 200 120 460 T 260 900" fill="none" stroke="#D2CFC3" strokeWidth="9" strokeLinecap="round" />
        <path d="M-20 320 Q 320 300 620 380 T 1100 360" fill="none" stroke="#D2CFC3" strokeWidth="8" strokeLinecap="round" />
      </svg>

      {/* route line between pins */}
      {pts.length > 1 && (
        <svg
          width="100%"
          height="100%"
          className="pointer-events-none absolute inset-0"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
        >
          <polyline
            points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--ff-green-600)"
            strokeWidth="0.7"
            strokeDasharray="1.4 1.4"
            strokeLinecap="round"
            opacity="0.75"
          />
        </svg>
      )}

      {/* pins */}
      {stops.map((s, i) => {
        const on = activeId === s.id;
        return (
          <button
            key={s.id}
            onClick={() => onPick(s.id)}
            className="absolute z-[1] -translate-x-1/2 -translate-y-full transition-transform"
            style={{ left: `${pts[i].x}%`, top: `${pts[i].y}%`, zIndex: on ? 3 : 1 }}
          >
            <span
              className={cn(
                'grid h-[30px] w-[30px] place-items-center rounded-[50%_50%_50%_2px] shadow-[0_4px_10px_rgba(0,0,0,0.25)] transition-transform',
                on ? 'bg-ff-amber' : 'bg-ff-green-700',
              )}
              style={{ transform: `rotate(45deg) scale(${on ? 1.12 : 1})` }}
            >
              <span
                className={cn('text-[13.5px] font-extrabold', on ? 'text-[#3a2a08]' : 'text-white')}
                style={{ transform: 'rotate(-45deg)' }}
              >
                {i + 1}
              </span>
            </span>
          </button>
        );
      })}

      {/* labels + zoom chrome (decorative) */}
      <div className="pointer-events-none absolute bottom-[13px] left-[14px] select-none text-[21px] font-bold tracking-[-0.01em] text-[#9A9788]">
        Google Maps
      </div>
      <div className="absolute right-[14px] top-[13px] rounded-[9px] bg-white/80 px-[11px] py-[7px] text-xs font-bold text-ff-ink-2 shadow-ff-sm">
        Демо карта — място за Google Maps
      </div>
      <div className="absolute bottom-[13px] right-[14px] flex flex-col overflow-hidden rounded-[9px] bg-white shadow-ff-md">
        <button className="grid h-[34px] w-9 place-items-center border-b border-ff-border-2 text-ff-ink-2 hover:bg-ff-surface-2">
          <Plus size={17} />
        </button>
        <button className="grid h-[34px] w-9 place-items-center text-ff-ink-2 hover:bg-ff-surface-2">
          <Minus size={17} />
        </button>
      </div>
    </div>
  );
}
