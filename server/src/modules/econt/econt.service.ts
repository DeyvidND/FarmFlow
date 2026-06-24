import { PDFDocument } from 'pdf-lib';
import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, desc, inArray, ne, isNotNull, isNull } from 'drizzle-orm';
import { type Database, tenants, orders, orderItems, shipments } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret.util';
import { ShipmentEmailService } from './shipment-email.service';

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
// Weight bucket size in kg. Orders within the same bucket share a cache entry so
// near-identical baskets (e.g. 1.1kg and 1.4kg both round to 1.5kg) reuse the
// same estimate rather than causing a live hit per unique weight.
const WEIGHT_BUCKET_KG = 0.5;
// Cap a single bulk label-print request: bounds peak memory + serial Econt fetch
// time, and matches what the admin table realistically selects at once.
const MAX_BULK_LABELS = 50;

/** The stored, sanitized Econt config (never includes the decrypted password). */
interface EcontStored {
  env?: 'demo' | 'prod';
  username?: string;
  passwordEnc?: string;
  configured?: boolean;
  sender?: Record<string, unknown>;
  defaultPackage?: { weightKg?: number; contents?: string; dimensions?: string };
  cod?: { enabled?: boolean; feePayer?: 'customer' | 'farm' };
  // Print-time PDF format only (A4/A6); not a createLabel API field. `autoCreate`
  // makes a paid order auto-generate its waybill (see autoCreateForOrder).
  label?: { paper?: string; autoCreate?: boolean };
  nomenclature?: { lastSyncedAt?: string; cities?: number; offices?: number };
  [k: string]: unknown;
}

/** Parse a free-text "LxWxH" dimension string into three positive numbers (cm). */
function parseDimensions(raw: unknown): { l: number; w: number; h: number } | null {
  if (typeof raw !== 'string') return null;
  const nums = raw
    .split(/[^\d.]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length < 3) return null;
  return { l: nums[0], w: nums[1], h: nums[2] };
}

interface ResolvedCreds {
  base: string;
  username: string;
  password: string;
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
export class EcontService {
  private readonly logger = new Logger(EcontService.name);
  private readonly encKey: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly cache: PublicCacheService,
    private readonly shipmentEmail: ShipmentEmailService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY', '');
  }

  /* ------------------------------ credentials ------------------------------ */

