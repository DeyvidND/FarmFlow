import { PDFDocument } from 'pdf-lib';
import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, desc, inArray, ne, isNotNull, isNull } from 'drizzle-orm';
import { type Database, tenants, orders, orderItems, shipments } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret.util';
import { deriveSenderFromFarm } from './econt.sender';
import {
  type EcontStored,
  type InspectMode,
  buildLabel,
  bucketWeight,
  resolveHandling,
} from './econt.label';
import { readSenderBook, applySenderBook, type PickupPoint } from './sender-book';
import { ShipmentEmailService } from './shipment-email.service';
import { CodRiskService } from '../cod-risk/cod-risk.service';
import type { CarrierAdapter } from '../orders/carrier-adapter';

const DEMO_BASE = 'https://demo.econt.com/ee/services';
const PROD_BASE = 'https://ee.econt.com/services';
const COUNTRY = 'BGR';
const NOMENCLATURE_TTL = 60 * 60 * 24; // 1 day
// Short negative-cache TTL for an empty office list (transient Econt outage or
// legitimately-empty nomenclature). 60s means a stampede is absorbed for 1 minute
// while still recovering quickly when Econt comes back.
const EMPTY_OFFICES_TTL = 60; // 60 seconds
// Shipping estimate cache: Econt pricing is stable intraday; 8h balances freshness
// against the checkout latency cost of a live API call.
const ESTIMATE_TTL = 60 * 60 * 8; // 8 hours
// Cap a single bulk label-print request: bounds peak memory + serial Econt fetch
// time, and matches what the admin table realistically selects at once.
const MAX_BULK_LABELS = 50;



interface ResolvedCreds {
  base: string;
  username: string;
  password: string;
}

/**
 * JSONB key path for a delivery account's Econt blob inside `tenants.settings`.
 * Tenant-level (`delivery.econt`) when no farmerId — the existing marketplace-admin
 * account; a per-farmer sub-namespace (`delivery.farmers.<id>.econt`) otherwise.
 * The row selector stays `tenants.id = tenantId` in both cases — a farmer's blob
 * lives INSIDE the marketplace tenant row.
 */
export function econtSettingsPath(farmerId?: string): string[] {
  return farmerId ? ['delivery', 'farmers', farmerId, 'econt'] : ['delivery', 'econt'];
}

/** Read the value at a key path from a settings object (undefined if any hop is absent). */
function readAtPath(settings: unknown, path: string[]): unknown {
  return path.reduce<any>((o, k) => (o == null ? o : o[k]), settings);
}

/**
 * Return a NEW settings object with `value` set at `path`, deep-creating any
 * missing intermediate objects (e.g. `delivery.farmers.<id>` when a tenant has no
 * farmers yet) and structurally sharing untouched siblings. Pure — no mutation of
 * the input.
 */
function writeAtPath(
  settings: Record<string, unknown> | null | undefined,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const root: Record<string, unknown> = { ...(settings ?? {}) };
  let cursor = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const existing = cursor[key];
    const next: Record<string, unknown> =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[key] = next;
    cursor = next;
  }
  cursor[path[path.length - 1]] = value;
  return root;
}

/** A city for the admin sender/office-picker autocomplete. */
export interface EcontCityView {
  id: number;
  name: string;
  postCode: string | null;
}

/** An office shaped for the admin picker + map (includes coordinates + hours). */
export interface EcontOfficeView {
  code: string;
  name: string;
  city: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  hours: string | null;
}

/** Coerce Econt's string|number coordinate into a finite number or null. */
function toCoord(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// Econt returns office business hours as epoch-ms numbers (and HH:mm:ss strings in
// some responses); normalize both to a local "HH:MM" in Bulgarian time.
const HOURS_FMT = new Intl.DateTimeFormat('bg-BG', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Sofia',
  hour12: false,
});
function fmtTime(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    try {
      return HOURS_FMT.format(new Date(v));
    } catch {
      return null;
    }
  }
  if (typeof v === 'string' && v.length >= 5) return v.slice(0, 5);
  return null;
}
function formatHours(from: unknown, to: unknown): string | null {
  const f = fmtTime(from);
  const t = fmtTime(to);
  return f && t ? `${f}–${t}` : null;
}

/** Map a raw Econt office onto the slim admin view (coords + working hours). */
function slimOfficeView(o: any): EcontOfficeView {
  const loc = o?.address?.location ?? {};
  return {
    code: o?.code,
    name: o?.name,
    city: o?.address?.city?.name ?? null,
    address: (o?.address?.fullAddress ?? '').trim() || null,
    lat: toCoord(loc.latitude),
    lng: toCoord(loc.longitude),
    hours: formatHours(o?.normalBusinessHoursFrom, o?.normalBusinessHoursTo),
  };
}

/**
 * Econt courier integration. Talks to Econt's JSON API (demo or prod) with the
 * farm's own Basic-auth credentials, stored encrypted in
 * `tenants.settings.delivery.econt`. Degrades gracefully: with no credentials (or
 * no `ENCRYPTION_KEY`) every call throws a clear 400 and the rest of the app is
 * unaffected (orders still record `econtOffice` as before).
 */
