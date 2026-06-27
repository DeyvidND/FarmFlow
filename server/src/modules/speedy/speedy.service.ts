import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, desc, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { type Database, tenants, shipments, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret.util';
import { SpeedyClient, type SpeedyCreds } from './speedy.client';
import {
  type SpeedyStored, slimSites, slimOffices, slimStreets, slimContractClients,
  type SpeedySite, type SpeedyOffice, type SpeedyStreet, type SenderSuggestion,
  buildShipmentRequest, buildOrderShipmentInput, parseTrackStatus, parsePayouts, type CanonicalStatus,
} from './speedy.helpers';
import { mergePdfs } from '../econt/econt.service';
import { SpeedyManualShipmentDto } from './dto/speedy-manual-shipment.dto';
import { SpeedyCredentialsDto } from './dto/speedy-credentials.dto';
import { SpeedyValidateAddressDto } from './dto/speedy-validate-address.dto';
import { SpeedyCourierRequestDto } from './dto/speedy-courier-request.dto';
import { CodRiskService } from '../cod-risk/cod-risk.service';

const SPEEDY_BASE = 'https://api.speedy.bg/v1';
const NOMENCLATURE_TTL = 60 * 60 * 24; // 1 day
const EMPTY_TTL = 60; // negative-cache empty lookups for 60s
const MAX_BULK_LABELS = 50;
// Estimate cache: Speedy pricing is stable intraday; 8h balances freshness vs.
// the latency of a live /calculate call. Weight is bucketed to 0.5kg so near-
// identical parcels reuse one entry.
const ESTIMATE_TTL = 60 * 60 * 8; // 8 hours
const WEIGHT_BUCKET_KG = 0.5;
// Fallback Speedy courier-service code when the tenant set no defaultServiceId.
// spike: confirm a valid default service id via /services/destination.
const SPEEDY_DEFAULT_SERVICE_ID = 505;

/** A Speedy shipment row shaped for the standalone shipments table. */
export interface SpeedyShipment {
  shipmentId: string;
  receiverName: string;
  deliveryMode: 'office' | 'address';
  status: CanonicalStatus;
  trackingNumber: string | null;
  priceStotinki: number | null;
  codAmountStotinki: number | null;
}

@Injectable()
export class SpeedyService {
  private readonly logger = new Logger(SpeedyService.name);
  private readonly encKey: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly cache: PublicCacheService,
    private readonly client: SpeedyClient,
    private readonly codRisk: CodRiskService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY', '');
  }

  /* ------------------------------ credentials ------------------------------ */

  private async loadStored(
    tenantId: string,
    cache?: Map<string, unknown>,
  ): Promise<{ tenant: { id: string; slug: string; settings: Record<string, unknown>; isDemo: boolean }; speedy: SpeedyStored }> {
    // Optional per-call memo (bulk import passes one Map per batch): reads the tenant
    // settings once per batch instead of on every row's site/office/street lookup.
    // Absent for all other callers, so their behavior is unchanged (no staleness).
    const ck = `speedy:${tenantId}`;
    if (cache?.has(ck)) {
      return cache.get(ck) as { tenant: { id: string; slug: string; settings: Record<string, unknown>; isDemo: boolean }; speedy: SpeedyStored };
    }
    const [row] = await this.db
      .select({ id: tenants.id, slug: tenants.slug, settings: tenants.settings, isDemo: tenants.isDemo })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    const settings = (row.settings as Record<string, unknown> | null) ?? {};
    const delivery = (settings.delivery as Record<string, unknown> | null) ?? {};
    const speedy = (delivery.speedy as SpeedyStored | null) ?? {};
    const result = { tenant: { id: row.id, slug: row.slug, settings, isDemo: !!row.isDemo }, speedy };
    cache?.set(ck, result);
    return result;
  }

  private async resolveCreds(tenantId: string): Promise<SpeedyCreds> {
    if (!this.encKey) throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран');
    const { speedy } = await this.loadStored(tenantId);
    if (!speedy.configured || !speedy.userName || !speedy.passwordEnc) {
      throw new BadRequestException('Speedy не е конфигуриран за тази ферма');
    }
    return {
      base: SPEEDY_BASE,
      userName: speedy.userName,
      password: decryptSecret(speedy.passwordEnc, this.encKey),
      clientSystemId: speedy.clientSystemId,
    };
  }

  /** Validate creds against Speedy (a cheap /client call), then store encrypted. */
  async saveCredentials(tenantId: string, input: SpeedyCredentialsDto): Promise<{ configured: true }> {
    if (!this.encKey) {
      throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран — Speedy не може да се запази');
    }
    // Live validation: bad creds make /client fail.
    await this.client.call(
      { base: SPEEDY_BASE, userName: input.userName, password: input.password, clientSystemId: input.clientSystemId },
      'client',
      {},
    );

    const { tenant, speedy } = await this.loadStored(tenantId);
    // Env is account-derived (demo flag), never operator-chosen — mirrors Econt.
    const nextSpeedy: SpeedyStored = {
      ...speedy,
      env: tenant.isDemo ? 'demo' : 'prod',
      userName: input.userName,
      passwordEnc: encryptSecret(input.password, this.encKey),
      ...(input.clientSystemId != null ? { clientSystemId: input.clientSystemId } : {}),
      ...(input.defaultServiceId != null ? { defaultServiceId: input.defaultServiceId } : {}),
      configured: true,
    };
    const nextSettings = {
      ...tenant.settings,
      delivery: { ...((tenant.settings.delivery as Record<string, unknown>) ?? {}), speedy: nextSpeedy },
    };
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(`speedy:sites:${tenant.slug}`);
    return { configured: true };
  }

  async getConfig(tenantId: string): Promise<Record<string, unknown>> {
    const { tenant, speedy } = await this.loadStored(tenantId);
    const { passwordEnc: _pw, ...safe } = speedy;
    return { ...safe, configured: !!speedy.configured, isDemo: tenant.isDemo, env: tenant.isDemo ? 'demo' : 'prod' };
  }

  /* ------------------------------- location -------------------------------- */

  async searchSites(tenantId: string, q?: string, cache?: Map<string, unknown>): Promise<SpeedySite[]> {
    const { tenant } = await this.loadStored(tenantId, cache);
    const key = `speedy:sites:${tenant.slug}`;
    let list = await this.cache.get<SpeedySite[]>(key);
    if (list === null) {
      const creds = await this.resolveCreds(tenantId);
      const data = await this.client.callSafe(creds, 'location/site', { countryId: 100 });
      list = slimSites(data);
      await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    }
    const query = (q ?? '').trim().toLowerCase();
    if (!query) return list.slice(0, 20);
    const starts: SpeedySite[] = [];
    const contains: SpeedySite[] = [];
    for (const s of list) {
      const n = s.name.toLowerCase();
      if (n.startsWith(query)) starts.push(s);
      else if (n.includes(query)) contains.push(s);
    }
    return [...starts, ...contains].slice(0, 20);
  }

  async getOffices(tenantId: string, siteId: number, cache?: Map<string, unknown>): Promise<SpeedyOffice[]> {
    if (!siteId) return [];
    const { tenant } = await this.loadStored(tenantId, cache);
    const key = `speedy:offices:${tenant.slug}:${siteId}`;
    const cached = await this.cache.get<SpeedyOffice[]>(key);
    if (cached !== null) return cached;
    const creds = await this.resolveCreds(tenantId);
    const data = await this.client.callSafe(creds, 'location/office', { countryId: 100, siteId });
    const list = slimOffices(data);
    await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    return list;
  }

  async getStreets(tenantId: string, siteId: number, q?: string, cache?: Map<string, unknown>): Promise<SpeedyStreet[]> {
    if (!siteId) return [];
    const { tenant } = await this.loadStored(tenantId, cache);
    const key = `speedy:streets:${tenant.slug}:${siteId}`;
    let list = await this.cache.get<SpeedyStreet[]>(key);
    if (list === null) {
      const creds = await this.resolveCreds(tenantId);
      const data = await this.client.callSafe(creds, 'location/street', { siteId });
      list = slimStreets(data);
      await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    }
    const query = (q ?? '').trim().toLowerCase();
    if (!query) return list.slice(0, 20);
    return list.filter((s) => s.name.toLowerCase().includes(query)).slice(0, 20);
  }

  async validateAddress(
    tenantId: string,
    input: SpeedyValidateAddressDto,
  ): Promise<{ valid: boolean; status: string | null }> {
    const creds = await this.resolveCreds(tenantId);
    const address: Record<string, unknown> =
      input.officeId != null
        ? { countryId: 100, siteId: input.siteId, officeId: input.officeId }
        : { countryId: 100, siteId: input.siteId, streetId: input.streetId, streetNo: input.streetNo };
    const data = await this.client.call(creds, 'validation/address', { address });
    // Speedy returns a `validationMode`/`valid` flag. // spike: confirm field name.
    const valid = data?.valid === true || data?.validationMode === 'VALID';
    return { valid, status: data?.validationMode ?? null };
  }

  async getClientProfiles(tenantId: string): Promise<SenderSuggestion[]> {
    const creds = await this.resolveCreds(tenantId);
    const data = await this.client.call(creds, 'client/contract', {});
    return slimContractClients(data);
  }

  /* ------------------------------- shipments ------------------------------- */

  /** Create a Speedy waybill for a hand-entered receiver (no storefront order). */
  async createManualShipment(
    tenantId: string,
    input: SpeedyManualShipmentDto,
  ): Promise<typeof shipments.$inferSelect> {
    const { speedy } = await this.loadStored(tenantId);
    const creds = await this.resolveCreds(tenantId);
    const body = buildShipmentRequest(speedy, input);
    const data = await this.client.call(creds, 'shipment', body);

    const shipmentId: string | null = data?.id != null ? String(data.id) : null;
    const parcels: any[] = Array.isArray(data?.parcels) ? data.parcels : [];
    const barcode: string | null = parcels.length ? String(parcels[0]?.barcode ?? parcels[0]?.id ?? '') || null : null;
    // spike: confirm the create-shipment price field name(s) vs live API.
    const priceEur: number | undefined = data?.price?.total ?? data?.price?.amount;
    const codAmount = input.codAmountStotinki && input.codAmountStotinki > 0 ? Math.round(input.codAmountStotinki) : null;

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId: null,
        carrier: 'speedy',
        carrierShipmentId: shipmentId,
        trackingNumber: barcode,
        status: barcode ? 'created' : 'pending',
        labelPdfUrl: null,
        courierPriceStotinki: typeof priceEur === 'number' ? Math.round(priceEur * 100) : null,
        codAmountStotinki: codAmount,
        trackingJson: data ?? null,
        receiverName: input.receiverName,
        receiverPhone: input.receiverPhone,
        deliveryMode: input.deliveryMode,
        receiverOfficeCode: input.officeId != null ? String(input.officeId) : null,
        receiverCity: input.siteId != null ? String(input.siteId) : null,
        weightKg: input.weightGrams ? String(input.weightGrams / 1000) : null,
        contents: input.contents ?? null,
      })
      .returning();
    return row;
  }

  /** Load a tenant-scoped order for waybill creation. Throws if absent. */
  private async orderForShipment(tenantId: string, orderId: string) {
    const [row] = await this.db
      .select({
        tenantId: orders.tenantId,
        deliveryCity: orders.deliveryCity,
        deliveryAddress: orders.deliveryAddress,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        paymentMethod: orders.paymentMethod,
        paidAt: orders.paidAt,
        totalStotinki: orders.totalStotinki,
      })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    return row;
  }

  /** Create the Speedy waybill for an order and UPSERT a shipments row (one per order). */
  async createLabelForOrder(tenantId: string, orderId: string): Promise<typeof shipments.$inferSelect> {
    const { speedy } = await this.loadStored(tenantId);
    if (!speedy.configured) throw new BadRequestException('Speedy не е конфигуриран за тази ферма');

    const order = await this.orderForShipment(tenantId, orderId);
    const sites = await this.searchSites(tenantId, order.deliveryCity ?? '');
    const siteId = sites[0]?.id;
    if (!siteId) throw new BadRequestException('Населеното място не е намерено в Speedy');

    const creds = await this.resolveCreds(tenantId);
    const input = buildOrderShipmentInput(speedy, order, siteId);
    const body = buildShipmentRequest(speedy, input);
    const data = await this.client.call(creds, 'shipment', body);

    const shipmentId: string | null = data?.id != null ? String(data.id) : null;
    const parcels: any[] = Array.isArray(data?.parcels) ? data.parcels : [];
    const barcode: string | null = parcels.length ? String(parcels[0]?.barcode ?? parcels[0]?.id ?? '') || null : null;
    const priceEur: number | undefined = data?.price?.total ?? data?.price?.amount;
    const codAmount = input.codAmountStotinki && input.codAmountStotinki > 0 ? Math.round(input.codAmountStotinki) : null;

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId,
        carrier: 'speedy',
        carrierShipmentId: shipmentId,
        trackingNumber: barcode,
        status: barcode ? 'created' : 'pending',
        courierPriceStotinki: typeof priceEur === 'number' ? Math.round(priceEur * 100) : null,
        codAmountStotinki: codAmount,
        trackingJson: data ?? null,
        deliveryMode: 'address',
      })
      .onConflictDoUpdate({
        target: shipments.orderId,
        set: {
          carrier: 'speedy',
          carrierShipmentId: shipmentId,
          trackingNumber: barcode,
          status: barcode ? 'created' : 'pending',
          courierPriceStotinki: typeof priceEur === 'number' ? Math.round(priceEur * 100) : null,
          codAmountStotinki: codAmount,
          trackingJson: data ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /** Speedy shipments for this tenant (order-less), newest first. */
  async listShipments(tenantId: string): Promise<SpeedyShipment[]> {
    const rows = await this.db
      .select({
        shipmentId: shipments.id,
        receiverName: shipments.receiverName,
        deliveryMode: shipments.deliveryMode,
        status: shipments.status,
        trackingNumber: shipments.trackingNumber,
        priceStotinki: shipments.courierPriceStotinki,
        codAmountStotinki: shipments.codAmountStotinki,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')))
      .orderBy(desc(shipments.createdAt));
    return rows.map((r) => ({
      shipmentId: r.shipmentId,
      receiverName: r.receiverName ?? '—',
      deliveryMode: r.deliveryMode === 'address' ? 'address' : 'office',
      status: (r.status as CanonicalStatus) ?? 'pending',
      trackingNumber: r.trackingNumber,
      priceStotinki: r.priceStotinki,
      codAmountStotinki: r.codAmountStotinki,
    }));
  }

  /** One Speedy label PDF (tenant-scoped) — fetched live via /print. */
  async getLabelPdf(tenantId: string, shipmentId: string): Promise<Buffer> {
    const [row] = await this.db
      .select({ id: shipments.carrierShipmentId, barcode: shipments.trackingNumber })
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    const ref = row.id ?? row.barcode;
    if (!ref) throw new NotFoundException('Няма товарителница за тази пратка');
    const creds = await this.resolveCreds(tenantId);
    return this.client.callBinary(creds, 'print', { paperSize: 'A6', parcels: [{ parcel: { id: ref } }] });
  }

  /** Several Speedy labels merged into one PDF (tenant-scoped). */
  async getLabelsPdf(tenantId: string, shipmentIds: string[]): Promise<Buffer> {
    if (!shipmentIds.length) throw new BadRequestException('Няма избрани товарителници');
    if (shipmentIds.length > MAX_BULK_LABELS) {
      throw new BadRequestException(`Максимум ${MAX_BULK_LABELS} товарителници наведнъж`);
    }
    const creds = await this.resolveCreds(tenantId);
    const rows = await this.db
      .select({ id: shipments.carrierShipmentId, barcode: shipments.trackingNumber })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy'), inArray(shipments.id, shipmentIds)));
    const refs = rows.map((r) => r.id ?? r.barcode).filter((x): x is string => !!x);
    const settled = await Promise.allSettled(
      refs.map((ref) => this.client.callBinary(creds, 'print', { paperSize: 'A6', parcels: [{ parcel: { id: ref } }] })),
    );
    const buffers: Buffer[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') buffers.push(s.value);
      else this.logger.warn(`[speedy] label fetch failed for ${refs[i]}: ${s.reason instanceof Error ? s.reason.message : s.reason}`);
    });
    if (!buffers.length) throw new NotFoundException('Няма PDF за избраните товарителници');
    return mergePdfs(buffers);
  }

  /** Cancel a Speedy waybill (pre-pickup) and remove the shipment row. */
  async voidShipment(tenantId: string, shipmentId: string): Promise<{ id: string }> {
    const [row] = await this.db
      .select({ id: shipments.id, carrierShipmentId: shipments.carrierShipmentId })
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    // Only drop the local row once the carrier waybill is actually gone. If Speedy rejects
    // the cancel (parcel already picked up / past the cancel window) the paid waybill is
    // still LIVE — deleting our row here would orphan it, so we surface the error instead.
    if (row.carrierShipmentId) {
      const creds = await this.resolveCreds(tenantId);
      try {
        await this.client.call(creds, 'shipment/cancel', { shipmentId: row.carrierShipmentId });
      } catch (err) {
        this.logger.warn(`[speedy] cancel failed for ${row.carrierShipmentId}: ${err instanceof Error ? err.message : err}`);
        throw new BadRequestException(
          'Speedy отказа анулирането (пратката вероятно вече е приета). Товарителницата остава активна.',
        );
      }
    }
    await this.db.delete(shipments).where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)));
    return { id: shipmentId };
  }

  /* ------------------------- tracking + COD + courier ---------------------- */

  /** Refresh a Speedy shipment's status from /track. Persists the canonical status
   *  and fires the COD-risk hook (best-effort) on a returned/refused COD parcel. */
  async refreshStatus(tenantId: string, shipmentId: string): Promise<typeof shipments.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    return this.refreshStatusForRow(row);
  }

  /**
   * Refresh one Speedy shipment from its already-loaded row. Split out from
   * {@link refreshStatus} so the batch cron passes the rows it already selected
   * instead of re-SELECTing each (incl. the large trackingJson) per shipment.
   */
  private async refreshStatusForRow(
    row: typeof shipments.$inferSelect,
  ): Promise<typeof shipments.$inferSelect> {
    if (!row.trackingNumber || !row.tenantId) return row;

    const creds = await this.resolveCreds(row.tenantId);
    const data = await this.client.call(creds, 'track', { parcels: [{ id: row.trackingNumber }] });
    const parcel = Array.isArray(data?.parcels) ? data.parcels[0] : null;
    const operations: any[] = Array.isArray(parcel?.operations) ? parcel.operations : [];
    const status = parseTrackStatus(operations, true);

    const [updated] = await this.db
      .update(shipments)
      .set({ status, trackingJson: parcel ?? row.trackingJson, updatedAt: new Date() })
      .where(eq(shipments.id, row.id))
      .returning();

    // COD-risk strike on a returned/refused COD parcel. Best-effort — must never turn
    // a successful refresh into a user-facing error (carrier-agnostic; keys off status).
    try {
      await this.codRisk.recordReturnIfApplicable(updated);
    } catch (err) {
      this.logger.warn(`[speedy] cod-risk record failed for ${updated.id}: ${err instanceof Error ? err.message : err}`);
    }
    return updated;
  }

  // Speedy stores the canonical UI status (parseTrackStatus), so terminal states can
  // be excluded in SQL — unlike Econt, whose `status` holds raw substring text.
  private static readonly TERMINAL_STATUSES = ['delivered', 'returned', 'refused'];

  /** Refresh every not-yet-final Speedy shipment with a barcode, across all tenants.
   *  Best-effort per shipment — one Speedy failure never aborts the batch. */
  async refreshActiveShipments(): Promise<{ refreshed: number }> {
    // Index-served (carrier, status) range scan over only live Speedy shipments;
    // full rows so refreshStatusForRow runs without a per-shipment re-SELECT.
    const rows = await this.db
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.carrier, 'speedy'),
          isNotNull(shipments.trackingNumber),
          notInArray(shipments.status, SpeedyService.TERMINAL_STATUSES),
        ),
      );
    let refreshed = 0;
    for (const r of rows) {
      if (!r.tenantId) continue;
      try {
        await this.refreshStatusForRow(r);
        refreshed++;
      } catch (err) {
        this.logger.warn(`[speedy] refresh failed for shipment ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { refreshed };
  }

  /** COD payout reconciliation for the last 60 days (Очаквано → Преведено). Stamps
   *  codSettledAt on matched Speedy shipments and returns the screen rows. */
  async codReconciliation(tenantId: string): Promise<Array<{ shipmentId: string; expectedStotinki: number | null; settledAt: string | null }>> {
    const creds = await this.resolveCreds(tenantId);
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - 60 * 24 * 60 * 60 * 1000);
    const data = await this.client.callSafe(creds, 'payments', {
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      includeDetails: true,
    });
    const payouts = parsePayouts(data);
    const settledByBarcode = new Map(payouts.filter((p) => p.barcode).map((p) => [p.barcode as string, p]));

    const rows = await this.db
      .select({
        shipmentId: shipments.id,
        barcode: shipments.trackingNumber,
        expected: shipments.codAmountStotinki,
        settledAt: shipments.codSettledAt,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')));

    const out: Array<{ shipmentId: string; expectedStotinki: number | null; settledAt: string | null }> = [];
    // Collect newly-settled rows, then write them in one parallel batch instead of a
    // serial UPDATE-per-row on the request path (set is bounded by the 60-day window).
    const settleWrites: Array<Promise<unknown>> = [];
    for (const r of rows) {
      if (r.expected == null) continue;
      const payout = r.barcode ? settledByBarcode.get(r.barcode) : undefined;
      let settledAt = r.settledAt ? r.settledAt.toISOString() : null;
      if (payout?.settledAt && !r.settledAt) {
        const d = new Date(payout.settledAt);
        if (!Number.isNaN(d.getTime())) {
          settleWrites.push(
            this.db.update(shipments).set({ codSettledAt: d, updatedAt: new Date() }).where(eq(shipments.id, r.shipmentId)),
          );
          settledAt = d.toISOString();
        }
      }
      out.push({ shipmentId: r.shipmentId, expectedStotinki: r.expected, settledAt });
    }
    if (settleWrites.length) await Promise.all(settleWrites);
    return out;
  }

  /** Book a Speedy courier pickup for already-created shipments. */
  async requestCourier(
    tenantId: string,
    input: SpeedyCourierRequestDto,
  ): Promise<{ pickupId: string | null; attached: number; skipped: number }> {
    const creds = await this.resolveCreds(tenantId);
    const rows = await this.db
      .select({ id: shipments.id, shipmentId: shipments.carrierShipmentId })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy'), inArray(shipments.id, input.shipmentIds)));
    const sent = rows.filter((r): r is { id: string; shipmentId: string } => !!r.shipmentId);
    if (!sent.length) throw new BadRequestException('Няма товарителници за заявка на куриер');

    const body: Record<string, unknown> = {
      shipmentIds: sent.map((r) => r.shipmentId),
      ...(input.pickupDate ? { pickupDate: input.pickupDate } : {}),
      ...(input.timeFrom ? { timeFrom: input.timeFrom } : {}),
      ...(input.timeTo ? { timeTo: input.timeTo } : {}),
    };
    const data = await this.client.call(creds, 'pickup', body);
    const pickupId: string | null = data?.id != null ? String(data.id) : null;

    if (pickupId) {
      await this.db
        .update(shipments)
        .set({ courierRequestId: pickupId, courierRequestStatus: 'requested', updatedAt: new Date() })
        .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy'), inArray(shipments.id, sent.map((r) => r.id))));
    }
    return { pickupId, attached: sent.length, skipped: input.shipmentIds.length - sent.length };
  }

  /** Price-only estimate (Speedy /calculate) for a destination site + weight.
   *  Optionally includes COD so the quote reflects the real price when COD is
   *  requested. Returns stotinki, or null on any failure (never throws — used
   *  by the cross-carrier quote). Cached 8h; COD dimension keeps COD/non-COD
   *  prices in separate cache entries. */
  async estimateShipping(
    tenantId: string,
    input: { siteId: number; weightGrams?: number; codAmountStotinki?: number },
  ): Promise<number | null> {
    try {
      const { speedy } = await this.loadStored(tenantId);
      if (!speedy.configured || !input.siteId) return null;

      const weightKg = input.weightGrams ? input.weightGrams / 1000 : (speedy.defaultPackage?.weightKg ?? 1);
      const weightBucket = Math.ceil(weightKg / WEIGHT_BUCKET_KG) * WEIGHT_BUCKET_KG;
      // Bucket COD to the nearest 10 BGN (1000 stotinki) to avoid a separate
      // cache entry per exact order total while still isolating COD/non-COD prices.
      const cod = input.codAmountStotinki && input.codAmountStotinki > 0 ? input.codAmountStotinki : 0;
      const codBucket = cod > 0 ? Math.ceil(cod / 1000) * 1000 : 0;
      const key = `speedy:estimate:${tenantId}:${input.siteId}:${weightBucket}kg:cod${codBucket}`;
      const cached = await this.cache.get<number>(key);
      if (cached !== null) return cached;

      const creds = await this.resolveCreds(tenantId);
      const serviceId = speedy.defaultServiceId ?? SPEEDY_DEFAULT_SERVICE_ID;
      // Reuse the create-body builder with a placeholder receiver at the site.
      // /calculate accepts the same body as /shipment. Pass COD so the price
      // returned by Speedy already includes the COD service fee.
      const body = buildShipmentRequest(speedy, {
        receiverName: '—',
        receiverPhone: '—',
        deliveryMode: 'address',
        siteId: input.siteId,
        serviceId,
        weightGrams: input.weightGrams,
        ...(cod > 0 ? { codAmountStotinki: cod } : {}),
      });
      // Short timeout: this runs inline behind the quote endpoint.
      const data = await this.client.call(creds, 'calculate', body, 6000);
      // spike: confirm the /calculate price field name vs live API.
      const priceEur: number | undefined = data?.price?.total ?? data?.price?.amount;
      // Reject 0 / NaN / Infinity too — never cache a bogus "free shipping" 0 for 8h.
      if (!Number.isFinite(priceEur) || (priceEur as number) <= 0) return null;
      const stotinki = Math.round((priceEur as number) * 100);
      await this.cache.set(key, stotinki, ESTIMATE_TTL);
      return stotinki;
    } catch (err) {
      this.logger.warn(`[speedy] estimate failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
}
