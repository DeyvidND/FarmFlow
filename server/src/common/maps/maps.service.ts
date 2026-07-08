import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PublicCacheService } from '../cache/public-cache.service';

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
  /** Road geometry (Google's default ENCODED_POLYLINE) for origin→…→destination
   *  in the OPTIMIZED order. Lets a caller whose stop-set fits in one request skip
   *  a second, redundant Routes call (routeFixed) just to get the polyline. */
  polyline: string | null;
}

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const TIMEOUT_MS = 8000;
/** Backstop: reject a geocode this far from the delivery region (gross error). */
const MAX_BIAS_DISTANCE_KM = 120;
/**
 * Cache Routes API results for a week. A route is a pure function of its
 * coordinates, so the same stop-set always yields the same answer — and the key
 * is a hash of the coords, so adding/removing/moving a stop produces a different
 * key (cache miss → recompute). This collapses the cost of the `/route` page's
 * refreshes and order/end-mode toggles to a single billed call per unique
 * stop-set, with zero quality loss. Road-network drift over a week is negligible.
 */
const ROUTE_CACHE_TTL = 7 * 24 * 60 * 60;
/**
 * Cache geocode results for 30 days. Address→coords is as pure a function as a
 * route, and far more repeated (every customer on the same street, every repeat
 * order resolves the same point). Without this, each local order re-bills a
 * Geocoding call; with it, a street is billed once a month. The key folds in the
 * address, the farm bias and the component filters, so any of those changing
 * misses (recompute). Only successful hits are cached — a transient failure (or
 * a fixable typo) must not be remembered as "no such place".
 */
const GEOCODE_CACHE_TTL = 30 * 24 * 60 * 60;
/**
 * Too-coarse Google geocode result types: town/postal/region/country centroids
 * and the `political` area tag. A match is rejected only when EVERY one of its
 * types is in this set — i.e. Google could not resolve anything finer than a
 * whole town/area and fell back to its centroid. With a `locality` component
 * even a gibberish street collapses to the town centre (type `locality`), so we
 * drop it (→ null → the farmer sets the pin) instead of silently routing to a
 * town centre. Anything with a finer type — `sublocality`/`neighborhood` (a real
 * district like кв. Чайка), `route`, `street_address`, `premise`, a plus code,
 * even a POI — is kept, because a correct neighbourhood pin beats a street-precise
 * match in the wrong town. Type-based, so it holds everywhere in BG, not one town.
 */
