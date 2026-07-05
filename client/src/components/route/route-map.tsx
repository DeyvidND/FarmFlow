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
import type { RouteStop, RouteResult, RouteEnd } from '@/lib/types';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
// Reserved demo map id — renders AdvancedMarkers without cloud map styling.
const MAP_ID = 'DEMO_MAP_ID';
const BG_CENTROID = { lat: 42.7339, lng: 25.4858 };

type Origin = RouteResult['origin'];

interface RouteMapProps {
  stops: RouteStop[];
  origin: Origin;
  end: RouteEnd;
  /** Encoded road-geometry legs (from the backend Routes API) for the current
   *  order. Decoded + drawn so the line follows streets; absent → straight line. */
  polyline?: string[] | null;
  activeId: string | null;
  onPick: (id: string) => void;
  /** Map-pin placement mode: a map click drops a pin for the placing stop. */
  placing?: boolean;
  /** Called with the clicked coords while `placing` is on. */
  onMapClick?: (lat: number, lng: number) => void;
  /** Maps key from the server (Dokploy runtime env); falls back to the build-time
   *  NEXT_PUBLIC_ constant when absent. */
  apiKey?: string;
}

/**
 * Delivery route map. With a Maps key + geocoded points it renders a real
 * Google map (farm origin + numbered stop pins + a connecting route line);
 * otherwise it falls back to the styled demo placeholder.
 */
export function RouteMap({
  stops,
  origin,
  end,
  polyline,
  activeId,
  onPick,
  placing = false,
  onMapClick,
  apiKey,
}: RouteMapProps) {
  const key = apiKey || MAPS_KEY;
  const located = stops.filter((s) => s.lat != null && s.lng != null);
  const hasOrigin = origin.lat != null && origin.lng != null;
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
    return <DemoMap stops={stops} activeId={activeId} onPick={onPick} />;
  }

  const center = hasOrigin
    ? { lat: origin.lat as number, lng: origin.lng as number }
    : located.length > 0
      ? { lat: located[0].lat as number, lng: located[0].lng as number }
      : BG_CENTROID;

  return (
    <APIProvider apiKey={key} language="bg" region="BG">
      <Map
        mapId={MAP_ID}
        defaultCenter={center}
        defaultZoom={11}
        gestureHandling="greedy"
        disableDefaultUI={false}
        draggableCursor={placing ? 'crosshair' : undefined}
        onClick={(e) => {
          if (!placing || !onMapClick) return;
          const ll = e.detail.latLng;
          if (ll) onMapClick(ll.lat, ll.lng);
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <FitBounds origin={origin} stops={located} end={customEnd} />
        <RouteLine origin={origin} stops={located} end={end} polyline={polyline} />

        {hasOrigin && (
          <AdvancedMarker
            position={{ lat: origin.lat as number, lng: origin.lng as number }}
            title={origin.address ?? 'Ферма'}
          >
            <FarmPin />
          </AdvancedMarker>
        )}

        {customEnd && (
          <AdvancedMarker position={customEnd} title={end.address ?? 'Край'}>
            <EndPin />
          </AdvancedMarker>
        )}

        {located.map((s, i) => (
          <AdvancedMarker
            key={s.id}
            position={{ lat: s.lat as number, lng: s.lng as number }}
            onClick={() => onPick(s.id)}
          >
            <NumPin n={i + 1} active={activeId === s.id} />
          </AdvancedMarker>
        ))}
      </Map>
    </APIProvider>
  );
}

/** Pin marker content for a delivery stop (mirrors the demo pin look). */
function NumPin({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={cn(
        'grid h-[30px] w-[30px] place-items-center rounded-[50%_50%_50%_2px] shadow-[0_4px_10px_rgba(0,0,0,0.25)]',
        active ? 'bg-ff-amber' : 'bg-ff-green-700',
      )}
      style={{ transform: 'rotate(45deg)' }}
    >
      <span
        className={cn('text-[13.5px] font-extrabold', active ? 'text-[#3a2a08]' : 'text-white')}
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

function EndPin() {
  return (
    <span className="grid h-[28px] w-[28px] place-items-center rounded-full bg-white text-[14px] font-bold text-ff-amber-600 shadow-ff-md ring-2 ring-ff-amber">
      ⚑
    </span>
  );
}

/** Fit the viewport to the farm + all stops (+ custom end). */
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
 * Draw the route line: farm → stops → end (home = back to farm, last = stop,
 * custom = end point). Prefers the real road geometry from the backend (encoded
 * polyline legs decoded via the `geometry` library) so the line follows streets;
 * falls back to straight segments between pins when no geometry is available
 * (maps stub, un-routed order, or a Routes API miss).
 */
function RouteLine({
  origin,
  stops,
  end,
  polyline,
}: {
  origin: Origin;
  stops: RouteStop[];
  end: RouteEnd;
  polyline?: string[] | null;
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
          strokeColor: '#2d6a4f',
          strokeOpacity: 0.9,
          strokeWeight: 4,
        });
        line.setMap(map);
        return () => line.setMap(null);
      }
    }

    // Fallback: straight segments through the ordered pins.
    const path: { lat: number; lng: number }[] = [];
    const start = origin.lat != null && origin.lng != null ? { lat: origin.lat, lng: origin.lng } : null;
    if (start) path.push(start);
    stops.forEach((s) => path.push({ lat: s.lat as number, lng: s.lng as number }));
    if (end.mode === 'home' && start) {
      path.push(start);
    } else if (end.mode === 'custom' && end.lat != null && end.lng != null) {
      path.push({ lat: end.lat, lng: end.lng });
    }
    if (path.length < 2) return;
    const line = new maps.Polyline({
      path,
      strokeColor: '#2d6a4f',
      strokeOpacity: 0.85,
      strokeWeight: 3,
    });
    line.setMap(map);
    return () => line.setMap(null);
  }, [map, maps, geometry, origin, stops, end, polyline]);
  return null;
}

/* ----------------------------- demo fallback ---------------------------- */

/** Deterministic demo-map position (%) for a stop when no real geo is available. */
function demoPos(i: number, n: number): { x: number; y: number } {
  const x = n <= 1 ? 50 : 15 + (i / (n - 1)) * 70;
  const y = Math.min(82, Math.max(14, 38 + Math.sin(i * 1.3 + 0.5) * 20));
  return { x, y };
}

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