  private async loadStored(tenantId: string): Promise<{ tenant: { id: string; slug: string; settings: Record<string, unknown> }; econt: EcontStored }> {
    const [row] = await this.db
      .select({ id: tenants.id, slug: tenants.slug, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    const settings = (row.settings as Record<string, unknown> | null) ?? {};
    const delivery = (settings.delivery as Record<string, unknown> | null) ?? {};
    const econt = (delivery.econt as EcontStored | null) ?? {};
    return { tenant: { id: row.id, slug: row.slug, settings }, econt };
  }

  /** Validate creds against Econt (getCities), then store username + encrypted password. */
  async saveCredentials(
    tenantId: string,
    input: { env?: 'demo' | 'prod'; username: string; password: string },
  ): Promise<{ configured: true; env: 'demo' | 'prod' }> {
    if (!this.encKey) {
      throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран — Econt не може да се запази');
    }
    const env = input.env ?? 'demo';
    const base = env === 'prod' ? PROD_BASE : DEMO_BASE;

    // Live validation: a bad username/password makes getCities fail.
    await this.call(base, input.username, input.password, 'Nomenclatures/NomenclaturesService.getCities.json', {
      countryCode: COUNTRY,
    });

    const { tenant, econt } = await this.loadStored(tenantId);
    const nextEcont: EcontStored = {
      ...econt,
      env,
      username: input.username,
      passwordEnc: encryptSecret(input.password, this.encKey),
      configured: true,
    };
    const nextSettings = {
      ...tenant.settings,
      delivery: { ...((tenant.settings.delivery as Record<string, unknown>) ?? {}), econt: nextEcont },
    };
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

  /** Public-safe config view (no secrets). */
  async getConfig(tenantId: string): Promise<Record<string, unknown>> {
    const { econt } = await this.loadStored(tenantId);
    const { passwordEnc: _pw, ...safe } = econt;
    return { ...safe, configured: !!econt.configured };
  }

  private async resolveCreds(tenantId: string): Promise<ResolvedCreds> {
    if (!this.encKey) throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран');
    const { econt } = await this.loadStored(tenantId);
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
  ): Promise<any> {
    const c = await this.resolveCreds(tenantId);
    return this.call(c.base, c.username, c.password, path, body, timeoutMs);
  }

  /* ----------------------------- nomenclature ------------------------------ */

  async getCities(tenantId: string): Promise<any[]> {
    const data = await this.callTenant(tenantId, 'Nomenclatures/NomenclaturesService.getCities.json', {
      countryCode: COUNTRY,
    });
    return data?.cities ?? [];
  }

  async getOffices(tenantId: string, cityId?: number): Promise<any[]> {
    const body: Record<string, unknown> = { countryCode: COUNTRY };
    if (cityId) body.cityID = cityId;
    const data = await this.callTenant(tenantId, 'Nomenclatures/NomenclaturesService.getOffices.json', body);
    return data?.offices ?? [];
  }

  /** Sync the office nomenclature into Redis (shared by the storefront picker). */
  async syncNomenclature(tenantId: string): Promise<{ cities: number; offices: number }> {
    const { tenant } = await this.loadStored(tenantId);
    const [cities, offices] = await Promise.all([this.getCities(tenantId), this.getOffices(tenantId)]);
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
  async searchCities(tenantId: string, q?: string): Promise<EcontCityView[]> {
    const { tenant } = await this.loadStored(tenantId);
    const key = `econt:cities:${tenant.slug}`;
    let list = await this.cache.get<EcontCityView[]>(key);
    if (!list) {
      const cities = await this.getCities(tenantId);
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
  ): Promise<AddressValidation> {
    const data = await this.callTenant(
      tenantId,
      'Nomenclatures/AddressService.validateAddress.json',
      { address: { city: { name: input.city }, other: input.address } },
    );
    return parseAddressValidation(data?.address ?? data);
  }

  /** Fetch the farm's saved Econt sender profiles (auto-fill + creds check). */
  async getClientProfiles(tenantId: string): Promise<SenderSuggestion[]> {
    const data = await this.callTenant(tenantId, 'Profile/ProfileService.getClientProfiles.json', {});
    return slimClientProfiles(data);
  }

  /** Offices in one city (with coordinates + hours) for the admin picker/map. */
  async getOfficesForCity(tenantId: string, cityId: number): Promise<EcontOfficeView[]> {
    if (!cityId) return [];
    const { tenant } = await this.loadStored(tenantId);
    const key = `econt:officesByCity:${tenant.slug}:${cityId}`;
    const cached = await this.cache.get<EcontOfficeView[]>(key);
    if (cached) return cached;
    const offices = await this.getOffices(tenantId, cityId);
    const slim = offices.map(slimOfficeView).filter((o) => o.code && o.name);
    await this.cache.set(key, slim, NOMENCLATURE_TTL);
    return slim;
  }

  /* ------------------------------- shipments ------------------------------- */

  private async orderForShipment(tenantId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!order) throw new NotFoundException('Поръчката не е намерена');
    if (order.deliveryType !== 'econt' && order.deliveryType !== 'econt_address') {
      throw new BadRequestException('Поръчката не е с доставка чрез Econt');
    }
    const items = await this.db
      .select({ name: orderItems.productName, qty: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    return { order, items };
  }

  /**
   * Build the Econt `label` payload from an order + the farm's sender profile.
   *
   * Shapes validated live against Econt's API (demo): `senderClient`/`receiverClient`
   * are `{name, phones[]}`; a legal-entity sender is REJECTED without `senderAgent`
   * (authorized person); the hand-in/drop-off points are `senderOfficeCode`/
   * `senderAddress` and `receiverOfficeCode`/`receiverAddress` at the label level.
   * A door address must be structured `{city:{name}, other:"street, №"}` — a bare
   * `fullAddress` errors `ExInvalidCity`. COD rides on `services.cdAmount`.
   */
  private buildLabel(
    econt: EcontStored,
    order: {
      customerName: string | null;
      customerPhone: string | null;
      deliveryType?: string | null;
      econtOffice: string | null;
      deliveryAddress?: string | null;
      deliveryCity?: string | null;
      totalStotinki?: number | null;
      paymentMethod?: string | null;
      paidAt?: Date | string | null;
      smsNotification?: boolean | null;
      refrigerated?: boolean | null;
      declaredValueStotinki?: number | null;
    },
    items: { name: string | null; qty: number }[],
  ): Record<string, unknown> {
    const sender = (econt.sender ?? {}) as Record<string, any>;
    const senderName: string = sender.name || 'Подател';
    const senderPhone: string = sender.phone || '';
    const pkg = econt.defaultPackage;
    const contents =
      pkg?.contents ||
      items.map((i) => `${i.name} x${i.qty}`).join(', ').slice(0, 100) ||
      'Хранителни продукти';

    const label: Record<string, unknown> = {
      senderClient: { name: senderName, phones: [senderPhone] },
      // Authorized person — mandatory for a legal entity, else Econt returns 517.
      senderAgent: { name: senderName, phones: [senderPhone] },
      receiverClient: {
        name: order.customerName ?? 'Клиент',
        phones: [order.customerPhone ?? ''],
      },
      packCount: 1,
      shipmentType: 'pack',
      weight: pkg?.weightKg ?? 1,
      shipmentDescription: contents,
    };

    // Where the parcel is handed in: a sender office, or the farm's own address.
    if (sender.mode === 'address') {
      label.senderAddress = { city: { name: sender.cityName ?? '' }, other: sender.address ?? '' };
    } else {
      label.senderOfficeCode = sender.officeCode ?? undefined;
    }

    // Where it goes: a receiver office, or the customer's door.
    if (order.deliveryType === 'econt_address') {
      label.receiverAddress = {
        city: { name: order.deliveryCity ?? '' },
        other: order.deliveryAddress ?? '',
      };
    } else {
      label.receiverOfficeCode = order.econtOffice ?? undefined;
    }

    // Assemble optional label `services` (COD + SMS + refrigerated + declared value).
    // Emitted only when at least one service applies, so a plain shipment sends no
    // `services` key (keeps the Econt payload minimal + existing tests stable).
    const services: Record<string, unknown> = {};

    // Cash on delivery: collect the order total from the customer (app currency = EUR).
    // Keyed on the ORDER's own payment choice, never on an order already paid online,
    // so a paid Econt order can't be charged a second time at the door.
    const collectCod = order.paymentMethod === 'cod' && !order.paidAt;
    if (collectCod && order.totalStotinki) {
      services.cdAmount = Math.round(order.totalStotinki) / 100;
      services.cdType = 'get';
      services.cdCurrency = 'EUR';
      // Who covers the courier fee on a COD shipment (top-level fields).
      if (econt.cod?.feePayer === 'customer') {
        label.paymentReceiverMethod = 'cash';
      } else if (econt.cod?.feePayer === 'farm') {
        label.paymentSenderMethod = 'cash';
      }
    }

    // SMS to the receiver on the way / on delivery.
    if (order.smsNotification) services.smsNotification = true;
    // Refrigerated/perishable handling (Econt `refrigeratedPack` is an int count).
    if (order.refrigerated) services.refrigeratedPack = 1;
    // Declared value / insurance (обявена стойност), in EUR.
    if (order.declaredValueStotinki && order.declaredValueStotinki > 0) {
      services.declaredValueAmount = Math.round(order.declaredValueStotinki) / 100;
      services.declaredValueCurrency = 'EUR';
    }

    if (Object.keys(services).length) label.services = services;

    // Package dimensions in cm (top-level ShippingLabel fields). The farm stores
    // a free-text "LxWxH"; only send when it cleanly parses into three positive
    // numbers — partial/garbage dimensions make Econt reject the label.
    const dims = parseDimensions(econt.defaultPackage?.dimensions);
    if (dims) {
      label.shipmentDimensionsL = dims.l;
      label.shipmentDimensionsW = dims.w;
      label.shipmentDimensionsH = dims.h;
    }

    return label;
  }

  /**
   * Round a weight (kg) up to the nearest `WEIGHT_BUCKET_KG` bucket so nearby
   * basket weights share a single cache entry. E.g. 1.1kg → 1.5kg, 1.5kg → 1.5kg,
   * 1.6kg → 2.0kg with a 0.5kg bucket.
   */
  private bucketWeight(weightKg: number): number {
    return Math.ceil(weightKg / WEIGHT_BUCKET_KG) * WEIGHT_BUCKET_KG;
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
  ): Promise<number | null> {
    try {
      const { econt } = await this.loadStored(tenantId);
      if (!econt.configured) return null;

      // Build the cache key before calling Econt. Key dimensions:
      //   - tenantId   : pricing/contract differs per farm (never cross-contaminate).
      //   - destination: office code (econt) OR city name (econt_address).
      //   - weightBucket: raw package weight rounded up to nearest 0.5kg so near-
      //     identical baskets reuse the same entry without an extra live call.
      // We deliberately exclude customerName/phone — those don't affect price.
      const rawWeightKg = (econt.defaultPackage?.weightKg ?? 1);
      const weightBucket = this.bucketWeight(rawWeightKg);
      const destination =
        order.deliveryType === 'econt_address'
          ? `city:${(order.deliveryCity ?? '').toLowerCase()}`
          : `office:${order.econtOffice ?? ''}`;
      const estimateKey = `econt:estimate:${tenantId}:${destination}:${weightBucket}kg`;

      const cachedEstimate = await this.cache.get<number>(estimateKey);
      if (cachedEstimate !== null) return cachedEstimate;

      const label = this.buildLabel(econt, order, items);
      // Short timeout: this runs inline during checkout, so prefer the flat-fee
      // fallback over making the customer wait on a slow courier API.
      const data = await this.callTenant(
        tenantId,
        'Shipments/LabelService.createLabel.json',
        { label, mode: 'calculate' },
        6000,
      );
      const totalBgn = data?.label?.totalPrice ?? data?.label?.totalPriceVAT;
      if (typeof totalBgn !== 'number') return null;
      const stotinki = Math.round(totalBgn * 100);
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
  async createLabel(tenantId: string, orderId: string): Promise<typeof shipments.$inferSelect> {
    const { econt } = await this.loadStored(tenantId);
    const { order, items } = await this.orderForShipment(tenantId, orderId);
    const label = this.buildLabel(econt, order, items);
    const data = await this.callTenant(tenantId, 'Shipments/LabelService.createLabel.json', {
      label,
      mode: 'create',
    });
    const out = data?.label ?? {};
    const number: string | null = out.shipmentNumber ?? null;
    const priceBgn: number | undefined = out.totalPrice;
    const codAmount = this.codAmountFor(order);

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId,
        econtShipmentNumber: number,
        status: number ? 'created' : 'pending',
        labelPdfUrl: out.pdfURL ?? null,
        courierPriceStotinki: typeof priceBgn === 'number' ? Math.round(priceBgn * 100) : null,
        codAmountStotinki: codAmount,
        trackingJson: out,
      })
      .onConflictDoUpdate({
        target: shipments.orderId,
        set: {
          econtShipmentNumber: number,
          status: number ? 'created' : 'pending',
          labelPdfUrl: out.pdfURL ?? null,
          codAmountStotinki: codAmount,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /** Create an Econt waybill for a manually-entered shipment (no storefront order).
   *  Persists a `shipments` row with `orderId = null` + the receiver snapshot. */
  async createManualShipment(
    tenantId: string,
    input: import('./dto/manual-shipment.dto').ManualShipmentDto,
  ): Promise<typeof shipments.$inferSelect> {
    const { econt } = await this.loadStored(tenantId);
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
    const label = this.buildLabel(econtForLabel, shape, []);
    const data = await this.callTenant(tenantId, 'Shipments/LabelService.createLabel.json', {
      label,
      mode: 'create',
    });
    const out = data?.label ?? {};
    const number: string | null = out.shipmentNumber ?? null;
    const priceBgn: number | undefined = out.totalPrice;
    const codAmount = this.codAmountFor(shape);

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId: null,
        econtShipmentNumber: number,
        status: number ? 'created' : 'pending',
        labelPdfUrl: out.pdfURL ?? null,
        courierPriceStotinki: typeof priceBgn === 'number' ? Math.round(priceBgn * 100) : null,
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

  /** Fetch one shipment's label PDF (tenant-scoped) as a Buffer. */
  async getLabelPdf(tenantId: string, shipmentId: string): Promise<Buffer> {
    const [row] = await this.db
      .select({ url: shipments.labelPdfUrl })
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    if (!row.url) throw new NotFoundException('Няма PDF за тази товарителница');
    const c = await this.resolveCreds(tenantId);
    return this.fetchLabelPdf(c, row.url);
  }

  /** Fetch + merge several shipments' label PDFs (tenant-scoped) into one Buffer. */
  async getLabelsPdf(tenantId: string, shipmentIds: string[]): Promise<Buffer> {
    if (!shipmentIds.length) throw new BadRequestException('Няма избрани товарителници');
    if (shipmentIds.length > MAX_BULK_LABELS) {
      throw new BadRequestException(`Максимум ${MAX_BULK_LABELS} товарителници наведнъж`);
    }
    const c = await this.resolveCreds(tenantId);
    const rows = await this.db
      .select({ url: shipments.labelPdfUrl })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.id, shipmentIds)));
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
  async codReconciliation(tenantId: string): Promise<CodReconRow[]> {
    const rows = await this.db
      .select({
        orderId: shipments.orderId,
        expected: shipments.codAmountStotinki,
        collectedAt: shipments.codCollectedAt,
        settledAt: shipments.codSettledAt,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), isNotNull(shipments.codAmountStotinki)));
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
  async listShipments(tenantId: string): Promise<AdminShipment[]> {
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
      .orderBy(desc(orders.createdAt));

    const orderShipments = rows.map(mapShipmentRow);

    // Manual (order-less) shipments created in the standalone app.
    const manual = await this.db
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
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), isNull(shipments.orderId)))
      .orderBy(desc(shipments.createdAt));

    return [...manual.map(mapManualShipmentRow), ...orderShipments];
  }

  /** Refresh a shipment's status from Econt. */
  async refreshStatus(tenantId: string, shipmentId: string): Promise<typeof shipments.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    if (!row.econtShipmentNumber) return row;
    const data = await this.callTenant(tenantId, 'Shipments/ShipmentService.getShipmentStatuses.json', {
      shipmentNumbers: [row.econtShipmentNumber],
    });
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
      .where(eq(shipments.id, shipmentId))
      .returning();
    const newStatus = uiShipmentStatus(updated.econtShipmentNumber, updated.status);
    // Skip the "shipped" email for order-less (standalone) shipments: there is no
    // storefront order to look up a customer email from. `orderId` is null for those.
    if (updated.orderId && updated.econtShipmentNumber && shouldNotifyShipped(newStatus, row.customerNotifiedAt)) {
      await this.shipmentEmail.sendShipped(updated.orderId, updated.econtShipmentNumber);
      await this.db
        .update(shipments)
        .set({ customerNotifiedAt: new Date() })
        .where(eq(shipments.id, updated.id));
    }
    return updated;
  }

  /**
   * Refresh every not-yet-delivered shipment that has a waybill, across all tenants.
   * Best-effort per shipment — one Econt failure never aborts the batch. Drives the
   * "shipped" email (via refreshStatus) and COD reconciliation (Phase C).
   */
  async refreshActiveShipments(): Promise<{ refreshed: number }> {
    const rows = await this.db
      .select({
        id: shipments.id,
        tenantId: shipments.tenantId,
        number: shipments.econtShipmentNumber,
        status: shipments.status,
      })
      .from(shipments);
    let refreshed = 0;
    for (const r of rows) {
      if (!r.number) continue;
      if (!r.tenantId) continue;
      if (uiShipmentStatus(r.number, r.status) === 'delivered') continue;
      try {
        await this.refreshStatus(r.tenantId, r.id);
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
  async voidShipment(tenantId: string, shipmentId: string): Promise<{ id: string }> {
    const [row] = await this.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    if (row.econtShipmentNumber) {
      await this.callTenant(tenantId, 'Shipments/LabelService.deleteLabels.json', {
        shipmentNumbers: [row.econtShipmentNumber],
      });
    }
    await this.db.delete(shipments).where(eq(shipments.id, shipmentId));
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
}

/** Admin shipments-table row. */
export interface AdminShipment {
  orderId: string;
  orderNumber: string;
  customerName: string;
  method: 'econtOffice' | 'econtAddress';
  status: 'pending' | 'created' | 'shipped' | 'delivered';
  trackingNumber?: string;
  priceStotinki?: number;
  codAmountStotinki?: number;
  labelPdfUrl?: string;
  shipmentId?: string;
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
}

/** Map a stored order-less shipment onto the admin shipments-table shape. */
export function mapManualShipmentRow(r: ManualShipmentRow): AdminShipment {
  return {
    orderId: r.shipmentId, // no order — use the shipment id as the row key
    orderNumber: 'Ръчна',
    customerName: r.receiverName ?? '—',
    method: r.deliveryMode === 'address' ? 'econtAddress' : 'econtOffice',
    status: uiShipmentStatus(r.shipmentNumber, r.shipmentStatus),
    trackingNumber: r.shipmentNumber ?? undefined,
    priceStotinki: r.courierPrice ?? undefined,
    codAmountStotinki: r.codAmount ?? undefined,
    labelPdfUrl: r.labelPdfUrl ?? undefined,
    shipmentId: r.shipmentId,
    history: mapTrackingEvents(r.trackingJson),
  };
}

/** Map a joined query row onto the admin shipments-table shape. */
export function mapShipmentRow(r: ShipmentJoinRow): AdminShipment {
  return {
    orderId: r.orderId,
    orderNumber: r.orderId.slice(0, 8),
    customerName: r.customerName ?? '—',
    method: r.deliveryType === 'econt_address' ? 'econtAddress' : 'econtOffice',
    status: uiShipmentStatus(r.shipmentNumber, r.shipmentStatus),
    trackingNumber: r.shipmentNumber ?? undefined,
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
  uiStatus: 'pending' | 'created' | 'shipped' | 'delivered',
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

/** Collapse Econt's free-text status into the admin table's known status set. */
function uiShipmentStatus(
  number: string | null,
  status: string | null,
): 'pending' | 'created' | 'shipped' | 'delivered' {
  if (!number) return 'pending';
  const s = (status ?? '').toLowerCase();
  if (s.includes('достав') || s.includes('deliver')) return 'delivered';
  if (s.includes('транзит') || s.includes('transit') || s.includes('ship')) return 'shipped';
  return 'created';
}