const COARSE_GEOCODE_TYPES = new Set([
  'country',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'administrative_area_level_4',
  'locality',
  'postal_town',
  'postal_code',
  'postal_code_prefix',
  'political',
]);

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

  constructor(
    config: ConfigService,
    private readonly cache: PublicCacheService,
  ) {
    this.apiKey = config.get<string>('GOOGLE_MAPS_API_KEY')?.trim() ?? '';
    this.enabled = this.apiKey.length > 0;
    if (!this.enabled) {
      this.logger.warn(
        'GOOGLE_MAPS_API_KEY not set — geocoding/routing disabled (stub mode).',
      );
    }
  }

  /** Stable cache key for a Routes API call — a hash of the (rounded) coords in
   *  order. Identical stop-sets collapse to one key; any change misses. */
  private routeKey(prefix: string, coords: LatLng[]): string {
    const sig = coords.map((c) => `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`).join('|');
    return `maps:${prefix}:${createHash('sha1').update(sig).digest('hex')}`;
  }

  /** Cache read that degrades to a miss on a Redis fault (never throws) — a cache
   *  outage must not turn the /route page into a 500; it just recomputes live. */
  private async cachedGet<T>(key: string): Promise<T | null> {
    try {
      return await this.cache.get<T>(key);
    } catch (err) {
      this.logger.warn(`route cache get failed (recomputing): ${(err as Error).message}`);
      return null;
    }
  }

  /** Cache write that never throws — a Redis fault must not discard an already
   *  computed (billed) route. */
  private async cachedSet(key: string, value: unknown, ttl: number = ROUTE_CACHE_TTL): Promise<void> {
    try {
      await this.cache.set(key, value, ttl);
    } catch (err) {
      this.logger.warn(`cache set failed: ${(err as Error).message}`);
    }
  }

  /**
   * Resolve a free-text address to coordinates (restricted to Bulgaria).
   * Pass `bias` (the farm's coords) to prefer matches near the delivery region:
   * an ambiguous street with no city ("ул. Шипка 5") otherwise snaps to the
   * largest city (Sofia) instead of the farm's town. Pass `opts.locality` /
   * `opts.postalCode` (the storefront's structured city/postal fields) to add
   * Geocoding `components` filters — these disambiguate same-named streets in
   * different towns better than the soft bias box alone. Successful results are
   * cached for {@link GEOCODE_CACHE_TTL}. Returns `null` when disabled, on no
   * match, on a too-coarse match, or on any error.
   */
  async geocode(
    address: string,
    bias?: LatLng,
    opts?: { locality?: string; postalCode?: string },
  ): Promise<LatLng | null> {
    const query = address?.trim();
    if (!this.enabled || !query) return null;

    const key = this.geoKey(query, bias, opts);
    const cached = await this.cachedGet<LatLng>(key);
    if (cached) return cached;

    const pick = await this.resolvePick(query, bias, opts);
    const loc = pick?.geometry?.location;
    if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number') return null;
    const ll: LatLng = { lat: loc.lat, lng: loc.lng };
    await this.cachedSet(key, ll, GEOCODE_CACHE_TTL);
    return ll;
  }

  /**
   * Resolve a map point back to a human address (reverse geocoding) — used by
   * the route stop editor when the farmer drops/drags a pin on the embedded
   * map, so the address field can reflect where the pin actually landed.
   * Returns null when disabled, on no match, or on any error — same
   * graceful-degradation contract as every other method here. Cached for
   * {@link GEOCODE_CACHE_TTL}, keyed by coordinates rounded to ~1m precision.
   */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    if (!this.enabled) return null;

    const key = this.reverseGeoKey(lat, lng);
    const cached = await this.cachedGet<string>(key);
    if (cached) return cached;

    const url = `${GEOCODE_URL}?latlng=${lat},${lng}&language=bg&key=${this.apiKey}`;
    try {
      const res = await this.fetchJson(url);
      if (res?.status !== 'OK' || !Array.isArray(res.results) || !res.results.length) {
        if (res?.status && res.status !== 'ZERO_RESULTS') {
          this.logger.warn(`Reverse geocode failed (${res.status}) for ${lat},${lng}.`);
        }
        return null;
      }
      const raw = res.results[0]?.formatted_address;
      if (typeof raw !== 'string' || !raw) return null;
      const address = raw.replace(/,?\s*(България|Bulgaria)\s*$/i, '');
      await this.cachedSet(key, address, GEOCODE_CACHE_TTL);
      return address;
    } catch (err) {
      this.logger.warn(`Reverse geocode error for ${lat},${lng}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Stable cache key for a reverse geocode — coordinates rounded to ~1m. */
  private reverseGeoKey(lat: number, lng: number): string {
    return `maps:reverse:${lat.toFixed(5)},${lng.toFixed(5)}`;
  }

  /**
   * Resolve just the settlement (city/town) name for a typed address — used by the
   * courier / Econt-to-door checkout path, where the buyer may type the address by
   * hand (no Google Places pick) yet the carrier still needs a structured city to
   * route the waybill. Same disambiguation (region bias + component filters) as
   * geocode(); returns null when maps are off, nothing matches, or the resolved
   * place carries no locality component.
   */
  async geocodeCity(
    address: string,
    bias?: LatLng,
    opts?: { locality?: string; postalCode?: string },
  ): Promise<string | null> {
    const query = address?.trim();
    if (!this.enabled || !query) return null;

    const key = `${this.geoKey(query, bias, opts)}:city`;
    const cached = await this.cachedGet<string>(key);
    if (cached) return cached;

    const pick = await this.resolvePick(query, bias, opts);
    const city = pick ? this.cityOf(pick) : null;
    if (city) await this.cachedSet(key, city, GEOCODE_CACHE_TTL);
    return city;
  }

  /** Settlement name from a geocode result's components (locality, else the
   *  county/obshtina level as a fallback). Null when neither is present. */
  private cityOf(pick: { address_components?: unknown }): string | null {
    const comps = Array.isArray(pick?.address_components)
      ? (pick.address_components as { types?: string[]; long_name?: string }[])
      : [];
    const byType = (type: string) =>
      comps.find((c) => Array.isArray(c?.types) && c.types.includes(type))?.long_name ?? null;
    return byType('locality') || byType('administrative_area_level_2') || null;
  }

  /** Stable cache key for a geocode — folds in the normalized address, the farm
   *  bias and the component filters so any change misses. */
  private geoKey(address: string, bias?: LatLng, opts?: { locality?: string; postalCode?: string }): string {
    const sig = [
      address.toLowerCase().replace(/\s+/g, ' '),
      bias ? `${bias.lat.toFixed(4)},${bias.lng.toFixed(4)}` : '',
      (opts?.locality ?? '').trim().toLowerCase(),
      (opts?.postalCode ?? '').trim(),
    ].join('|');
    return `maps:geocode:${createHash('sha1').update(sig).digest('hex')}`;
  }

  /** `&bounds` value: a ~65km box around the farm — biases (not restricts)
   *  results to its region. */
  private biasBounds(bias: LatLng): string {
    const dLat = 0.6;
    const dLng = 0.8;
    const sw = `${(bias.lat - dLat).toFixed(4)},${(bias.lng - dLng).toFixed(4)}`;
    const ne = `${(bias.lat + dLat).toFixed(4)},${(bias.lng + dLng).toFixed(4)}`;
    return `${sw}|${ne}`;
  }

  /** `components` filter: always country:BG, plus the structured locality/postal
   *  when the storefront supplied them. */
  private componentsParam(opts?: { locality?: string; postalCode?: string }): string {
    const parts = ['country:BG'];
    const locality = opts?.locality?.trim();
    const postal = opts?.postalCode?.trim();
    if (locality) parts.push(`locality:${locality}`);
    if (postal) parts.push(`postal_code:${postal}`);
    return parts.join('|');
  }

  /** Resolve the best Google geocoding result for a query: try the structured
   *  component filters first, then fall back to country:BG so an imperfect
   *  city/postal never regresses free-text matching. Drops coarse centroids,
   *  picks the candidate nearest the farm region, and rejects a match grossly far
   *  from it. Returns the raw result (geometry + address_components) or null. */
  private async resolvePick(
    query: string,
    bias?: LatLng,
    opts?: { locality?: string; postalCode?: string },
  ): Promise<any | null> {
    const bounds = bias ? this.biasBounds(bias) : undefined;
    const components = this.componentsParam(opts);
    try {
      // Try with the structured component filters first.
      let pick = await this.pickFrom(query, components, bounds, bias);
      // A `locality`/`postal_code` filter is a HARD constraint: an imperfect city
      // string (typo, abbreviation, diacritics mismatch) can over-filter to
      // ZERO_RESULTS — or fall back to the town centre (coarse) — where the bias
      // box alone would have matched. Retry with just country:BG so structured
      // components never regress the pre-existing free-text behaviour.
      if (!pick && components !== 'country:BG') {
        pick = await this.pickFrom(query, 'country:BG', bounds, bias);
      }
      if (!pick) return null;
      // Backstop: a match far outside the delivery region is almost certainly the
      // wrong place — drop it (shows un-mapped for the farmer to fix).
      const loc = pick.geometry.location;
      if (bias != null && distKm(bias, loc) > MAX_BIAS_DISTANCE_KM) {
        this.logger.warn(
          `Geocode "${query}" resolved ${Math.round(distKm(bias, loc))}km from region — ignoring.`,
        );
        return null;
      }
      return pick;
    } catch (err) {
      this.logger.warn(`Geocode error for "${query}": ${(err as Error).message}`);
      return null;
    }
  }

  /** One Geocoding request → the best street-precise result (geometry +
   *  address_components), or null on no/too-coarse match. Throws on a network/HTTP
   *  fault so the caller can decide (no retry on those). */
  private async pickFrom(
    query: string,
    components: string,
    bounds: string | undefined,
    bias?: LatLng,
  ): Promise<any | null> {
    let url =
      `${GEOCODE_URL}?address=${encodeURIComponent(query)}` +
      `&components=${encodeURIComponent(components)}&language=bg&key=${this.apiKey}`;
    if (bounds) url += `&bounds=${bounds}`;

    const res = await this.fetchJson(url);
    if (res?.status !== 'OK' || !Array.isArray(res.results) || !res.results.length) {
      if (res?.status && res.status !== 'ZERO_RESULTS') {
        this.logger.warn(`Geocode failed (${res.status}) for "${query}".`);
      }
      return null;
    }
    // Drop town/postal/region centroids. An unmatchable / gibberish address does
    // NOT return ZERO_RESULTS — Google falls back to a centroid: the country or
    // region (~200km off) with country:BG alone, or the TOWN centre when a
    // `locality` component is supplied (so even garbage in the street field would
    // otherwise resolve to the city centre). Reject a candidate only when EVERY
    // type it has is coarse; keep anything with a finer type (a real district,
    // street, building, plus code) → null only when there is no real match.
    const candidates = res.results.filter((r: any) => {
      const t: string[] = Array.isArray(r?.types) ? r.types : [];
      return t.some((x) => !COARSE_GEOCODE_TYPES.has(x));
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
    return pick;
  }

  /**
   * Optimize a delivery route: van leaves `origin`, visits every stop in the
   * order the optimizer picks, then finishes at `destination`. With no
   * `destination` it loops back to `origin` (round trip) — Google's
   * computeRoutes can't optimize an open path, so a one-way route with no fixed
   * end is best approximated as a loop. Returns total distance/time plus the
   * optimized visit order. Returns `null` when disabled, when there are no
   * stops, or on any error.
   */
  async route(origin: LatLng, stops: LatLng[], destination?: LatLng): Promise<RoutePlan | null> {
    if (!this.enabled || !stops.length) return null;

    const dest = destination ?? origin;
    // The destination is part of the optimized solution (Google reorders stops
    // for THIS origin→dest), so it must be in the cache key — otherwise a "home"
    // loop and a "custom end" route over the same stops would collide.
    // `route2`: v2 key namespace. v1 entries cached no polyline, so a fresh prefix
    // forces a single recompute that also stores the road geometry, letting a
    // caller whose stop-set fits in one request skip a second Routes call.
    const key = this.routeKey('route2', [origin, ...stops, dest]);
    const cached = await this.cachedGet<RoutePlan>(key);
    if (cached) return cached;

    const waypoint = (p: LatLng) => ({
      location: { latLng: { latitude: p.lat, longitude: p.lng } },
    });
    const body = {
      origin: waypoint(origin),
      destination: waypoint(dest),
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
            'routes.distanceMeters,routes.duration,routes.optimizedIntermediateWaypointIndex,routes.polyline.encodedPolyline',
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
      const polyline = typeof r.polyline?.encodedPolyline === 'string' ? r.polyline.encodedPolyline : null;
      const plan: RoutePlan = { distanceM, durationS, order, polyline };
      await this.cachedSet(key, plan);
      return plan;
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
  async routeFixed(
    points: LatLng[],
  ): Promise<{ distanceM: number; durationS: number; polyline: string | null } | null> {
    if (!this.enabled || points.length < 2) return null;

    // `routefixed2`: v2 key namespace. v1 entries cached only distance/duration
    // (no polyline), so a fresh prefix forces a single recompute that also stores
    // the road geometry instead of serving a week of geometry-less hits.
    const key = this.routeKey('routefixed2', points);
    const cached = await this.cachedGet<{ distanceM: number; durationS: number; polyline: string | null }>(key);
    if (cached) return cached;

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
          'X-Goog-FieldMask':
            'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
        },
        body: JSON.stringify(body),
      });
      const r = res?.routes?.[0];
      if (!r) return null;
      const distanceM = typeof r.distanceMeters === 'number' ? r.distanceMeters : 0;
      const durationS = parseInt(String(r.duration ?? '0'), 10) || 0;
      // Road geometry of this leg (Google's default ENCODED_POLYLINE). The client
      // decodes it so the drawn line follows streets instead of cutting straight
      // between pins.
      const polyline = typeof r.polyline?.encodedPolyline === 'string' ? r.polyline.encodedPolyline : null;
      const out = { distanceM, durationS, polyline };
      await this.cachedSet(key, out);
      return out;
    } catch (err) {
      this.logger.warn(`routeFixed error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Google Places Autocomplete (New), biased to Bulgaria. Returns [] in stub mode
   *  or on any error (graceful). `sessionToken` groups keystrokes into one billed
   *  session — mint one per focus on the client. */
  async placeAutocomplete(query: string, sessionToken: string): Promise<{ description: string; placeId: string }[]> {
    const q = query?.trim();
    if (!this.enabled || !q || q.length < 2) return [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(PLACES_AUTOCOMPLETE_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey },
        body: JSON.stringify({
          input: q,
          sessionToken,
          includedRegionCodes: ['bg'],
          languageCode: 'bg',
        }),
      }).finally(() => clearTimeout(timer));
      if (!res.ok) return [];
      const json = (await res.json()) as {
        suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[];
      };
      return (json.suggestions ?? [])
        .map((s) => ({ description: s.placePrediction?.text?.text ?? '', placeId: s.placePrediction?.placeId ?? '' }))
        .filter((p) => p.description && p.placeId);
    } catch (err) {
      this.logger.warn(`Places autocomplete error for "${q}": ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Attempt one fetch with a hard abort timeout. Returns the Response so the
   * caller can inspect status/headers before consuming the body.
   */
  private async fetchOnce(url: string, init?: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * fetch + JSON parse with a hard per-attempt timeout and ONE bounded retry on
   * transient failures (429 / 5xx). Honours the `Retry-After` response header
   * (capped at 2 s so total latency stays bounded). 4xx errors other than 429
   * are permanent — never retried. Throws on any unrecoverable error or
   * timeout; callers catch and return null.
   */
  private async fetchJson(url: string, init?: RequestInit): Promise<any> {
    const attempt = async (): Promise<{ res: Response; retryable: boolean }> => {
      const res = await this.fetchOnce(url, init);
      if (res.ok) return { res, retryable: false };
      const retryable = res.status === 429 || res.status >= 500;
      return { res, retryable };
    };

    let { res, retryable } = await attempt();

    if (!res.ok && retryable) {
      // Honour Retry-After (integer seconds or HTTP-date); cap at 2 s.
      const retryAfterHeader = res.headers?.get('Retry-After');
      let delayMs = 500; // default back-off
      if (retryAfterHeader) {
        const parsed = Number(retryAfterHeader);
        if (Number.isFinite(parsed) && parsed > 0) {
          delayMs = Math.min(parsed * 1000, 2000);
        }
      }
      await new Promise<void>((r) => setTimeout(r, delayMs));
      const second = await attempt();
      res = second.res;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
