import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoutePlan {
  /** Total driving distance for the optimized loop, in metres. */
  distanceM: number;
  /** Total driving time for the optimized loop, in seconds. */
  durationS: number;
  /**
   * Reordered indices of the input stops as chosen by the optimizer. E.g.
   * `[2, 0, 1]` means visit input stop 2 first, then 0, then 1. Length and
   * contents are a permutation of `0..stops.length-1`.
   */
  order: number[];
}

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 8000;
/** Backstop: reject a geocode this far from the delivery region (gross error). */
const MAX_BIAS_DISTANCE_KM = 120;

/** Straight-line distance (km) between two points. */
function distKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Thin REST wrapper over the Google Maps server APIs (Geocoding + Routes).
 *
 * Mirrors the Stripe/R2 graceful-degradation pattern: with no
 * `GOOGLE_MAPS_API_KEY` set, every method resolves to `null` and the caller
 * keeps its no-maps behaviour (addresses stay un-geocoded; routes report
 * `null` distance/duration). Attach the key to switch everything on — no code
 * changes, no redeploy of callers.
 */
@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly apiKey: string;
  readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('GOOGLE_MAPS_API_KEY')?.trim() ?? '';
    this.enabled = this.apiKey.length > 0;
    if (!this.enabled) {
      this.logger.warn(
        'GOOGLE_MAPS_API_KEY not set — geocoding/routing disabled (stub mode).',
      );
    }
  }

  /**
   * Resolve a free-text address to coordinates (restricted to Bulgaria).
   * Pass `bias` (the farm's coords) to prefer matches near the delivery region:
   * an ambiguous street with no city ("ул. Шипка 5") otherwise snaps to the
   * largest city (Sofia) instead of the farm's town. Returns `null` when
   * disabled, on no match, on a too-coarse match, or on any error.
   */
  async geocode(address: string, bias?: LatLng): Promise<LatLng | null> {
    const query = address?.trim();
    if (!this.enabled || !query) return null;

    let url =
      `${GEOCODE_URL}?address=${encodeURIComponent(query)}` +
      `&components=country:BG&language=bg&key=${this.apiKey}`;
    if (bias) {
      // ~65km box around the farm — biases (not restricts) results to its region.
      const dLat = 0.6;
      const dLng = 0.8;
      const sw = `${(bias.lat - dLat).toFixed(4)},${(bias.lng - dLng).toFixed(4)}`;
      const ne = `${(bias.lat + dLat).toFixed(4)},${(bias.lng + dLng).toFixed(4)}`;
      url += `&bounds=${sw}|${ne}`;
    }

    try {
      const res = await this.fetchJson(url);
      if (res?.status !== 'OK' || !Array.isArray(res.results) || !res.results.length) {
        if (res?.status && res.status !== 'ZERO_RESULTS') {
          this.logger.warn(`Geocode failed (${res.status}) for "${query}".`);
        }
        return null;
      }
      // Drop too-coarse matches. With components=country:BG, an unmatchable or
      // gibberish address doesn't return ZERO_RESULTS — Google falls back to the
      // country (or region) centroid (~200km off). Keep only town/postal/street
      // precision; anything coarser counts as "no match".
      const candidates = res.results.filter((r: any) => {
        const t: string[] = Array.isArray(r?.types) ? r.types : [];
        return !t.includes('country') && !t.includes('administrative_area_level_1');
      });
      if (!candidates.length) {
        this.logger.warn(`Geocode too coarse for "${query}" — ignoring.`);
        return null;
      }
      // With a bias, pick the candidate nearest the delivery region — resolves
      // same-name streets in different towns ("Цар Освободител" in Варна vs a
      // neighbouring town). Without bias, trust Google's top result.
      const pick =
        bias != null
          ? candidates.reduce((best: any, r: any) =>
              distKm(bias, r.geometry.location) < distKm(bias, best.geometry.location) ? r : best,
            )
          : candidates[0];
      const loc = pick?.geometry?.location;
      if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number') return null;
      const out: LatLng = { lat: loc.lat, lng: loc.lng };
      // Backstop: a match far outside the delivery region is almost certainly
      // the wrong place — drop it (shows un-mapped for the farmer to fix).
      if (bias != null && distKm(bias, out) > MAX_BIAS_DISTANCE_KM) {
        this.logger.warn(
          `Geocode "${query}" resolved ${Math.round(distKm(bias, out))}km from region — ignoring.`,
        );
        return null;
      }
      return out;
    } catch (err) {
      this.logger.warn(`Geocode error for "${query}": ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Optimize a delivery loop: van leaves `origin`, visits every stop, returns to
   * `origin`. Returns total distance/time plus the optimized visit order.
   * Returns `null` when disabled, when there are no stops, or on any error.
   */
  async route(origin: LatLng, stops: LatLng[]): Promise<RoutePlan | null> {
    if (!this.enabled || !stops.length) return null;

    const waypoint = (p: LatLng) => ({
      location: { latLng: { latitude: p.lat, longitude: p.lng } },
    });
    const body = {
      origin: waypoint(origin),
      destination: waypoint(origin),
      intermediates: stops.map(waypoint),
      travelMode: 'DRIVE',
      optimizeWaypointOrder: true,
    };

    try {
      const res = await this.fetchJson(ROUTES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask':
            'routes.distanceMeters,routes.duration,routes.optimizedIntermediateWaypointIndex',
        },
        body: JSON.stringify(body),
      });
      const r = res?.routes?.[0];
      if (!r) {
        this.logger.warn(`Routes returned no route (${res?.error?.status ?? 'unknown'}).`);
        return null;
      }
      const distanceM = typeof r.distanceMeters === 'number' ? r.distanceMeters : 0;
      // duration arrives as a protobuf string like "1234s".
      const durationS = parseInt(String(r.duration ?? '0'), 10) || 0;
      // Google may return a sentinel (e.g. [-1]) or an empty index when there's
      // nothing to reorder (0–1 intermediates). Only trust it when it's a real
      // permutation of 0..n-1; otherwise keep the input order.
      const identity = stops.map((_, i) => i);
      const raw = r.optimizedIntermediateWaypointIndex;
      const isPermutation =
        Array.isArray(raw) &&
        raw.length === stops.length &&
        raw.every((i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < stops.length) &&
        new Set(raw).size === stops.length;
      const order: number[] = isPermutation ? raw : identity;
      return { distanceM, durationS, order };
    } catch (err) {
      this.logger.warn(`Routes error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Distance + duration for a FIXED sequence of points (origin → … → end), no
   * reordering. Used when the caller has already decided the visit order (e.g.
   * slot-aware ordering). `points[0]` is the origin, the last is the
   * destination, the rest are intermediates (≤25). Returns null if disabled,
   * fewer than 2 points, or on any error.
   */
  async routeFixed(points: LatLng[]): Promise<{ distanceM: number; durationS: number } | null> {
    if (!this.enabled || points.length < 2) return null;
    const wp = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const body = {
      origin: wp(points[0]),
      destination: wp(points[points.length - 1]),
      intermediates: points.slice(1, -1).map(wp),
      travelMode: 'DRIVE',
    };
    try {
      const res = await this.fetchJson(ROUTES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
        },
        body: JSON.stringify(body),
      });
      const r = res?.routes?.[0];
      if (!r) return null;
      const distanceM = typeof r.distanceMeters === 'number' ? r.distanceMeters : 0;
      const durationS = parseInt(String(r.duration ?? '0'), 10) || 0;
      return { distanceM, durationS };
    } catch (err) {
      this.logger.warn(`routeFixed error: ${(err as Error).message}`);
      return null;
    }
  }

  /** fetch + JSON parse with a hard timeout. Throws on non-2xx or timeout. */
  private async fetchJson(url: string, init?: RequestInit): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
