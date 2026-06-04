import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, desc, inArray, ne } from 'drizzle-orm';
import { type Database, tenants, orders, orderItems, shipments } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret.util';

const DEMO_BASE = 'https://demo.econt.com/ee/services';
const PROD_BASE = 'https://ee.econt.com/services';
const COUNTRY = 'BGR';
const NOMENCLATURE_TTL = 60 * 60 * 24; // 1 day

/** The stored, sanitized Econt config (never includes the decrypted password). */
interface EcontStored {
  env?: 'demo' | 'prod';
  username?: string;
  passwordEnc?: string;
  configured?: boolean;
  sender?: Record<string, unknown>;
  defaultPackage?: { weightKg?: number; contents?: string };
  cod?: { enabled?: boolean; feePayer?: 'customer' | 'farm' };
  nomenclature?: { lastSyncedAt?: string; cities?: number; offices?: number };
  [k: string]: unknown;
}

interface ResolvedCreds {
  base: string;
  username: string;
  password: string;
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
    await this.cache.del(`tenant:${tenant.slug}`);
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
    const cached = (await this.cache.get<any[]>(`econt:offices:${slug}`)) ?? [];
    const list = cached.length
      ? cached
      : await (async () => {
          const [t] = await this.db
            .select({ id: tenants.id })
            .from(tenants)
            .where(eq(tenants.slug, slug))
            .limit(1);
          if (!t) throw new NotFoundException('Фермата не е намерена');
          const offices = await this.getOffices(t.id);
          return offices.map((o: any) => ({
            code: o.code,
            name: o.name,
            city: o.address?.city?.name ?? null,
            address: o.address?.fullAddress ?? null,
          }));
        })();
    if (!city) return list.slice(0, 200);
    const q = city.toLowerCase();
    return list.filter((o) => (o.city ?? '').toLowerCase().includes(q)).slice(0, 200);
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
   * Routes to an office (`receiverOfficeCode`) or a home address
   * (`receiverAddress`) depending on the order's delivery method.
   */
  private buildLabel(
    sender: Record<string, unknown> | undefined,
    order: {
      customerName: string | null;
      customerPhone: string | null;
      deliveryType?: string | null;
      econtOffice: string | null;
      deliveryAddress?: string | null;
      deliveryCity?: string | null;
    },
    items: { name: string | null; qty: number }[],
    pkg: { weightKg?: number; contents?: string } | undefined,
  ): Record<string, unknown> {
    const contents =
      pkg?.contents ||
      items.map((i) => `${i.name} x${i.qty}`).join(', ').slice(0, 100) ||
      'Хранителни продукти';
    const base: Record<string, unknown> = {
      senderClient: sender ?? {},
      receiverClient: {
        name: order.customerName ?? 'Клиент',
        phones: [order.customerPhone ?? ''],
      },
      packCount: 1,
      shipmentType: 'pack',
      weight: pkg?.weightKg ?? 1,
      shipmentDescription: contents,
    };
    if (order.deliveryType === 'econt_address') {
      // Door delivery. Pass the settlement structured (Econt routes by city) plus
      // the street as free text; Econt geocodes the rest.
      const receiverAddress: Record<string, unknown> = {
        fullAddress: order.deliveryAddress ?? '',
      };
      if (order.deliveryCity) receiverAddress.city = { name: order.deliveryCity };
      return { ...base, receiverAddress };
    }
    return { ...base, receiverOfficeCode: order.econtOffice ?? undefined };
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
    },
    items: { name: string | null; qty: number }[],
  ): Promise<number | null> {
    try {
      const { econt } = await this.loadStored(tenantId);
      if (!econt.configured) return null;
      const label = this.buildLabel(econt.sender, order, items, econt.defaultPackage);
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
      return Math.round(totalBgn * 100);
    } catch (err) {
      this.logger.warn(`Econt estimate failed, using flat fee: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Create the Econt waybill (label) for an order and persist a shipment row. */
  async createLabel(tenantId: string, orderId: string): Promise<typeof shipments.$inferSelect> {
    const { econt } = await this.loadStored(tenantId);
    const { order, items } = await this.orderForShipment(tenantId, orderId);
    const label = this.buildLabel(econt.sender, order, items, econt.defaultPackage);
    const data = await this.callTenant(tenantId, 'Shipments/LabelService.createLabel.json', {
      label,
      mode: 'create',
    });
    const out = data?.label ?? {};
    const number: string | null = out.shipmentNumber ?? null;
    const priceBgn: number | undefined = out.totalPrice;

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId,
        econtShipmentNumber: number,
        status: number ? 'created' : 'pending',
        labelPdfUrl: out.pdfURL ?? null,
        courierPriceStotinki: typeof priceBgn === 'number' ? Math.round(priceBgn * 100) : null,
        trackingJson: out,
      })
      .onConflictDoUpdate({
        target: shipments.orderId,
        set: {
          econtShipmentNumber: number,
          status: number ? 'created' : 'pending',
          labelPdfUrl: out.pdfURL ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /**
   * Econt orders (office + door) joined with their shipment, shaped for the admin
   * shipments table: every Econt order is shown so the farm can create a waybill,
   * and rows that already have one carry its tracking number + status.
   */
  async listShipments(tenantId: string): Promise<
    {
      orderId: string;
      orderNumber: string;
      customerName: string;
      method: 'econtOffice' | 'econtAddress';
      status: 'pending' | 'created' | 'shipped' | 'delivered';
      trackingNumber?: string;
      priceStotinki?: number;
      shipmentId?: string;
      history: never[];
    }[]
  > {
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

    return rows.map((r) => ({
      orderId: r.orderId,
      orderNumber: r.orderId.slice(0, 8),
      customerName: r.customerName ?? '—',
      method: r.deliveryType === 'econt_address' ? 'econtAddress' : 'econtOffice',
      status: uiShipmentStatus(r.shipmentNumber, r.shipmentStatus),
      trackingNumber: r.shipmentNumber ?? undefined,
      priceStotinki: r.courierPrice ?? r.total ?? undefined,
      shipmentId: r.shipmentId ?? undefined,
      history: [],
    }));
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
    const [updated] = await this.db
      .update(shipments)
      .set({ status: st?.shortDeliveryStatus ?? st?.deliveryStatus ?? row.status, trackingJson: st ?? row.trackingJson, updatedAt: new Date() })
      .where(eq(shipments.id, shipmentId))
      .returning();
    return updated;
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