@Injectable()
export class EcontService implements CarrierAdapter {
  private readonly logger = new Logger(EcontService.name);
  private readonly encKey: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly cache: PublicCacheService,
    private readonly shipmentEmail: ShipmentEmailService,
    private readonly codRisk: CodRiskService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY', '');
  }

  /* ------------------------------ credentials ------------------------------ */

  private async loadStored(
    tenantId: string,
    cache?: Map<string, unknown>,
    farmerId?: string,
  ): Promise<{ tenant: { id: string; slug: string; name: string; settings: Record<string, unknown>; isDemo: boolean }; econt: EcontStored }> {
    // Optional per-call memo (bulk import passes one Map per batch): the same tenant's
    // settings are read once per batch instead of on every row's city/office lookup.
    // Absent for all other callers, so their behavior is unchanged (no staleness).
    // The memo key is scoped per-farmer so a tenant-level read and a farmer read of
    // the same tenant row never collide on the cached blob.
    const ck = `econt:${tenantId}:${farmerId ?? ''}`;
    if (cache?.has(ck)) {
      return cache.get(ck) as { tenant: { id: string; slug: string; name: string; settings: Record<string, unknown>; isDemo: boolean }; econt: EcontStored };
    }
    const [row] = await this.db
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, settings: tenants.settings, isDemo: tenants.isDemo })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    const settings = (row.settings as Record<string, unknown> | null) ?? {};
    // Tenant-level when no farmerId; a per-farmer sub-namespace otherwise. The row
    // is the SAME marketplace tenant row either way (selector unchanged).
    const econt = ((readAtPath(settings, econtSettingsPath(farmerId)) as EcontStored | null) ?? {}) as EcontStored;
    const result = { tenant: { id: row.id, slug: row.slug, name: row.name, settings, isDemo: !!row.isDemo }, econt };
    cache?.set(ck, result);
    return result;
  }

  /** Validate creds against Econt (getCities), then store username + encrypted password. */
  async saveCredentials(
    tenantId: string,
    input: { env?: 'demo' | 'prod'; username: string; password: string },
    farmerId?: string,
  ): Promise<{ configured: true; env: 'demo' | 'prod' }> {
    if (!this.encKey) {
      throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран — Econt не може да се запази');
    }
    // Environment is NOT operator-chosen: it's derived from the account's demo
    // flag (set by super-admin). Demo accounts hit Econt's demo API and never
    // create real waybills; real accounts always hit prod. This makes it
    // impossible to accidentally print a real label from a test account.
    const { tenant, econt } = await this.loadStored(tenantId, undefined, farmerId);
    const env: 'demo' | 'prod' = tenant.isDemo ? 'demo' : 'prod';
    const base = env === 'prod' ? PROD_BASE : DEMO_BASE;

    // Live validation: a bad username/password makes getCities fail.
    await this.call(base, input.username, input.password, 'Nomenclatures/NomenclaturesService.getCities.json', {
      countryCode: COUNTRY,
    });

    let nextEcont: EcontStored = {
      ...econt,
      env,
      username: input.username,
      passwordEnc: encryptSecret(input.password, this.encKey),
      configured: true,
    };
    // Best-effort: seed the sender from the farm's own data so the operator never
    // has to fill a profile form. Never let a derivation hiccup fail the connect.
    try {
      let profiles: { name: string; phone: string; clientNumber: string | null }[] = [];
      try {
        const data = await this.call(base, input.username, input.password, 'Profile/ProfileService.getClientProfiles.json', {});
        profiles = slimClientProfiles(data);
      } catch { /* no profiles → fall back to contact/farm name */ }
      const contact = (tenant.settings.contact ?? null) as { phone?: string | null; address?: string | null } | null;
      nextEcont = this.maybeSeedSender(nextEcont, tenant.name || tenant.slug, contact, profiles) as EcontStored;
    } catch { /* seeding is optional */ }

    // Deep-create the path so a farmer write under an absent `delivery.farmers`
    // parent still succeeds, while a tenant-level write keeps targeting delivery.econt.
    const nextSettings = writeAtPath(tenant.settings, econtSettingsPath(farmerId), nextEcont);
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    // Bust the tenant profile (econtMode/econtEnabled) AND the nomenclature caches:
    // switching demo↔prod (or to a different account) makes the previously cached
    // office/city lists wrong — a stale demo office code can fail prod label
    // creation. The storefront picker (`offices`) + admin city autocomplete
    // (`cities`) repopulate on next read. (Per-city office lists are admin-only and
    // ride their 24h TTL.)
    await this.cache.del(
      publicCacheKeys.tenant(tenant.slug),
      `econt:offices:${tenant.slug}`,
      `econt:cities:${tenant.slug}`,
    );
    return { configured: true, env };
  }

  /**
   * Persist the sender/package/COD profile (NOT credentials) into
   * settings.delivery.econt. Merges over the stored blob so the encrypted password
   * is untouched. Backs the dostavki profile editor (the panel writes the same blob
   * via tenants/me; this is the standalone-app path).
   */
  async saveProfile(
    tenantId: string,
    input: {
      sender?: {
        name?: string; phone?: string; cityId?: number; cityName?: string;
        mode?: 'office' | 'address'; officeCode?: string; address?: string;
      };
      defaultPackage?: { weightKg?: number; contents?: string; dimensions?: string };
      cod?: { enabled?: boolean; feePayer?: 'customer' | 'farm' };
      label?: { paper?: string; autoCreate?: boolean };
    },
    farmerId?: string,
  ): Promise<{ ok: true }> {
    const { tenant, econt } = await this.loadStored(tenantId, undefined, farmerId);
    const nextEcont: EcontStored = {
      ...econt,
      ...(input.sender !== undefined ? { sender: { ...(econt.sender ?? {}), ...input.sender } } : {}),
      ...(input.defaultPackage !== undefined
        ? { defaultPackage: { ...(econt.defaultPackage ?? {}), ...input.defaultPackage } }
        : {}),
      ...(input.cod !== undefined ? { cod: { ...(econt.cod ?? {}), ...input.cod } } : {}),
      ...(input.label !== undefined ? { label: { ...(econt.label ?? {}), ...input.label } } : {}),
    };
    const nextSettings = writeAtPath(tenant.settings, econtSettingsPath(farmerId), nextEcont);
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    // The sender/package feed the storefront delivery estimate + label payload.
    await this.cache.del(publicCacheKeys.tenant(tenant.slug));
    return { ok: true };
  }

  /** Pure: build the next econt blob with the book + mirrored active sender. */
  private buildSenderBlob(econt: Record<string, unknown>, senders: PickupPoint[], activeId: string): Record<string, unknown> {
    return applySenderBook(econt, senders, activeId);
  }

  /** Persist the pickup-point book; mirror the active point into `sender`. */
  async saveSenders(tenantId: string, input: { senders: PickupPoint[]; activeId: string }, farmerId?: string): Promise<{ ok: true }> {
    const { tenant, econt } = await this.loadStored(tenantId, undefined, farmerId);
    const nextEcont = this.buildSenderBlob(econt, input.senders, input.activeId);
    const nextSettings = writeAtPath(tenant.settings, econtSettingsPath(farmerId), nextEcont);
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(publicCacheKeys.tenant(tenant.slug));
    return { ok: true };
  }

  /** Public-safe config view (no secrets). `env`/`isDemo` are account-derived so
   *  the operator panel can show a read-only environment badge (no env picker). */
  async getConfig(tenantId: string, farmerId?: string): Promise<Record<string, unknown>> {
    const { tenant, econt } = await this.loadStored(tenantId, undefined, farmerId);
    const { passwordEnc: _pw, ...safe } = econt;
    const book = readSenderBook(econt);
    return {
      ...safe,
      senders: book.senders,
      activeSenderId: book.activeId,
      configured: !!econt.configured,
      isDemo: tenant.isDemo,
      env: tenant.isDemo ? 'demo' : 'prod',
    };
  }

  private async resolveCreds(tenantId: string, cache?: Map<string, unknown>, farmerId?: string): Promise<ResolvedCreds> {
    if (!this.encKey) throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран');
    const { econt } = await this.loadStored(tenantId, cache, farmerId);
    if (!econt.configured || !econt.username || !econt.passwordEnc) {
      throw new BadRequestException('Econt не е конфигуриран за тази ферма');
    }
    return {
      base: econt.env === 'prod' ? PROD_BASE : DEMO_BASE,
      username: econt.username,
      password: decryptSecret(econt.passwordEnc, this.encKey),
    };
  }

  /* ------------------------------- HTTP core ------------------------------- */

  private async call(
    base: string,
    username: string,
    password: string,
    path: string,
    body: unknown,
    timeoutMs = 15000,
  ): Promise<any> {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // Bound the wait so a slow Econt can't hang a checkout (estimate path).
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BadRequestException(
        `Econt недостъпен: ${err instanceof Error ? err.message : 'network error'}`,
      );
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error body
    }
    if (!res.ok) {
      const msg = json?.message || json?.error || text?.slice(0, 200) || `HTTP ${res.status}`;
      throw new BadRequestException(`Econt грешка (${res.status}): ${msg}`);
    }
    return json;
  }

  private async callTenant(
    tenantId: string,
    path: string,
    body: unknown,
    timeoutMs?: number,
    cache?: Map<string, unknown>,
    farmerId?: string,
  ): Promise<any> {
    const c = await this.resolveCreds(tenantId, cache, farmerId);
    return this.call(c.base, c.username, c.password, path, body, timeoutMs);
  }

  /* ----------------------------- nomenclature ------------------------------ */

  async getCities(tenantId: string, farmerId?: string): Promise<any[]> {
    const data = await this.callTenant(tenantId, 'Nomenclatures/NomenclaturesService.getCities.json', {
      countryCode: COUNTRY,
    }, undefined, undefined, farmerId);
    return data?.cities ?? [];
  }

  async getOffices(tenantId: string, cityId?: number, farmerId?: string): Promise<any[]> {
    const body: Record<string, unknown> = { countryCode: COUNTRY };
    if (cityId) body.cityID = cityId;
    const data = await this.callTenant(tenantId, 'Nomenclatures/NomenclaturesService.getOffices.json', body, undefined, undefined, farmerId);
    return data?.offices ?? [];
  }

  /** Sync the office nomenclature into Redis (shared by the storefront picker). */
  async syncNomenclature(tenantId: string, farmerId?: string): Promise<{ cities: number; offices: number }> {
    const { tenant } = await this.loadStored(tenantId, undefined, farmerId);
    const [cities, offices] = await Promise.all([this.getCities(tenantId, farmerId), this.getOffices(tenantId, undefined, farmerId)]);
    const slim = offices.map((o: any) => ({
      code: o.code,
      name: o.name,
      city: o.address?.city?.name ?? null,
      address: o.address?.fullAddress ?? null,
    }));
    await this.cache.set(`econt:offices:${tenant.slug}`, slim, NOMENCLATURE_TTL);
    return { cities: cities.length, offices: offices.length };
  }

  /** Storefront-facing office list for a slug (cached; live fallback). */
  async getPublicOffices(slug: string, city?: string): Promise<any[]> {
    const key = `econt:offices:${slug}`;
    // `null` = cache miss; `[]` = cached-empty (negative cache hit).
    const cached = await this.cache.get<any[]>(key);
    let list: any[];
    if (cached !== null) {
      // Cache hit — could be an empty array (negative cache) or a real list.
      list = cached;
    } else {
      // Cache miss: fetch live from Econt.
      const [t] = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      if (!t) throw new NotFoundException('Фермата не е намерена');
      const offices = await this.getOffices(t.id);
      list = offices.map((o: any) => ({
        code: o.code,
        name: o.name,
        city: o.address?.city?.name ?? null,
        address: o.address?.fullAddress ?? null,
      }));
      // Backfill the cache: without this the full-country Econt fetch above ran on
      // EVERY storefront office-picker request once the 24h TTL lapsed (or before
      // the farm ever pressed Sync) — multi-second + stampede risk on checkout.
      // Cache the empty result under a SHORT TTL so a transient Econt outage or a
      // genuinely-empty nomenclature doesn't trigger a live round-trip on every
      // request; a real list gets the full 24h TTL.
      const ttl = list.length ? NOMENCLATURE_TTL : EMPTY_OFFICES_TTL;
      await this.cache.set(key, list, ttl);
    }
    if (!city) return list.slice(0, 200);
    const q = city.toLowerCase();
    return list.filter((o) => (o.city ?? '').toLowerCase().includes(q)).slice(0, 200);
  }

  /**
   * City autocomplete for the admin delivery setup. The full settlement list
   * (~5.6k rows) is fetched once from Econt and cached; subsequent queries are
   * filtered in-memory (prefix matches first). Requires Econt credentials.
   */
  async searchCities(tenantId: string, q?: string, cache?: Map<string, unknown>, farmerId?: string): Promise<EcontCityView[]> {
    const { tenant } = await this.loadStored(tenantId, cache, farmerId);
    const key = `econt:cities:${tenant.slug}`;
    let list = await this.cache.get<EcontCityView[]>(key);
    if (!list) {
      const cities = await this.getCities(tenantId, farmerId);
      list = cities.map((c: any) => ({ id: c.id, name: c.name, postCode: c.postCode ?? null }));
      await this.cache.set(key, list, NOMENCLATURE_TTL);
    }
    const query = (q ?? '').trim().toLowerCase();
    if (!query) return list.slice(0, 20);
    const starts: EcontCityView[] = [];
    const contains: EcontCityView[] = [];
    for (const c of list) {
      const n = c.name.toLowerCase();
      if (n.startsWith(query)) starts.push(c);
      else if (n.includes(query)) contains.push(c);
    }
    return [...starts, ...contains].slice(0, 20);
  }

  /** Validate a door address against Econt before allowing a label. */
  async validateAddress(
    tenantId: string,
    input: import('./dto/validate-address.dto').ValidateAddressDto,
    farmerId?: string,
  ): Promise<AddressValidation> {
    const data = await this.callTenant(
      tenantId,
      'Nomenclatures/AddressService.validateAddress.json',
      { address: { city: { name: input.city }, other: input.address } },
      undefined,
      undefined,
      farmerId,
    );
    // Econt returns { address: {...}, validationStatus, serviceInfo } — `validationStatus`
    // is a SIBLING of `address`, NOT inside it. Passing `data.address` (the old code) lost
    // it → every address read as invalid. Pass the whole response so the parser finds it.
    return parseAddressValidation(data);
  }

  /** Fetch the farm's saved Econt sender profiles (auto-fill + creds check). */
  async getClientProfiles(tenantId: string, farmerId?: string): Promise<SenderSuggestion[]> {
    const data = await this.callTenant(tenantId, 'Profile/ProfileService.getClientProfiles.json', {}, undefined, undefined, farmerId);
    return slimClientProfiles(data);
  }

  /** Offices in one city (with coordinates + hours) for the admin picker/map. */
  async getOfficesForCity(tenantId: string, cityId: number, cache?: Map<string, unknown>, farmerId?: string): Promise<EcontOfficeView[]> {
    if (!cityId) return [];
    const { tenant } = await this.loadStored(tenantId, cache, farmerId);
    const key = `econt:officesByCity:${tenant.slug}:${cityId}`;
    const cached = await this.cache.get<EcontOfficeView[]>(key);
    if (cached) return cached;
    const offices = await this.getOffices(tenantId, cityId, farmerId);
    const slim = offices.map(slimOfficeView).filter((o) => o.code && o.name);
    await this.cache.set(key, slim, NOMENCLATURE_TTL);
    return slim;
  }

  /* ------------------------------- shipments ------------------------------- */

  /** Merge a derived sender into the econt blob ONLY when none is set yet.
   *  Pure (no I/O) so it is unit-testable; the async fetch happens in the caller. */
  private maybeSeedSender(
    econt: Record<string, unknown>,
    farmName: string,
    contact: { phone?: string | null; address?: string | null } | null | undefined,
    profiles: { name: string; phone: string; clientNumber?: string | null }[] | null | undefined,
  ): Record<string, unknown> {
    const existing = econt.sender as Record<string, unknown> | undefined;
    if (existing && Object.keys(existing).length) return econt;
    return { ...econt, sender: deriveSenderFromFarm(farmName, contact ?? null, profiles ?? []) };
  }

  /** Strip creds off a carrier blob (keep sender/profile). Pure → unit-tested. */
  private clearCredsBlob(econt: Record<string, unknown>): Record<string, unknown> {
    const { username: _u, passwordEnc: _p, ...rest } = econt;
    return { ...rest, configured: false };
  }

  /** Disconnect Econt: clear creds (keep the sender profile), bust caches. */
  async disconnect(tenantId: string, farmerId?: string): Promise<{ configured: false }> {
    const { tenant, econt } = await this.loadStored(tenantId, undefined, farmerId);
    const nextEcont = this.clearCredsBlob(econt);
    const nextSettings = writeAtPath(tenant.settings, econtSettingsPath(farmerId), nextEcont);
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(
      publicCacheKeys.tenant(tenant.slug),
      `econt:offices:${tenant.slug}`,
      `econt:cities:${tenant.slug}`,
    );
    return { configured: false };
  }

  private async orderForShipment(tenantId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!order) throw new NotFoundException('Поръчката не е намерена');
    // 'courier' = a farmer-shipped per-farmer order (Phase 3); it finalizes through
    // the SAME farmer-scoped createLabel as Econt door delivery (address mode).
    if (
      order.deliveryType !== 'econt' &&
      order.deliveryType !== 'econt_address' &&
      order.deliveryType !== 'courier'
    ) {
      throw new BadRequestException('Поръчката не е с доставка чрез Econt');
    }
    const items = await this.db
      .select({ name: orderItems.productName, qty: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    return { order, items };
  }

  /** Cache key for a live estimate. COD bucketed to 10€ (1000 stotinki) so COD
   *  baskets still share entries without colliding with the non-COD price for the
   *  same destination. The `:cod0` suffix is always present so COD and non-COD
   *  calls NEVER share a cache entry (price differs by the COD surcharge). */
  private estimateKeyFor(
    tenantId: string,
    order: { deliveryType?: string | null; deliveryCity?: string | null; econtOffice: string | null },
    weightKg: number,
    codAmountStotinki: number,
  ): string {
    const weightBucket = bucketWeight(weightKg);
    const destination =
      order.deliveryType === 'econt_address'
        ? `city:${(order.deliveryCity ?? '').toLowerCase()}`
        : `office:${order.econtOffice ?? ''}`;
    const codBucket = codAmountStotinki > 0 ? Math.ceil(codAmountStotinki / 1000) * 1000 : 0;
    return `econt:estimate:${tenantId}:${destination}:${weightBucket}kg:cod${codBucket}`;
  }

  /** Price-only estimate (Econt `mode:calculate`). Returns stotinki, or null on any failure. */
  async estimateShipping(
    tenantId: string,
    order: {
      customerName: string | null;
      customerPhone: string | null;
      deliveryType?: string | null;
      econtOffice: string | null;
      deliveryAddress?: string | null;
      deliveryCity?: string | null;
      totalStotinki?: number | null;
    },
    items: { name: string | null; qty: number }[],
    weightKgOverride?: number,
    codAmountStotinki?: number,            // NEW: when > 0, price WITH cash-on-delivery
  ): Promise<number | null> {
    try {
      // Share one tenant-settings read between loadStored here and the resolveCreds
      // inside callTenant below (was two identical SELECTs per estimate on cache miss).
      const store = new Map<string, unknown>();
      const { econt } = await this.loadStored(tenantId, store);
      if (!econt.configured) return null;

      // Build the cache key before calling Econt. Key dimensions:
      //   - tenantId   : pricing/contract differs per farm (never cross-contaminate).
      //   - destination: office code (econt) OR city name (econt_address).
      //   - weightBucket: raw package weight rounded up to nearest 0.5kg so near-
      //     identical baskets reuse the same entry without an extra live call.
      //   - codBucket  : COD amount bucketed to 1000 stotinki — COD and non-COD
      //     prices differ (COD surcharge), so they MUST NOT share a cache entry.
      // We deliberately exclude customerName/phone — those don't affect price.
      const rawWeightKg = weightKgOverride ?? (econt.defaultPackage?.weightKg ?? 1);
      const cod = codAmountStotinki ?? 0;
      const estimateKey = this.estimateKeyFor(tenantId, order, rawWeightKg, cod);

      const cachedEstimate = await this.cache.get<number>(estimateKey);
      if (cachedEstimate !== null) return cachedEstimate;

      // When the caller supplies a weight (the cross-carrier quote), price THAT
      // weight rather than the farm's default package — so both carriers compare
      // the same parcel. Existing callers omit it and keep today's behavior.
      const econtForLabel = weightKgOverride != null
        ? { ...econt, defaultPackage: { ...econt.defaultPackage, weightKg: weightKgOverride } }
        : econt;
      // Inject COD onto the order shape so buildLabel emits services.cdAmount →
      // the calculate price includes the COD fee. paidAt absent → treated as unpaid.
      const orderForLabel = cod > 0
        ? { ...order, paymentMethod: 'cod' as const, paidAt: null, totalStotinki: cod }
        : order;
      const label = buildLabel(econtForLabel, orderForLabel, items);
      // Short timeout: this runs inline during checkout, so prefer the flat-fee
      // fallback over making the customer wait on a slow courier API.
      const data = await this.callTenant(
        tenantId,
        'Shipments/LabelService.createLabel.json',
        { label, mode: 'calculate' },
        6000,
        store,
      );
      // Econt bills in EUR (Bulgaria adopted the euro, 2026), so totalPrice is already
      // EUR — ×100 → stotinki, no BGN→EUR conversion. App currency is EUR end-to-end.
      const totalEur = data?.label?.totalPrice ?? data?.label?.totalPriceVAT;
      // Reject 0 / NaN / Infinity too — never cache a bogus "free shipping" estimate.
      if (!Number.isFinite(totalEur) || totalEur <= 0) return null;
      const stotinki = Math.round(totalEur * 100);
      // Only cache a successful live estimate — never cache the null/fallback path so
      // the next request retries Econt and may obtain a real price.
      await this.cache.set(estimateKey, stotinki, ESTIMATE_TTL);
      return stotinki;
    } catch (err) {
      this.logger.warn(`Econt estimate failed, using flat fee: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Auto-create the Econt waybill for a freshly-paid order when the farm enabled
   * the "create label on paid order" toggle (`econt.label.autoCreate`). Best-effort
   * and non-throwing: it must never disrupt the payment webhook that triggers it,
   * and it is idempotent (skips if a waybill already exists).
   */
  async autoCreateForOrder(orderId: string): Promise<void> {
    try {
      const [order] = await this.db
        .select({ tenantId: orders.tenantId, deliveryType: orders.deliveryType })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!order || !order.tenantId) return;
      if (order.deliveryType !== 'econt' && order.deliveryType !== 'econt_address') return;

      const { econt } = await this.loadStored(order.tenantId);
      const autoCreate = (econt.label as Record<string, unknown> | undefined)?.autoCreate;
      if (!econt.configured || autoCreate !== true) return;

      const [existing] = await this.db
        .select({ number: shipments.econtShipmentNumber })
        .from(shipments)
        .where(eq(shipments.orderId, orderId))
        .limit(1);
      if (existing?.number) return; // already has a waybill

      await this.createLabel(order.tenantId, orderId);
      this.logger.log(`[econt] auto-created waybill for order ${orderId}`);
    } catch (err) {
      this.logger.warn(
        `[econt] auto-create failed for order ${orderId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * COD amount (stotinki) to persist + collect for an order: the order total when
   * this is an UNPAID наложен-платеж order, else null. Mirrors buildLabel's COD gate
   * so the stored amount and the amount on the waybill always agree.
   */
  private codAmountFor(order: {
    paymentMethod?: string | null;
    paidAt?: Date | string | null;
    totalStotinki?: number | null;
  }): number | null {
    const collect = order.paymentMethod === 'cod' && !order.paidAt;
    return collect && order.totalStotinki ? Math.round(order.totalStotinki) : null;
  }

  /** Create the Econt waybill (label) for an order and persist a shipment row. */
  /** {@link CarrierAdapter} alias for {@link createLabel} — keeps the on-demand
   *  label op name uniform with Speedy's `createLabelForOrder`. */
  createLabelForOrder(tenantId: string, orderId: string, farmerId?: string): Promise<typeof shipments.$inferSelect> {
    return this.createLabel(tenantId, orderId, farmerId);
  }

  async createLabel(tenantId: string, orderId: string, farmerId?: string): Promise<typeof shipments.$inferSelect> {
    // Share one settings read between loadStored and the callTenant→resolveCreds below.
    const store = new Map<string, unknown>();
    const { tenant, econt } = await this.loadStored(tenantId, store, farmerId);
    const { order, items } = await this.orderForShipment(tenantId, orderId);
    // Phase 3 authz: a farmer may only finalize THEIR OWN per-farmer order. orderForShipment
    // scopes by tenant, not farmer, so without this a farmer could finalize another farmer's
    // courier order (same tenant) onto their own carrier account. Admin (no farmerId) bypasses;
    // tenant-level orders (no farmer_id) are unaffected.
    const orderFarmerId = (order as { farmerId?: string | null }).farmerId ?? null;
    if (farmerId && orderFarmerId && orderFarmerId !== farmerId) {
      throw new ForbiddenException('Поръчката принадлежи на друга ферма');
    }
    const handling = resolveHandling(tenant.settings);
    const label = buildLabel(
      econt,
      { ...order, refrigerated: handling.refrigerated, inspectBeforePay: handling.inspectBeforePay },
      items,
    );
    const data = await this.callTenant(tenantId, 'Shipments/LabelService.createLabel.json', {
      label,
      mode: 'create',
    }, undefined, store, farmerId);
    const out = data?.label ?? {};
    const number: string | null = out.shipmentNumber ?? null;
    // Same field expression as the estimate (totalPrice ?? totalPriceVAT) so the quoted
    // price and the persisted/charged price can't diverge. EUR (BG euro 2026) → ×100 = stotinki.
    const priceEur: number | undefined = out.totalPrice ?? out.totalPriceVAT;
    const codAmount = this.codAmountFor(order);
    // The owning farmer for a finalized waybill: prefer the order's own farmer_id
    // (the true owner, set on a Phase-3 courier split) and fall back to the caller's
    // farmerId arg. Stays null for legacy tenant-level Econt orders.
    const ownerFarmerId = (order as { farmerId?: string | null }).farmerId ?? farmerId ?? null;

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId,
        farmerId: ownerFarmerId,
        carrier: 'econt',
        econtShipmentNumber: number,
        status: number ? 'created' : 'pending',
        labelPdfUrl: out.pdfURL ?? null,
        courierPriceStotinki: typeof priceEur === 'number' ? Math.round(priceEur * 100) : null,
        codAmountStotinki: codAmount,
        trackingJson: out,
      })
      .onConflictDoUpdate({
        target: shipments.orderId,
        set: {
          // Finalizing a courier DRAFT: set/preserve the owning farmer + carrier so a
          // waybill always carries its true owner and the carrier that produced it.
          farmerId: ownerFarmerId,
          carrier: 'econt',
          econtShipmentNumber: number,
          status: number ? 'created' : 'pending',
          labelPdfUrl: out.pdfURL ?? null,
          codAmountStotinki: codAmount,
          updatedAt: new Date(),
        },
      })
      .returning();
    // Persist the chosen carrier on the order so the courier list / UI reflects which
    // carrier shipped a previously carrier-neutral courier draft.
    await this.db.update(orders).set({ carrier: 'econt' }).where(eq(orders.id, orderId));
    return row;
  }

  /** Create an Econt waybill for a manually-entered shipment (no storefront order).
   *  Persists a `shipments` row with `orderId = null` + the receiver snapshot. */
  async createManualShipment(
    tenantId: string,
    input: import('./dto/manual-shipment.dto').ManualShipmentDto,
    farmerId?: string,
  ): Promise<typeof shipments.$inferSelect> {
    const { econt } = await this.loadStored(tenantId, undefined, farmerId);
    const shape = buildManualOrderShape(input);
    // Per-shipment weight/contents override the farm's defaultPackage for this label.
    const econtForLabel: EcontStored = {
      ...econt,
      defaultPackage: {
        ...econt.defaultPackage,
        ...(shape.weightKg ? { weightKg: shape.weightKg } : {}),
        ...(shape.contents ? { contents: shape.contents } : {}),
      },
    };
    const label = buildLabel(econtForLabel, shape, []);
    const data = await this.callTenant(tenantId, 'Shipments/LabelService.createLabel.json', {
      label,
      mode: 'create',
    }, undefined, undefined, farmerId);
    const out = data?.label ?? {};
    const number: string | null = out.shipmentNumber ?? null;
    // Same field expression as the estimate (totalPrice ?? totalPriceVAT) so the quoted
    // price and the persisted/charged price can't diverge. EUR (BG euro 2026) → ×100 = stotinki.
    const priceEur: number | undefined = out.totalPrice ?? out.totalPriceVAT;
    const codAmount = this.codAmountFor(shape);

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId: null,
        econtShipmentNumber: number,
        status: number ? 'created' : 'pending',
        labelPdfUrl: out.pdfURL ?? null,
        courierPriceStotinki: typeof priceEur === 'number' ? Math.round(priceEur * 100) : null,
        codAmountStotinki: codAmount,
        trackingJson: out,
        receiverName: input.receiverName,
        receiverPhone: input.receiverPhone,
        deliveryMode: input.deliveryMode,
        receiverOfficeCode: input.receiverOfficeCode ?? null,
        receiverCity: input.receiverCity ?? null,
        receiverAddress: input.receiverAddress ?? null,
        weightKg: shape.weightKg ? String(shape.weightKg) : null,
        contents: input.contents ?? null,
      })
      .returning();
    return row;
  }

  /** Book an Econt courier to collect the given (already-created) shipments at the farm. */
  async requestCourier(
    tenantId: string,
    input: import('./dto/courier-request.dto').CourierRequestDto,
    farmerId?: string,
  ): Promise<{ requestId: string | null; status: string | null; attached: number; skipped: number }> {
    const { econt } = await this.loadStored(tenantId, undefined, farmerId);
    // Resolve our shipment ids → Econt waybill numbers (tenant-scoped).
    const rows = await this.db
      .select({ id: shipments.id, number: shipments.econtShipmentNumber })
      .from(shipments)
      .where(
        and(
          eq(shipments.tenantId, tenantId),
          inArray(shipments.id, input.shipmentIds),
          // Farmer dostavki session: only THEIR own shipments may be attached to a pickup.
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      );
    // Only shipments that already have a waybill go into the request — and only
    // those get the request id stamped back (not every requested id).
    const sent = rows.filter((r): r is { id: string; number: string } => !!r.number);
    const numbers = sent.map((r) => r.number);
    if (!numbers.length) throw new BadRequestException('Няма товарителници за заявка на куриер');

    const body = buildCourierRequest(econt, numbers, { timeFrom: input.timeFrom, timeTo: input.timeTo });
    const data = await this.callTenant(tenantId, 'Shipments/ShipmentService.requestCourier.json', body, undefined, undefined, farmerId);
    const requestId: string | null =
      data?.courierRequestID != null ? String(data.courierRequestID) : data?.id != null ? String(data.id) : null;
    const status: string | null = data?.status ?? (requestId ? 'process' : null);

    if (requestId) {
      await this.db
        .update(shipments)
        .set({ courierRequestId: requestId, courierRequestStatus: status, updatedAt: new Date() })
        .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.id, sent.map((r) => r.id))));
    }
    // `attached` = shipments sent to Econt; `skipped` = requested ids without a
    // waybill yet (so the UI can tell the user which weren't included).
    return { requestId, status, attached: numbers.length, skipped: input.shipmentIds.length - sent.length };
  }

  /** Poll an Econt courier-pickup request's status. */
  async getRequestCourierStatus(tenantId: string, requestId: string, farmerId?: string): Promise<{ status: string | null }> {
    const data = await this.callTenant(
      tenantId,
      'Shipments/ShipmentService.getRequestCourierStatus.json',
      { requestCourierId: requestId },
      undefined,
      undefined,
      farmerId,
    );
    const status: string | null = data?.status ?? data?.requestCourierStatus ?? null;
    return { status };
  }

  /** Fetch one shipment's label PDF (tenant-scoped) as a Buffer. */
  async getLabelPdf(tenantId: string, shipmentId: string, farmerId?: string): Promise<Buffer> {
    const [row] = await this.db
      .select({ url: shipments.labelPdfUrl })
      .from(shipments)
      .where(
        and(
          eq(shipments.id, shipmentId),
          eq(shipments.tenantId, tenantId),
          // Farmer dostavki session: scope to THEIR own parcel (cross-farmer → not found).
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    if (!row.url) throw new NotFoundException('Няма PDF за тази товарителница');
    const c = await this.resolveCreds(tenantId, undefined, farmerId);
    return this.fetchLabelPdf(c, row.url);
  }

  /** Fetch + merge several shipments' label PDFs (tenant-scoped) into one Buffer. */
  async getLabelsPdf(tenantId: string, shipmentIds: string[], farmerId?: string): Promise<Buffer> {
    if (!shipmentIds.length) throw new BadRequestException('Няма избрани товарителници');
    if (shipmentIds.length > MAX_BULK_LABELS) {
      throw new BadRequestException(`Максимум ${MAX_BULK_LABELS} товарителници наведнъж`);
    }
    const c = await this.resolveCreds(tenantId, undefined, farmerId);
    const rows = await this.db
      .select({ url: shipments.labelPdfUrl })
      .from(shipments)
      .where(
        and(
          eq(shipments.tenantId, tenantId),
          inArray(shipments.id, shipmentIds),
          // Farmer dostavki session: only THEIR own parcels' labels.
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      );
    const urls = rows.map((r) => r.url).filter((u): u is string => !!u);
    const settled = await Promise.allSettled(urls.map((u) => this.fetchLabelPdf(c, u)));
    const buffers: Buffer[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') buffers.push(s.value);
      else this.logger.warn(`Label PDF fetch failed for ${urls[i]}: ${s.reason instanceof Error ? s.reason.message : s.reason}`);
    });
    if (!buffers.length) throw new NotFoundException('Няма PDF за избраните товарителници');
    return mergePdfs(buffers);
  }

  /** GET an Econt-hosted label PDF using already-resolved Basic credentials. */
  private async fetchLabelPdf(c: ResolvedCreds, url: string): Promise<Buffer> {
    const auth = Buffer.from(`${c.username}:${c.password}`).toString('base64');
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new BadRequestException(
        `Econt PDF недостъпен: ${err instanceof Error ? err.message : 'network error'}`,
      );
    }
    if (!res.ok) throw new BadRequestException(`Econt PDF грешка (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** COD-via-Econt reconciliation rows for the Плащания screen. */
  async codReconciliation(tenantId: string, farmerId?: string): Promise<CodReconRow[]> {
    // Phase 3: a farmer reconciles their OWN courier COD — scope on shipments.farmerId
    // (set on the companion draft) on top of the admin path's tenant + COD-present
    // filters. Exclude un-shipped DRAFTS (status='draft' carries codAmount from creation
    // but no parcel exists yet) so the farmer's „Очаквано" total isn't inflated by orders
    // they haven't dispatched. farmerId == null keeps the tenant-wide admin path unchanged.
    const rows = await this.db
      .select({
        orderId: shipments.orderId,
        expected: shipments.codAmountStotinki,
        collectedAt: shipments.codCollectedAt,
        settledAt: shipments.codSettledAt,
      })
      .from(shipments)
      .where(
        and(
          eq(shipments.tenantId, tenantId),
          isNotNull(shipments.codAmountStotinki),
          // Never count an un-shipped DRAFT as pending COD — unconditional (defensive),
          // so admin and farmer paths can't diverge. Farmer path additionally scopes ownership.
          ne(shipments.status, 'draft'),
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      );
    // TODO(econt-app v2): order-less standalone shipments with COD are excluded here
    // (the Плащания screen keys on orderId). Surface their collected/settled state in a
    // dedicated standalone COD view when the standalone app's payments screen lands.
    return rows
      .filter((r): r is typeof r & { orderId: string } => r.orderId !== null)
      .map((r) => ({
        orderId: r.orderId,
        expectedStotinki: r.expected ?? null,
        collectedAt: r.collectedAt ? r.collectedAt.toISOString() : null,
        settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      }));
  }

  /**
   * Econt orders (office + door) joined with their shipment, shaped for the admin
   * shipments table: every Econt order is shown so the farm can create a waybill,
   * and rows that already have one carry its tracking number + status.
   */
  async listShipments(tenantId: string, farmerId?: string): Promise<AdminShipment[]> {
    // Phase 3: a farmer sees their OWN courier queue. Econt is the single source of the
    // carrier-neutral courier list (a draft has no carrier until ship time, so Speedy
    // returns [] to avoid listing each draft twice — once per carrier tab). We join the
    // farmer's non-cancelled courier orders to their (draft/finalized) shipment row and
    // emit the SAME AdminShipment shape as the admin path via mapShipmentRow.
    if (farmerId) {
      const rows = await this.db
        .select({
          orderId: orders.id,
          customerName: orders.customerName,
          deliveryType: orders.deliveryType,
          total: orders.totalStotinki,
          shipmentId: shipments.id,
          shipmentNumber: shipments.econtShipmentNumber,
          shipmentStatus: shipments.status,
          courierPrice: shipments.courierPriceStotinki,
          labelPdfUrl: shipments.labelPdfUrl,
          codAmount: shipments.codAmountStotinki,
          trackingJson: shipments.trackingJson,
          carrier: shipments.carrier,
          orderCarrier: orders.carrier,
          trackingNumber: shipments.trackingNumber,
          carrierShipmentId: shipments.carrierShipmentId,
        })
        .from(orders)
        .leftJoin(shipments, eq(shipments.orderId, orders.id))
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.deliveryType, 'courier'),
            eq(orders.farmerId, farmerId),
            ne(orders.status, 'cancelled'),
          ),
        )
        .orderBy(desc(orders.createdAt));
      return rows.map(mapShipmentRow);
    }
    // The order-join query and the manual (order-less) query are independent — run
    // them concurrently rather than back-to-back on this hot admin-panel endpoint.
    const [rows, manual] = await Promise.all([
      this.db
        .select({
          orderId: orders.id,
          customerName: orders.customerName,
          deliveryType: orders.deliveryType,
          total: orders.totalStotinki,
          shipmentId: shipments.id,
          shipmentNumber: shipments.econtShipmentNumber,
          shipmentStatus: shipments.status,
          courierPrice: shipments.courierPriceStotinki,
          labelPdfUrl: shipments.labelPdfUrl,
          codAmount: shipments.codAmountStotinki,
          trackingJson: shipments.trackingJson,
          // Carrier columns — needed to route panel actions (print/void/refresh) correctly.
          carrier: shipments.carrier,
          orderCarrier: orders.carrier,
          trackingNumber: shipments.trackingNumber,
          carrierShipmentId: shipments.carrierShipmentId,
        })
        .from(orders)
        .leftJoin(shipments, eq(shipments.orderId, orders.id))
        .where(
          and(
            eq(orders.tenantId, tenantId),
            inArray(orders.deliveryType, ['econt', 'econt_address']),
            ne(orders.status, 'cancelled'),
          ),
        )
        .orderBy(desc(orders.createdAt)),
      // Manual (order-less) shipments created in the standalone app.
      this.db
        .select({
          shipmentId: shipments.id,
          orderId: shipments.orderId,
          receiverName: shipments.receiverName,
          deliveryMode: shipments.deliveryMode,
          shipmentNumber: shipments.econtShipmentNumber,
          shipmentStatus: shipments.status,
          courierPrice: shipments.courierPriceStotinki,
          labelPdfUrl: shipments.labelPdfUrl,
          codAmount: shipments.codAmountStotinki,
          trackingJson: shipments.trackingJson,
          // Carrier columns — needed to route panel actions (print/void/refresh) correctly.
          carrier: shipments.carrier,
          trackingNumber: shipments.trackingNumber,
          carrierShipmentId: shipments.carrierShipmentId,
        })
        .from(shipments)
        .where(and(eq(shipments.tenantId, tenantId), isNull(shipments.orderId)))
        .orderBy(desc(shipments.createdAt)),
    ]);

    const orderShipments = rows.map(mapShipmentRow);
    return [...manual.map(mapManualShipmentRow), ...orderShipments];
  }

  /** Refresh a shipment's status from Econt. */
  async refreshStatus(tenantId: string, shipmentId: string, farmerId?: string): Promise<typeof shipments.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.id, shipmentId),
          eq(shipments.tenantId, tenantId),
          // Farmer dostavki session: scope to THEIR own parcel (cross-farmer → not found).
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    return this.refreshStatusForRow(row, farmerId);
  }

  /**
   * Refresh one shipment from Econt given its already-loaded row. Split out from
   * {@link refreshStatus} so the batch cron can pass the rows it already selected
   * instead of re-SELECTing each (incl. the large trackingJson) per shipment.
   * The cron passes no farmerId (it has no request decorator) → tenant-level creds.
   */
  private async refreshStatusForRow(
    row: typeof shipments.$inferSelect,
    farmerId?: string,
  ): Promise<typeof shipments.$inferSelect> {
    if (!row.econtShipmentNumber || !row.tenantId) return row;
    const tenantId = row.tenantId;
    const data = await this.callTenant(tenantId, 'Shipments/ShipmentService.getShipmentStatuses.json', {
      shipmentNumbers: [row.econtShipmentNumber],
    }, undefined, undefined, farmerId);
    const st = data?.shipmentStatuses?.[0]?.status ?? data?.shipmentStatuses?.[0] ?? null;
    const cod = parseCodReconciliation(st);
    const [updated] = await this.db
      .update(shipments)
      .set({
        status: st?.shortDeliveryStatus ?? st?.deliveryStatus ?? row.status,
        trackingJson: st ?? row.trackingJson,
        codCollectedAt: cod.collectedAt ?? row.codCollectedAt,
        codSettledAt: cod.settledAt ?? row.codSettledAt,
        updatedAt: new Date(),
      })
      .where(and(eq(shipments.id, row.id), eq(shipments.tenantId, tenantId)))
      .returning();
    const newStatus = uiShipmentStatus(updated.econtShipmentNumber, updated.status);
    // Skip the "shipped" email for order-less (standalone) shipments: there is no
    // storefront order to look up a customer email from. `orderId` is null for those.
    if (updated.orderId && updated.econtShipmentNumber && shouldNotifyShipped(newStatus, row.customerNotifiedAt)) {
      await this.shipmentEmail.sendShipped(updated.orderId, updated.econtShipmentNumber);
      await this.db
        .update(shipments)
        .set({ customerNotifiedAt: new Date() })
        .where(and(eq(shipments.id, updated.id), eq(shipments.tenantId, tenantId)));
    }
    // COD-risk strike on a returned/refused COD parcel. Best-effort — must never turn a
    // successful status refresh into a user-facing error (manual refresh has no batch catch).
    try {
      await this.codRisk.recordReturnIfApplicable(updated);
    } catch (err) {
      this.logger.warn(
        `[econt] cod-risk record failed for ${updated.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return updated;
  }

  /**
   * Refresh every not-yet-delivered shipment that has a waybill, across all tenants.
   * Best-effort per shipment — one Econt failure never aborts the batch. Drives the
   * "shipped" email (via refreshStatus) and COD reconciliation (Phase C).
   */
  async refreshActiveShipments(): Promise<{ refreshed: number }> {
    // Only Econt rows that carry a waybill — narrows the scan from the whole table
    // (every carrier, every status, incl. terminal) to the carrier index prefix.
    // Terminal-state exclusion stays in JS: stored `status` is Econt's raw text and
    // uiShipmentStatus maps it by substring, which can't be expressed sargably.
    // Selecting full rows lets refreshStatusForRow run without a per-shipment re-SELECT.
    const rows = await this.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.carrier, 'econt'), isNotNull(shipments.econtShipmentNumber)));
    let refreshed = 0;
    for (const r of rows) {
      if (!r.tenantId) continue;
      // Skip terminal states (delivered + returned/refused) — no point re-polling Econt.
      const ui = uiShipmentStatus(r.econtShipmentNumber, r.status);
      if (ui === 'delivered' || ui === 'returned' || ui === 'refused') continue;
      try {
        await this.refreshStatusForRow(r);
        refreshed++;
      } catch (err) {
        this.logger.warn(
          `[econt] refresh failed for shipment ${r.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { refreshed };
  }

  /** Void (delete) an Econt label and remove the shipment row. */
  async voidShipment(tenantId: string, shipmentId: string, farmerId?: string): Promise<{ id: string }> {
    const [row] = await this.db
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.id, shipmentId),
          eq(shipments.tenantId, tenantId),
          // Farmer dostavki session: scope to THEIR own parcel (cross-farmer → not found).
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    if (row.econtShipmentNumber) {
      await this.callTenant(tenantId, 'Shipments/LabelService.deleteLabels.json', {
        shipmentNumbers: [row.econtShipmentNumber],
      }, undefined, undefined, farmerId);
    }
    await this.db
      .delete(shipments)
      .where(
        and(
          eq(shipments.id, shipmentId),
          eq(shipments.tenantId, tenantId),
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      );
    return { id: shipmentId };
  }
}

export interface CodReconRow {
  orderId: string;
  expectedStotinki: number | null;
  collectedAt: string | null;
  settledAt: string | null;
}

/** Raw joined row from listShipments' query. */
export interface ShipmentJoinRow {
  orderId: string;
  customerName: string | null;
  deliveryType: string | null;
  total: number | null;
  shipmentId: string | null;
  shipmentNumber: string | null;
  shipmentStatus: string | null;
  courierPrice: number | null;
  labelPdfUrl: string | null;
  codAmount: number | null;
  trackingJson: unknown;
  /** Carrier recorded on the shipments row (set for Speedy; null for legacy Econt rows). */
  carrier: string | null;
  /** Carrier recorded on the order (the customer's choice at checkout). */
  orderCarrier: string | null;
  /** Speedy barcode / Econt-fallback tracking number from the shipments row. */
  trackingNumber: string | null;
  /** Speedy internal shipment id (carrierShipmentId column). */
  carrierShipmentId: string | null;
}

/** Admin shipments-table row. */
export interface AdminShipment {
  orderId: string;
  orderNumber: string;
  customerName: string;
  method: 'econtOffice' | 'econtAddress';
  status: 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused';
  /** Which carrier owns this shipment — used by the panel to route print/void/refresh. */
  carrier: 'econt' | 'speedy';
  trackingNumber?: string;
  priceStotinki?: number;
  codAmountStotinki?: number;
  labelPdfUrl?: string;
  shipmentId?: string;
  // True for order-less standalone shipments. For those, `orderId` carries the
  // shipment id as a row key (there is no order) — consumers must NOT use it as a
  // navigable order id when `manual` is set.
  manual?: boolean;
  history: { at: string; label: string; location?: string }[];
}

/** Merge label PDFs into one document. Unreadable buffers are skipped (a single
 *  bad label must not fail the whole bulk print). */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const doc = await PDFDocument.load(buf);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch {
      // skip a corrupt / non-PDF buffer
    }
  }
  return Buffer.from(await merged.save());
}

/** Raw manual-shipment row (no order join). */
export interface ManualShipmentRow {
  shipmentId: string;
  orderId: string | null;
  receiverName: string | null;
  deliveryMode: string | null;
  shipmentNumber: string | null;
  shipmentStatus: string | null;
  courierPrice: number | null;
  labelPdfUrl: string | null;
  codAmount: number | null;
  trackingJson: unknown;
  /** Carrier recorded on the shipments row (set for Speedy; null for legacy Econt rows). */
  carrier: string | null;
  /** Speedy barcode / tracking number from the shipments row. */
  trackingNumber: string | null;
  /** Speedy internal shipment id (carrierShipmentId column). */
  carrierShipmentId: string | null;
}

/** Map a stored order-less shipment onto the admin shipments-table shape. */
export function mapManualShipmentRow(r: ManualShipmentRow): AdminShipment {
  // econtShipmentNumber for Econt rows; trackingNumber (Speedy barcode) for Speedy rows.
  const ref = r.shipmentNumber ?? r.trackingNumber ?? null;
  return {
    orderId: r.shipmentId, // no order — use the shipment id as the row key
    orderNumber: 'Ръчна',
    customerName: r.receiverName ?? '—',
    method: r.deliveryMode === 'address' ? 'econtAddress' : 'econtOffice',
    carrier: (r.carrier ?? 'econt') as 'econt' | 'speedy',
    status: uiShipmentStatus(ref, r.shipmentStatus),
    trackingNumber: ref ?? undefined,
    priceStotinki: r.courierPrice ?? undefined,
    codAmountStotinki: r.codAmount ?? undefined,
    labelPdfUrl: r.labelPdfUrl ?? undefined,
    shipmentId: r.shipmentId,
    manual: true,
    history: mapTrackingEvents(r.trackingJson),
  };
}

/** Map a joined query row onto the admin shipments-table shape. */
export function mapShipmentRow(r: ShipmentJoinRow): AdminShipment {
  // econtShipmentNumber for Econt rows; trackingNumber (Speedy barcode) for Speedy rows.
  const ref = r.shipmentNumber ?? r.trackingNumber ?? null;
  return {
    orderId: r.orderId,
    orderNumber: r.orderId.slice(0, 8),
    customerName: r.customerName ?? '—',
    // Courier IS door delivery, so it maps to the address method on every path.
    method: (r.deliveryType === 'econt_address' || r.deliveryType === 'courier') ? 'econtAddress' : 'econtOffice',
    carrier: (r.carrier ?? r.orderCarrier ?? 'econt') as 'econt' | 'speedy',
    status: uiShipmentStatus(ref, r.shipmentStatus),
    trackingNumber: ref ?? undefined,
    priceStotinki: r.courierPrice ?? r.total ?? undefined,
    codAmountStotinki: r.codAmount ?? undefined,
    labelPdfUrl: r.labelPdfUrl ?? undefined,
    shipmentId: r.shipmentId ?? undefined,
    history: mapTrackingEvents(r.trackingJson),
  };
}

/** The order-like shape `buildLabel` consumes, plus the optional service flags. */
export interface ManualOrderShape {
  customerName: string;
  customerPhone: string;
  deliveryType: 'econt' | 'econt_address';
  econtOffice: string | null;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  totalStotinki: number | null;
  paymentMethod: 'cod' | 'online';
  paidAt: null;
  weightKg?: number;
  contents?: string;
  smsNotification?: boolean;
  refrigerated?: boolean;
  declaredValueStotinki?: number;
  inspectBeforePay?: InspectMode;
}

/** Turn hand-entered receiver input into the order-like shape buildLabel needs.
 *  COD is "the producer entered a COD amount"; weight is grams → kg. */
export function buildManualOrderShape(input: {
  receiverName: string;
  receiverPhone: string;
  deliveryMode: 'office' | 'address';
  receiverOfficeCode?: string;
  receiverCity?: string;
  receiverAddress?: string;
  weightGrams?: number;
  contents?: string;
  codAmountStotinki?: number;
  smsNotification?: boolean;
  refrigerated?: boolean;
  declaredValueStotinki?: number;
  inspectBeforePay?: InspectMode;
}): ManualOrderShape {
  const hasCod = !!input.codAmountStotinki && input.codAmountStotinki > 0;
  return {
    customerName: input.receiverName,
    customerPhone: input.receiverPhone,
    deliveryType: input.deliveryMode === 'address' ? 'econt_address' : 'econt',
    econtOffice: input.deliveryMode === 'office' ? (input.receiverOfficeCode ?? null) : null,
    deliveryCity: input.deliveryMode === 'address' ? (input.receiverCity ?? null) : null,
    deliveryAddress: input.deliveryMode === 'address' ? (input.receiverAddress ?? null) : null,
    totalStotinki: hasCod ? input.codAmountStotinki! : null,
    paymentMethod: hasCod ? 'cod' : 'online',
    paidAt: null,
    ...(input.weightGrams ? { weightKg: input.weightGrams / 1000 } : {}),
    ...(input.contents ? { contents: input.contents } : {}),
    ...(input.smsNotification ? { smsNotification: true } : {}),
    ...(input.refrigerated ? { refrigerated: true } : {}),
    ...(input.declaredValueStotinki ? { declaredValueStotinki: input.declaredValueStotinki } : {}),
    ...(input.inspectBeforePay && input.inspectBeforePay !== 'off'
      ? { inspectBeforePay: input.inspectBeforePay }
      : {}),
  };
}

export interface TrackingEvent {
  at: string;
  label: string;
  location?: string;
}

/** Normalize an Econt tracking time (epoch-ms number or ISO/HH:mm string). */
function trackTime(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  if (typeof v === 'string' && v.length >= 5) return v;
  return '';
}

/** Map an Econt status payload's tracking history into UI events (newest last). */
export function mapTrackingEvents(status: unknown): TrackingEvent[] {
  const s = (status ?? {}) as Record<string, any>;
  const raw: any[] = Array.isArray(s.trackingEvents)
    ? s.trackingEvents
    : Array.isArray(s.tracking)
      ? s.tracking
      : [];
  return raw
    .map((e) => ({
      at: trackTime(e?.time ?? e?.cdDate ?? e?.date),
      // Econt's ShipmentTrackingEvent carries a human-readable Bulgarian narrative
      // (`destinationDetails`); `destinationType` is a raw enum (office/client/…),
      // so prefer the narrative and only fall back to the enum/office name.
      label: String(
        e?.destinationDetails ?? e?.destinationType ?? e?.officeName ?? e?.tracking ?? 'Обновление',
      ).trim(),
      location: e?.officeName
        ? String(e.officeName)
        : e?.cityName
          ? String(e.cityName)
          : undefined,
    }))
    .filter((e) => e.at || e.location);
}

/** Send the buyer the "shipped" email exactly once — when the parcel first reaches
 *  shipped/delivered and we haven't notified before. */
export function shouldNotifyShipped(
  uiStatus: 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused',
  customerNotifiedAt: Date | string | null,
): boolean {
  return !customerNotifiedAt && (uiStatus === 'shipped' || uiStatus === 'delivered');
}

/**
 * Extract COD reconciliation timestamps from an Econt status payload.
 * Field names confirmed from Econt's ShipmentStatus model:
 *   cdCollectedTime — COD collected from the recipient
 *   cdPaidTime      — COD paid/settled to the sender (farm)
 * The JSON API returns these as unix timestamps (seconds or ms) or ISO strings.
 */
export function parseCodReconciliation(status: unknown): { collectedAt: Date | null; settledAt: Date | null } {
  const s = (status ?? {}) as Record<string, any>;
  const toDate = (v: unknown): Date | null => {
    if (typeof v === 'number' && v > 0) {
      // seconds (~10 digits) vs ms (~13 digits): scale seconds up to ms.
      const ms = v < 1e12 ? v * 1000 : v;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'string' && v.length >= 5) {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  };
  return { collectedAt: toDate(s.cdCollectedTime), settledAt: toDate(s.cdPaidTime) };
}

export interface AddressValidation {
  valid: boolean;
  status: string | null;
}

/** Interpret Econt's `validateAddress` response. `normal`/`processed` = usable;
 *  anything else (incl. a shapeless/empty response) = not deliverable. */
export function parseAddressValidation(res: unknown): AddressValidation {
  const r = (res ?? {}) as Record<string, any>;
  const status: string | null = typeof r.validationStatus === 'string' ? r.validationStatus : null;
  return { valid: status === 'normal' || status === 'processed', status };
}

export interface SenderSuggestion {
  name: string;
  phone: string;
  clientNumber: string | null;
}

/** Slim Econt client profiles into sender suggestions. Econt nests the data under
 *  `profiles[].client` in current docs, but some responses are flat — handle both. */
export function slimClientProfiles(res: unknown): SenderSuggestion[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r.profiles) ? r.profiles : [];
  return list.map((p) => {
    const c = p?.client ?? p ?? {};
    const phones: any[] = Array.isArray(c.phones) ? c.phones : [];
    return {
      name: String(c.name ?? '').trim(),
      phone: phones.length ? String(phones[0]) : '',
      clientNumber: c.clientNumber != null ? String(c.clientNumber) : null,
    };
  });
}

/** Build the Econt `requestCourier` payload from the farm's sender profile +
 *  already-created waybill numbers. `shipmentType` casing is verified in the spike
 *  (docs say lowercase `pack`; the PHP SDK sends `PACK`). */
export function buildCourierRequest(
  econt: EcontStored,
  shipmentNumbers: string[],
  window: { timeFrom?: string; timeTo?: string },
): Record<string, unknown> {
  const sender = (econt.sender ?? {}) as Record<string, any>;
  const body: Record<string, unknown> = {
    shipmentType: 'pack',
    shipmentPackCount: shipmentNumbers.length,
    senderClient: { name: sender.name || 'Подател', phones: [sender.phone || ''] },
    attachShipments: shipmentNumbers,
  };
  if (sender.mode === 'address') {
    body.senderAddress = { city: { name: sender.cityName ?? '' }, other: sender.address ?? '' };
  } else {
    if (sender.officeCode) body.senderOfficeCode = sender.officeCode;
  }
  if (window.timeFrom) body.requestTimeFrom = window.timeFrom;
  if (window.timeTo) body.requestTimeTo = window.timeTo;
  return body;
}

/** Collapse Econt's free-text status into the admin table's known status set.
 *  Returned/refused/cancelled parcels collapse to 'returned'/'refused' (matched by the
 *  same Bulgarian substrings as delivery-accounts.helpers.isDeadCodStatus) so they don't
 *  masquerade as delivered/shipped in the panel. */
function uiShipmentStatus(
  number: string | null,
  status: string | null,
): 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused' {
  if (!number) return 'pending';
  const s = (status ?? '').toLowerCase();
  // Check terminal-failure states FIRST — a returned parcel may still carry a delivery word.
  if (s.includes('върн') || s.includes('return')) return 'returned';
  if (s.includes('отказ') || s.includes('анулир') || s.includes('refus') || s.includes('cancel')) return 'refused';
  if (s.includes('достав') || s.includes('deliver')) return 'delivered';
  if (s.includes('транзит') || s.includes('transit') || s.includes('ship')) return 'shipped';
  return 'created';
}
