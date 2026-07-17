import { Injectable, Inject, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, desc, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { type Database, tenants, shipments, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { buildKeysetPage, clampLimit, cursorTs, keysetAfter, KEYSET_TS } from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret.util';
import { deriveSenderFromFarm } from '../econt/econt.sender';
import { readSenderBook, applySenderBook, type PickupPoint } from '../econt/sender-book';
import { SpeedyClient, type SpeedyCreds } from './speedy.client';
import {
  type SpeedyStored, slimSites, slimOffices, slimStreets, slimContractClients,
  type SpeedySite, type SpeedyOffice, type SpeedyStreet, type SenderSuggestion,
  buildShipmentRequest, buildCalculateRequest, parseCalculatePrice,
  buildOrderShipmentInput, parseTrackStatus, parsePayouts, type CanonicalStatus,
  SPEEDY_DEFAULT_SERVICE_ID,
} from './speedy.helpers';
import { mergePdfs, shouldNotifyShipped } from '../econt/econt.mappers';
import { ShipmentEmailService } from '../econt/shipment-email.service';
import { SpeedyManualShipmentDto } from './dto/speedy-manual-shipment.dto';
import { SpeedyCredentialsDto } from './dto/speedy-credentials.dto';
import { SpeedyValidateAddressDto } from './dto/speedy-validate-address.dto';
import { SpeedyCourierRequestDto } from './dto/speedy-courier-request.dto';
import { CodRiskService } from '../cod-risk/cod-risk.service';
import { isReturnedStatus } from '../cod-risk/cod-risk.helpers';
import type { CarrierAdapter } from '../orders/carrier-adapter';
import { consolidatedCodOverride } from '../econt-app/consolidation.helpers';

const SPEEDY_BASE = 'https://api.speedy.bg/v1';
const NOMENCLATURE_TTL = 60 * 60 * 24; // 1 day
const EMPTY_TTL = 60; // negative-cache empty lookups for 60s
const MAX_BULK_LABELS = 50;
// Speedy's /track docs cap a single request at 10 parcels.
const TRACK_BATCH_SIZE = 10;
// Estimate cache: Speedy pricing is stable intraday; 8h balances freshness vs.
// the latency of a live /calculate call. Weight is bucketed to 0.5kg so near-
// identical parcels reuse one entry.
const ESTIMATE_TTL = 60 * 60 * 8; // 8 hours
const WEIGHT_BUCKET_KG = 0.5;

/**
 * JSONB key path for a delivery account's Speedy blob inside `tenants.settings`.
 * Tenant-level (`delivery.speedy`) when no farmerId — the existing marketplace-admin
 * account; a per-farmer sub-namespace (`delivery.farmers.<id>.speedy`) otherwise.
 * The row selector stays `tenants.id = tenantId` in both cases — a farmer's blob
 * lives INSIDE the marketplace tenant row. Mirrors econtSettingsPath.
 */
export function speedySettingsPath(farmerId?: string): string[] {
  return farmerId ? ['delivery', 'farmers', farmerId, 'speedy'] : ['delivery', 'speedy'];
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

/** A Speedy shipment row shaped for the standalone shipments table. */
export interface SpeedyShipment {
  shipmentId: string;
  receiverName: string;
  deliveryMode: 'office' | 'address';
  status: CanonicalStatus;
  trackingNumber: string | null;
  priceStotinki: number | null;
  codAmountStotinki: number | null;
  /** Courier-pickup request status (null until a pickup is requested for this waybill). */
  courierRequestStatus: string | null;
  /** True when this shipment is a consolidation MASTER (see econt.mappers.ts /
   *  consolidation.service.ts) — drives the debt-breakdown + „Раздели" undo action. */
  isConsolidationMaster?: boolean;
}

@Injectable()
export class SpeedyService implements CarrierAdapter {
  private readonly logger = new Logger(SpeedyService.name);
  private readonly encKey: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly cache: PublicCacheService,
    private readonly client: SpeedyClient,
    private readonly codRisk: CodRiskService,
    private readonly shipmentEmail: ShipmentEmailService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY', '');
  }

  /* ------------------------------ credentials ------------------------------ */

  private async loadStored(
    tenantId: string,
    cache?: Map<string, unknown>,
    farmerId?: string,
  ): Promise<{ tenant: { id: string; slug: string; name: string; settings: Record<string, unknown>; isDemo: boolean }; speedy: SpeedyStored }> {
    // Optional per-call memo (bulk import passes one Map per batch): reads the tenant
    // settings once per batch instead of on every row's site/office/street lookup.
    // Absent for all other callers, so their behavior is unchanged (no staleness).
    // The memo key is scoped per-farmer so a tenant-level read and a farmer read of
    // the same tenant row never collide on the cached blob.
    const ck = `speedy:${tenantId}:${farmerId ?? ''}`;
    if (cache?.has(ck)) {
      return cache.get(ck) as { tenant: { id: string; slug: string; name: string; settings: Record<string, unknown>; isDemo: boolean }; speedy: SpeedyStored };
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
    const speedy = ((readAtPath(settings, speedySettingsPath(farmerId)) as SpeedyStored | null) ?? {}) as SpeedyStored;
    const result = { tenant: { id: row.id, slug: row.slug, name: row.name, settings, isDemo: !!row.isDemo }, speedy };
    cache?.set(ck, result);
    return result;
  }

  private async resolveCreds(tenantId: string, farmerId?: string): Promise<SpeedyCreds> {
    if (!this.encKey) throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран');
    const { speedy } = await this.loadStored(tenantId, undefined, farmerId);
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

  /** Merge a derived sender into the speedy blob ONLY when none is set yet. */
  private maybeSeedSender(
    speedy: Record<string, unknown>,
    farmName: string,
    contact: { phone?: string | null; address?: string | null } | null | undefined,
    profiles: { name: string; phone: string; clientNumber?: string | null }[] | null | undefined,
  ): Record<string, unknown> {
    const existing = speedy.sender as Record<string, unknown> | undefined;
    if (existing && Object.keys(existing).length) return speedy;
    // Speedy's sender schema uses `contactName` (not Еcont's `name`) — remap the
    // carrier-agnostic derived sender so buildShipmentRequest reads it correctly.
    const d = deriveSenderFromFarm(farmName, contact ?? null, profiles ?? []);
    return { ...speedy, sender: { contactName: d.name, phone: d.phone, mode: d.mode } };
  }

  private clearCredsBlob(speedy: Record<string, unknown>): Record<string, unknown> {
    const { userName: _u, passwordEnc: _p, ...rest } = speedy;
    return { ...rest, configured: false };
  }

  async disconnect(tenantId: string, farmerId?: string): Promise<{ configured: false }> {
    const { tenant, speedy } = await this.loadStored(tenantId, undefined, farmerId);
    const nextSpeedy = this.clearCredsBlob(speedy);
    const nextSettings = writeAtPath(tenant.settings, speedySettingsPath(farmerId), nextSpeedy);
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(`speedy:sites:${tenant.slug}`, `tenant:${tenant.slug}`);
    return { configured: false };
  }

  /** Validate creds against Speedy (a cheap /client call), then store encrypted. */
  async saveCredentials(tenantId: string, input: SpeedyCredentialsDto, farmerId?: string): Promise<{ configured: true }> {
    if (!this.encKey) {
      throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран — Speedy не може да се запази');
    }
    // Live validation: bad creds make /client fail.
    await this.client.call(
      { base: SPEEDY_BASE, userName: input.userName, password: input.password, clientSystemId: input.clientSystemId },
      'client',
      {},
    );

    const { tenant, speedy } = await this.loadStored(tenantId, undefined, farmerId);
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
    let seededSpeedy: Record<string, unknown> = nextSpeedy;
    try {
      let profiles: { name: string; phone: string; clientNumber: string | null }[] = [];
      try {
        const data = await this.client.call(
          { base: SPEEDY_BASE, userName: input.userName, password: input.password, clientSystemId: input.clientSystemId },
          'client/contract', {},
        );
        profiles = slimContractClients(data);
      } catch { /* no contract clients → fall back */ }
      const contact = (tenant.settings.contact ?? null) as { phone?: string | null; address?: string | null } | null;
      seededSpeedy = this.maybeSeedSender(nextSpeedy, tenant.name || tenant.slug, contact, profiles);
    } catch { /* optional */ }
    // Deep-create the path so a farmer write under an absent `delivery.farmers`
    // parent still succeeds, while a tenant-level write keeps targeting delivery.speedy.
    const nextSettings = writeAtPath(tenant.settings, speedySettingsPath(farmerId), seededSpeedy);
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    // Connecting flips `configured: true`, which changes the cached TenantMeta
    // (speedyConfigured / comparisonActive) — bust `tenant:` too, else the storefront
    // hides the Speedy option for up to PUBLIC_CACHE_TTL. Mirrors disconnect().
    await this.cache.del(`speedy:sites:${tenant.slug}`, `tenant:${tenant.slug}`);
    return { configured: true };
  }

  /**
   * Persist the Speedy sender/package/COD profile (NOT credentials) into
   * settings.delivery.speedy. Merges over the stored blob so passwordEnc is
   * untouched. Backs the dostavki profile editor.
   */
  async saveProfile(
    tenantId: string,
    input: {
      sender?: {
        contactName?: string; phone?: string; mode?: 'office' | 'address';
        officeId?: number; siteId?: number; streetId?: number; streetNo?: string;
      };
      defaultPackage?: { parcelsCount?: number; weightKg?: number; contents?: string };
      cod?: { enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' };
      label?: { autoCreate?: boolean };
    },
    farmerId?: string,
  ): Promise<{ ok: true }> {
    const { tenant, speedy } = await this.loadStored(tenantId, undefined, farmerId);
    const nextSpeedy: SpeedyStored = {
      ...speedy,
      ...(input.sender !== undefined ? { sender: { ...(speedy.sender ?? {}), ...input.sender } } : {}),
      ...(input.defaultPackage !== undefined
        ? { defaultPackage: { ...(speedy.defaultPackage ?? {}), ...input.defaultPackage } }
        : {}),
      ...(input.cod !== undefined ? { cod: { ...(speedy.cod ?? {}), ...input.cod } } : {}),
      ...(input.label !== undefined ? { label: { ...(speedy.label ?? {}), ...input.label } } : {}),
    };
    const nextSettings = writeAtPath(tenant.settings, speedySettingsPath(farmerId), nextSpeedy);
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(`tenant:${tenant.slug}`);
    return { ok: true };
  }

  private buildSenderBlob(speedy: Record<string, unknown>, senders: PickupPoint[], activeId: string): Record<string, unknown> {
    return applySenderBook(speedy, senders, activeId);
  }

  async saveSenders(tenantId: string, input: { senders: PickupPoint[]; activeId: string }, farmerId?: string): Promise<{ ok: true }> {
    const { tenant, speedy } = await this.loadStored(tenantId, undefined, farmerId);
    const nextSpeedy = this.buildSenderBlob(speedy, input.senders, input.activeId);
    const nextSettings = writeAtPath(tenant.settings, speedySettingsPath(farmerId), nextSpeedy);
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(`tenant:${tenant.slug}`);
    return { ok: true };
  }

  async getConfig(tenantId: string, farmerId?: string): Promise<Record<string, unknown>> {
    const { tenant, speedy } = await this.loadStored(tenantId, undefined, farmerId);
    const { passwordEnc: _pw, ...safe } = speedy;
    const book = readSenderBook(speedy);
    return {
      ...safe,
      senders: book.senders,
      activeSenderId: book.activeId,
      configured: !!speedy.configured,
      isDemo: tenant.isDemo,
      env: tenant.isDemo ? 'demo' : 'prod',
    };
  }

  /**
   * Auto-create the Speedy waybill for a freshly-paid/confirmed order when the
   * farm enabled the "create label on paid order" toggle (`speedy.label.autoCreate`).
   * Best-effort and non-throwing: it must never disrupt the payment webhook or
   * order-confirm flow that triggers it. Idempotent: skips if a waybill already exists.
   */
  async autoCreateForOrder(orderId: string): Promise<void> {
    try {
      const [order] = await this.db
        .select({ tenantId: orders.tenantId, deliveryType: orders.deliveryType })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!order?.tenantId) return;
      // A courier (per-farmer) order is shipped by the farmer with their OWN creds via the
      // dostavki finalize flow — never tenant-level auto-created. Mirror of Econt's gate
      // (since orderForShipment now accepts deliveryType='courier', gate it here too).
      if (order.deliveryType === 'courier') return;

      // Tenant-level by design: triggered by the payment webhook / order-confirm flow,
      // which has no authenticated-farmer request context. (Per-farmer auto-create
      // will be revisited once orders carry the owning farmer.)
      const { speedy } = await this.loadStored(order.tenantId);
      if (!speedy.configured || speedy.label?.autoCreate !== true) return;

      const [existing] = await this.db
        .select({ id: shipments.carrierShipmentId })
        .from(shipments)
        .where(eq(shipments.orderId, orderId))
        .limit(1);
      if (existing?.id) return; // waybill already created

      await this.createLabelForOrder(order.tenantId, orderId);
      this.logger.log(`[speedy] auto-created waybill for order ${orderId}`);
    } catch (err) {
      this.logger.warn(
        `[speedy] auto-create failed for order ${orderId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /* ------------------------------- location -------------------------------- */

  async searchSites(tenantId: string, q?: string, cache?: Map<string, unknown>, farmerId?: string): Promise<SpeedySite[]> {
    const { tenant } = await this.loadStored(tenantId, cache, farmerId);
    const query = (q ?? '').trim();
    // Speedy's location/site returns only ~10 default sites when called WITHOUT a name —
    // the full nomenclature is searched server-side via `name`. Fetching once + filtering
    // locally (the old approach) found 0 for "София". Pass the query through, cache per query.
    const key = `speedy:sites:${tenant.slug}:${query.toLowerCase() || '_'}`;
    let list = await this.cache.get<SpeedySite[]>(key);
    if (list === null) {
      const creds = await this.resolveCreds(tenantId, farmerId);
      const data = await this.client.callSafe(creds, 'location/site', query ? { countryId: 100, name: query } : { countryId: 100 });
      list = slimSites(data);
      await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    }
    if (!query) return list.slice(0, 20);
    // Rank prefix matches first within Speedy's server-side results.
    const ql = query.toLowerCase();
    const starts: SpeedySite[] = [];
    const rest: SpeedySite[] = [];
    for (const s of list) (s.name.toLowerCase().startsWith(ql) ? starts : rest).push(s);
    return [...starts, ...rest].slice(0, 20);
  }

  async getOffices(tenantId: string, siteId: number, cache?: Map<string, unknown>, farmerId?: string): Promise<SpeedyOffice[]> {
    if (!siteId) return [];
    const { tenant } = await this.loadStored(tenantId, cache, farmerId);
    const key = `speedy:offices:${tenant.slug}:${siteId}`;
    const cached = await this.cache.get<SpeedyOffice[]>(key);
    if (cached !== null) return cached;
    const creds = await this.resolveCreds(tenantId, farmerId);
    const data = await this.client.callSafe(creds, 'location/office', { countryId: 100, siteId });
    const list = slimOffices(data);
    await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    return list;
  }

  async getStreets(tenantId: string, siteId: number, q?: string, cache?: Map<string, unknown>, farmerId?: string): Promise<SpeedyStreet[]> {
    if (!siteId) return [];
    const { tenant } = await this.loadStored(tenantId, cache, farmerId);
    const query = (q ?? '').trim();
    // Same as searchSites: pass `name` so Speedy searches server-side (a bare siteId
    // returns a capped default list), cached per query.
    const key = `speedy:streets:${tenant.slug}:${siteId}:${query.toLowerCase() || '_'}`;
    let list = await this.cache.get<SpeedyStreet[]>(key);
    if (list === null) {
      const creds = await this.resolveCreds(tenantId, farmerId);
      const data = await this.client.callSafe(creds, 'location/street', query ? { siteId, name: query } : { siteId });
      list = slimStreets(data);
      await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    }
    return list.slice(0, 20);
  }

  async validateAddress(
    tenantId: string,
    input: SpeedyValidateAddressDto,
    farmerId?: string,
  ): Promise<{ valid: boolean; status: string | null }> {
    const creds = await this.resolveCreds(tenantId, farmerId);
    const address: Record<string, unknown> =
      input.officeId != null
        ? { countryId: 100, siteId: input.siteId, officeId: input.officeId }
        : { countryId: 100, siteId: input.siteId, streetId: input.streetId, streetNo: input.streetNo };
    const data = await this.client.call(creds, 'validation/address', { address });
    // Speedy returns a `validationMode`/`valid` flag. // spike: confirm field name.
    const valid = data?.valid === true || data?.validationMode === 'VALID';
    return { valid, status: data?.validationMode ?? null };
  }

  async getClientProfiles(tenantId: string, farmerId?: string): Promise<SenderSuggestion[]> {
    const creds = await this.resolveCreds(tenantId, farmerId);
    const data = await this.client.call(creds, 'client/contract', {});
    return slimContractClients(data);
  }

  /* ------------------------------- shipments ------------------------------- */

  /** Create a Speedy waybill for a hand-entered receiver (no storefront order). */
  async createManualShipment(
    tenantId: string,
    input: SpeedyManualShipmentDto,
    farmerId?: string,
  ): Promise<typeof shipments.$inferSelect> {
    const { speedy } = await this.loadStored(tenantId, undefined, farmerId);
    const creds = await this.resolveCreds(tenantId, farmerId);
    const body = buildShipmentRequest(speedy, input);
    const data = await this.client.call(creds, 'shipment', body);

    const shipmentId: string | null = data?.id != null ? String(data.id) : null;
    const parcels: any[] = Array.isArray(data?.parcels) ? data.parcels : [];
    const barcode: string | null = parcels.length ? String(parcels[0]?.barcode ?? parcels[0]?.id ?? '') || null : null;
    // Confirmed live (demo, 2026-06-30): create returns `id` + `parcels[].barcode` and
    // `price.total` (EUR) — verified with a multi-parcel + declaredValue + COD shipment.
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
        farmerId: orders.farmerId,
        deliveryCity: orders.deliveryCity,
        deliveryAddress: orders.deliveryAddress,
        deliveryNote: orders.deliveryNote,
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
  async createLabelForOrder(
    tenantId: string,
    orderId: string,
    farmerId?: string,
    overrides?: import('./dto/finalize-draft.dto').FinalizeDraftDto,
  ): Promise<typeof shipments.$inferSelect> {
    const { speedy } = await this.loadStored(tenantId, undefined, farmerId);
    if (!speedy.configured) throw new BadRequestException('Speedy не е конфигуриран за тази ферма');

    const order = await this.orderForShipment(tenantId, orderId);
    // Phase 3 authz: a farmer may only finalize THEIR OWN per-farmer order (orderForShipment
    // scopes by tenant, not farmer). Admin (no farmerId) bypasses; tenant-level orders unaffected.
    const orderFarmerId = (order as { farmerId?: string | null }).farmerId ?? null;
    if (farmerId && orderFarmerId && orderFarmerId !== farmerId) {
      throw new ForbiddenException('Поръчката принадлежи на друга ферма');
    }
    const sites = await this.searchSites(tenantId, order.deliveryCity ?? '', undefined, farmerId);
    const siteId = sites[0]?.id;
    if (!siteId) throw new BadRequestException('Населеното място не е намерено в Speedy');

    const creds = await this.resolveCreds(tenantId, farmerId);
    // Read the consolidation master's group COD BEFORE building the request, so the
    // Speedy waybill INSTRUCTS the courier to collect the summed amount — not just
    // this order's total. Reading it only after the carrier call (as before) fixed
    // the persisted column but left the actual door-collection wrong: the DB said
    // 1800 while Speedy was told 500.
    const [existingShipment] = await this.db
      .select({
        id: shipments.id,
        consolidationGroupId: shipments.consolidationGroupId,
        codAmountStotinki: shipments.codAmountStotinki,
      })
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .limit(1);
    const override = consolidatedCodOverride(existingShipment ?? null);

    const input = buildOrderShipmentInput(speedy, order, siteId, overrides);
    // Consolidation master collects the whole group's COD. Only override the AMOUNT
    // when this order is already collecting COD (buildOrderShipmentInput sets
    // codAmountStotinki only for an unpaid COD order) — a paid master stays at 0.
    if (override != null && input.codAmountStotinki != null) input.codAmountStotinki = override;
    const body = buildShipmentRequest(speedy, input);
    const data = await this.client.call(creds, 'shipment', body);

    const shipmentId: string | null = data?.id != null ? String(data.id) : null;
    const parcels: any[] = Array.isArray(data?.parcels) ? data.parcels : [];
    const barcode: string | null = parcels.length ? String(parcels[0]?.barcode ?? parcels[0]?.id ?? '') || null : null;
    const priceEur: number | undefined = data?.price?.total ?? data?.price?.amount;
    const codAmount =
      override != null
        ? override
        : input.codAmountStotinki && input.codAmountStotinki > 0
          ? Math.round(input.codAmountStotinki)
          : null;
    // The owning farmer for a finalized waybill: prefer the order's own farmer_id (set
    // on a Phase-3 courier split) and fall back to the caller's farmerId arg. Stays null
    // for legacy tenant-level Speedy orders.
    const ownerFarmerId = (order as { farmerId?: string | null }).farmerId ?? farmerId ?? null;

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId,
        farmerId: ownerFarmerId,
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
          // Finalizing a courier DRAFT: set/preserve the owning farmer + carrier so a
          // waybill always carries its true owner and the carrier that produced it.
          farmerId: ownerFarmerId,
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
    // Persist the chosen carrier on the order so the courier list / UI reflects which
    // carrier shipped a previously carrier-neutral courier draft.
    await this.db.update(orders).set({ carrier: 'speedy' }).where(eq(orders.id, orderId));
    return row;
  }

  /** One keyset page of Speedy shipments for this tenant (order-less), newest first. */
  async listShipments(
    tenantId: string,
    farmerId?: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: SpeedyShipment[]; nextCursor: string | null }> {
    // Phase 3 single-source decision: a courier draft is carrier-NEUTRAL until the
    // farmer picks a carrier at ship time, so EVERY farmer courier draft is listed
    // exactly once — under Econt (the authoritative carrier-neutral source). Speedy
    // intentionally returns [] for a farmer; otherwise each draft would appear twice
    // in the dostavki UI (once per carrier tab). The tenant-wide admin path (no
    // farmerId) below is unchanged. See EcontService.listShipments' farmer branch.
    if (farmerId) return { items: [], nextCursor: null };
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const conds = [eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')];
    if (cur) conds.push(keysetAfter(shipments.createdAt, shipments.id, cur, 'desc'));
    const rows = await this.db
      .select({
        id: shipments.id, // required by buildKeysetPage's cursor; mapped to shipmentId below
        shipmentId: shipments.id,
        receiverName: shipments.receiverName,
        deliveryMode: shipments.deliveryMode,
        status: shipments.status,
        trackingNumber: shipments.trackingNumber,
        priceStotinki: shipments.courierPriceStotinki,
        codAmountStotinki: shipments.codAmountStotinki,
        courierRequestStatus: shipments.courierRequestStatus,
        consolidationGroupId: shipments.consolidationGroupId,
        [KEYSET_TS]: cursorTs(shipments.createdAt),
      })
      .from(shipments)
      .where(and(...conds))
      .orderBy(desc(shipments.createdAt), desc(shipments.id))
      .limit(lim + 1);
    const { items, nextCursor } = buildKeysetPage(rows, lim);
    return {
      items: items.map((r) => ({
        shipmentId: r.shipmentId,
        receiverName: r.receiverName ?? '—',
        deliveryMode: r.deliveryMode === 'address' ? 'address' : 'office',
        status: (r.status as CanonicalStatus) ?? 'pending',
        trackingNumber: r.trackingNumber,
        priceStotinki: r.priceStotinki,
        codAmountStotinki: r.codAmountStotinki,
        courierRequestStatus: r.courierRequestStatus ?? null,
        // Same self-referencing check as econt.mappers.ts's mapShipmentRow.
        isConsolidationMaster: !!r.shipmentId && !!r.consolidationGroupId && r.consolidationGroupId === r.shipmentId,
      })),
      nextCursor,
    };
  }

  /** The farm's label-paper preference (A4/A6), applied to Speedy /print so the printed
   *  waybill is the SAME size whichever carrier shipped it. The farmer sets one paper
   *  choice on the Econt card; we honour it for Speedy too (own `speedy.label.paper`
   *  wins if ever set). Defaults to A6; any read failure degrades to A6. Both sizes are
   *  accepted by Speedy /print (verified live). */
  private async resolvePaperSize(tenantId: string, farmerId?: string): Promise<'A4' | 'A6'> {
    try {
      const { tenant } = await this.loadStored(tenantId, undefined, farmerId);
      const delivery = ((tenant.settings as Record<string, unknown>)?.delivery ?? {}) as {
        econt?: { label?: { paper?: string } };
        speedy?: { label?: { paper?: string } };
      };
      const paper = delivery.speedy?.label?.paper ?? delivery.econt?.label?.paper;
      return paper === 'A4' ? 'A4' : 'A6';
    } catch {
      return 'A6';
    }
  }

  /** One Speedy label PDF (tenant-scoped) — fetched live via /print. */
  async getLabelPdf(tenantId: string, shipmentId: string, farmerId?: string): Promise<Buffer> {
    const [row] = await this.db
      .select({ id: shipments.carrierShipmentId, barcode: shipments.trackingNumber })
      .from(shipments)
      .where(
        and(
          eq(shipments.id, shipmentId),
          eq(shipments.tenantId, tenantId),
          eq(shipments.carrier, 'speedy'),
          // Farmer dostavki session: scope to THEIR own parcel (cross-farmer → not found).
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    const ref = row.id ?? row.barcode;
    if (!ref) throw new NotFoundException('Няма товарителница за тази пратка');
    const creds = await this.resolveCreds(tenantId, farmerId);
    const paperSize = await this.resolvePaperSize(tenantId, farmerId);
    return this.client.callBinary(creds, 'print', { paperSize, parcels: [{ parcel: { id: ref } }] });
  }

  /** Several Speedy labels merged into one PDF (tenant-scoped). */
  async getLabelsPdf(tenantId: string, shipmentIds: string[], farmerId?: string): Promise<Buffer> {
    if (!shipmentIds.length) throw new BadRequestException('Няма избрани товарителници');
    if (shipmentIds.length > MAX_BULK_LABELS) {
      throw new BadRequestException(`Максимум ${MAX_BULK_LABELS} товарителници наведнъж`);
    }
    const creds = await this.resolveCreds(tenantId, farmerId);
    const rows = await this.db
      .select({ id: shipments.carrierShipmentId, barcode: shipments.trackingNumber })
      .from(shipments)
      .where(
        and(
          eq(shipments.tenantId, tenantId),
          eq(shipments.carrier, 'speedy'),
          inArray(shipments.id, shipmentIds),
          // Farmer dostavki session: only THEIR own parcels' labels.
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      );
    const refs = rows.map((r) => r.id ?? r.barcode).filter((x): x is string => !!x);
    const paperSize = await this.resolvePaperSize(tenantId, farmerId);
    const settled = await Promise.allSettled(
      refs.map((ref) => this.client.callBinary(creds, 'print', { paperSize, parcels: [{ parcel: { id: ref } }] })),
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
  async voidShipment(tenantId: string, shipmentId: string, farmerId?: string): Promise<{ id: string }> {
    const [row] = await this.db
      .select({ id: shipments.id, carrierShipmentId: shipments.carrierShipmentId })
      .from(shipments)
      .where(
        and(
          eq(shipments.id, shipmentId),
          eq(shipments.tenantId, tenantId),
          eq(shipments.carrier, 'speedy'),
          // Farmer dostavki session: scope to THEIR own parcel (cross-farmer → not found).
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    // Only drop the local row once the carrier waybill is actually gone. If Speedy rejects
    // the cancel (parcel already picked up / past the cancel window) the paid waybill is
    // still LIVE — deleting our row here would orphan it, so we surface the error instead.
    if (row.carrierShipmentId) {
      const creds = await this.resolveCreds(tenantId, farmerId);
      try {
        // Speedy requires a cancel reason of >= 4 chars (cancel_comment_too_short).
        await this.client.call(creds, 'shipment/cancel', {
          shipmentId: row.carrierShipmentId,
          comment: 'Анулирана от ФермериБГ',
        });
      } catch (err) {
        this.logger.warn(`[speedy] cancel failed for ${row.carrierShipmentId}: ${err instanceof Error ? err.message : err}`);
        throw new BadRequestException(
          'Speedy отказа анулирането (пратката вероятно вече е приета). Товарителницата остава активна.',
        );
      }
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

  /* ------------------------- tracking + COD + courier ---------------------- */

  /** Refresh a Speedy shipment's status from /track. Persists the canonical status
   *  and fires the COD-risk hook (best-effort) on a returned/refused COD parcel. */
  async refreshStatus(tenantId: string, shipmentId: string, farmerId?: string): Promise<typeof shipments.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.id, shipmentId),
          eq(shipments.tenantId, tenantId),
          eq(shipments.carrier, 'speedy'),
          // Farmer dostavki session: scope to THEIR own parcel (cross-farmer → not found).
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    return this.refreshStatusForRow(row, farmerId);
  }

  /**
   * Refresh one Speedy shipment from its already-loaded row. Split out from
   * {@link refreshStatus} so the batch cron passes the rows it already selected
   * instead of re-SELECTing each (incl. the large trackingJson) per shipment.
   * The cron passes no farmerId (it has no request decorator) → tenant-level creds.
   */
  private async refreshStatusForRow(
    row: typeof shipments.$inferSelect,
    farmerId?: string,
  ): Promise<typeof shipments.$inferSelect> {
    if (!row.trackingNumber || !row.tenantId) return row;

    const creds = await this.resolveCreds(row.tenantId, farmerId);
    const data = await this.client.call(creds, 'track', { parcels: [{ id: row.trackingNumber }] });
    const parcel = Array.isArray(data?.parcels) ? data.parcels[0] : null;
    return this.applyTrackedParcel(row, parcel);
  }

  /**
   * Persist an already-fetched Speedy tracked-parcel onto a row and fire the
   * shipped-email + COD-risk + COD-outcome side effects. Split out of
   * {@link refreshStatusForRow} so {@link refreshActiveShipments} can batch the
   * /track call per tenant (Speedy caps a request at 10 parcels, so still chunked,
   * but N/10 calls instead of N) and still reuse this per-row persistence logic with
   * the response entry correlated back to it via `parcelId`.
   */
  private async applyTrackedParcel(
    row: typeof shipments.$inferSelect,
    parcel: any,
  ): Promise<typeof shipments.$inferSelect> {
    const operations: any[] = Array.isArray(parcel?.operations) ? parcel.operations : [];
    const status = parseTrackStatus(operations, true);

    const [updated] = await this.db
      .update(shipments)
      .set({
        status,
        trackingJson: parcel ?? row.trackingJson,
        // Speedy has no dedicated COD-collection callback (unlike Econt's reconciliation
        // feed) — the canonical status turning 'delivered' on a COD parcel is the only
        // signal we get, so stamp it here the first time that happens.
        codCollectedAt:
          status === 'delivered' && row.codAmountStotinki != null && row.codCollectedAt == null
            ? new Date()
            : row.codCollectedAt,
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, row.id))
      .returning();

    // COD-risk strike on a returned/refused COD parcel. Best-effort — must never turn
    // a successful refresh into a user-facing error (carrier-agnostic; keys off status).
    try {
      await this.codRisk.recordReturnIfApplicable(updated);
    } catch (err) {
      this.logger.warn(`[speedy] cod-risk record failed for ${updated.id}: ${err instanceof Error ? err.message : err}`);
    }

    // Auto-sync the order's COD money outcome from this courier signal. Best-effort —
    // same rationale as the cod-risk strike above.
    try {
      await this.syncOrderCodOutcome(updated);
    } catch (err) {
      this.logger.warn(`[speedy] cod-outcome sync failed for ${updated.id}: ${err instanceof Error ? err.message : err}`);
    }

    // „Пратката тръгна" mail to the buyer with the Speedy tracking link — parity with
    // Econt. Only for order-backed parcels (manual rows have no customer email) and only
    // once (customerNotifiedAt). Best-effort: a mail failure must not fail the refresh.
    if (updated.orderId && updated.trackingNumber && shouldNotifyShipped(status, row.customerNotifiedAt)) {
      try {
        await this.shipmentEmail.sendShipped(updated.orderId, updated.trackingNumber, 'speedy');
        await this.db
          .update(shipments)
          .set({ customerNotifiedAt: new Date() })
          .where(eq(shipments.id, updated.id));
      } catch (err) {
        this.logger.warn(`[speedy] shipped email failed for ${updated.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return updated;
  }

  /** Sync the order's COD money outcome from a courier signal. No-clobber: only
   *  writes when the order has no outcome yet (a manual override wins). Speedy's
   *  canonical status turning 'delivered' stamps codCollectedAt above, so the same
   *  received/refused branching as Econt works unchanged here. Best-effort (caller wraps). */
  private async syncOrderCodOutcome(shipment: typeof shipments.$inferSelect): Promise<void> {
    if (!shipment.orderId || shipment.codAmountStotinki == null) return;
    let outcome: 'received' | 'refused' | null = null;
    if (isReturnedStatus(shipment.status)) outcome = 'refused';
    else if (shipment.codCollectedAt != null) outcome = 'received';
    if (!outcome) return;
    const written = await this.db
      .update(orders)
      .set({ codOutcome: outcome, codOutcomeAt: new Date(), codOutcomeSource: 'courier' })
      .where(and(eq(orders.id, shipment.orderId), sql`${orders.codOutcome} is null`))
      .returning({ id: orders.id, tenantId: orders.tenantId });
    // Плащания reads codOutcome from the cached payments list/totals — the manual
    // setCodOutcome path busts them; this carrier-driven sync must too, or the COD
    // badge lags up to PAYMENTS_CACHE_TTL (60s) after an auto-sync.
    if (written[0]?.tenantId) {
      await this.cache.del(
        `payments:totals:${written[0].tenantId}`,
        `payments:list:${written[0].tenantId}:all`,
        `payments:list:${written[0].tenantId}:cod`,
      );
    }
  }

  // Speedy stores the canonical UI status (parseTrackStatus), so terminal states can
  // be excluded in SQL — unlike Econt, whose `status` holds raw substring text.
  private static readonly TERMINAL_STATUSES = ['delivered', 'returned', 'refused'];

  /** Refresh every not-yet-final Speedy shipment with a barcode, across all tenants.
   *  Best-effort per shipment — one Speedy failure never aborts the batch. */
  async refreshActiveShipments(): Promise<{ refreshed: number }> {
    // Index-served (carrier, status) range scan over only live Speedy shipments;
    // full rows so applyTrackedParcel runs without a per-shipment re-SELECT.
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
    // Group by tenant (creds are per-tenant) so /track can be called with up to
    // TRACK_BATCH_SIZE parcels at once instead of one call per shipment. Speedy's
    // TrackedParcel response carries a `parcelId` that echoes the requested `id` —
    // confirmed via the published JSON schema — so results correlate back to rows
    // safely even though the request is chunked.
    const byTenant = new Map<string, (typeof shipments.$inferSelect)[]>();
    for (const r of rows) {
      if (!r.tenantId) continue;
      const list = byTenant.get(r.tenantId);
      if (list) list.push(r);
      else byTenant.set(r.tenantId, [r]);
    }
    let refreshed = 0;
    for (const [tenantId, tenantRows] of byTenant) {
      let creds: SpeedyCreds;
      try {
        creds = await this.resolveCreds(tenantId);
      } catch (err) {
        this.logger.warn(`[speedy] creds resolve failed for tenant ${tenantId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (let i = 0; i < tenantRows.length; i += TRACK_BATCH_SIZE) {
        const chunk = tenantRows.slice(i, i + TRACK_BATCH_SIZE);
        let parcelById: Map<string, any>;
        try {
          const data = await this.client.call(creds, 'track', {
            parcels: chunk.map((r) => ({ id: r.trackingNumber })),
          });
          parcelById = new Map();
          for (const p of Array.isArray(data?.parcels) ? data.parcels : []) {
            if (p?.parcelId) parcelById.set(p.parcelId, p);
          }
        } catch (err) {
          this.logger.warn(
            `[speedy] batch track failed for tenant ${tenantId} (${chunk.length} shipments): ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        for (const r of chunk) {
          try {
            await this.applyTrackedParcel(r, parcelById.get(r.trackingNumber!) ?? null);
            refreshed++;
          } catch (err) {
            this.logger.warn(`[speedy] refresh failed for shipment ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
    return { refreshed };
  }

  /** COD payout reconciliation for the last 60 days (Очаквано → Преведено). Stamps
   *  codSettledAt on matched Speedy shipments and returns the screen rows. */
  async codReconciliation(tenantId: string, farmerId?: string): Promise<Array<{ shipmentId: string; expectedStotinki: number | null; settledAt: string | null }>> {
    // Phase 3 single-source decision (mirror of listShipments): a farmer's courier COD
    // is reconciled once, under Econt (the carrier-neutral authority for courier drafts).
    // Speedy returns [] for a farmer to avoid double-listing per carrier tab; the
    // tenant-wide admin path (no farmerId) below is unchanged. Returning early also
    // skips resolveCreds — a farmer has no Speedy contract behind a carrier-neutral draft.
    if (farmerId) return [];
    const creds = await this.resolveCreds(tenantId, farmerId);
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
    farmerId?: string,
  ): Promise<{ pickupId: string | null; attached: number; skipped: number }> {
    const creds = await this.resolveCreds(tenantId, farmerId);
    const rows = await this.db
      .select({ id: shipments.id, shipmentId: shipments.carrierShipmentId })
      .from(shipments)
      .where(
        and(
          eq(shipments.tenantId, tenantId),
          eq(shipments.carrier, 'speedy'),
          inArray(shipments.id, input.shipmentIds),
          // Farmer dostavki session: only THEIR own shipments may be attached to a pickup.
          ...(farmerId ? [eq(shipments.farmerId, farmerId)] : []),
        ),
      );
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
   *  prices in separate cache entries.
   *  Tenant-level by design (no farmerId): this runs inline behind the storefront
   *  checkout/quote, which has no authenticated-farmer request context. Mirrors
   *  Econt.estimateShipping — the per-farmer paths are the authenticated dostavki
   *  session methods above. */
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
      // /calculate has its OWN body shape (serviceIds[] + recipient.addressLocation) —
      // it is NOT the /shipment body. Pass COD so the returned price already includes
      // the COD service fee.
      const body = buildCalculateRequest(speedy, {
        siteId: input.siteId,
        serviceId,
        weightGrams: input.weightGrams,
        ...(cod > 0 ? { codAmountStotinki: cod } : {}),
      });
      // Short timeout: this runs inline behind the quote endpoint.
      const data = await this.client.call(creds, 'calculate', body, 6000);
      // Live price path: calculations[0].price.total (no top-level price).
      const priceEur = parseCalculatePrice(data);
      // Reject 0 / NaN / Infinity too — never cache a bogus "free shipping" 0 for 8h.
      if (priceEur == null || !Number.isFinite(priceEur) || priceEur <= 0) return null;
      const stotinki = Math.round(priceEur * 100);
      await this.cache.set(key, stotinki, ESTIMATE_TTL);
      return stotinki;
    } catch (err) {
      this.logger.warn(`[speedy] estimate failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
}
