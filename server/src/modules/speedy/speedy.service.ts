import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { type Database, tenants, shipments } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret.util';
import { SpeedyClient, type SpeedyCreds } from './speedy.client';
import {
  type SpeedyStored, slimSites, slimOffices, slimStreets, slimContractClients,
  type SpeedySite, type SpeedyOffice, type SpeedyStreet, type SenderSuggestion,
  buildShipmentRequest, parseTrackStatus, type CanonicalStatus,
} from './speedy.helpers';
import { mergePdfs } from '../econt/econt.service';
import { SpeedyManualShipmentDto } from './dto/speedy-manual-shipment.dto';
import { SpeedyCredentialsDto } from './dto/speedy-credentials.dto';
import { SpeedyValidateAddressDto } from './dto/speedy-validate-address.dto';

const SPEEDY_BASE = 'https://api.speedy.bg/v1';
const NOMENCLATURE_TTL = 60 * 60 * 24; // 1 day
const EMPTY_TTL = 60; // negative-cache empty lookups for 60s
const MAX_BULK_LABELS = 50;

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
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY', '');
  }

  /* ------------------------------ credentials ------------------------------ */

  private async loadStored(
    tenantId: string,
  ): Promise<{ tenant: { id: string; slug: string; settings: Record<string, unknown> }; speedy: SpeedyStored }> {
    const [row] = await this.db
      .select({ id: tenants.id, slug: tenants.slug, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    const settings = (row.settings as Record<string, unknown> | null) ?? {};
    const delivery = (settings.delivery as Record<string, unknown> | null) ?? {};
    const speedy = (delivery.speedy as SpeedyStored | null) ?? {};
    return { tenant: { id: row.id, slug: row.slug, settings }, speedy };
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
    const nextSpeedy: SpeedyStored = {
      ...speedy,
      env: input.env ?? 'prod',
      userName: input.userName,
      passwordEnc: encryptSecret(input.password, this.encKey),
      ...(input.clientSystemId != null ? { clientSystemId: input.clientSystemId } : {}),
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
    const { speedy } = await this.loadStored(tenantId);
    const { passwordEnc: _pw, ...safe } = speedy;
    return { ...safe, configured: !!speedy.configured };
  }

  /* ------------------------------- location -------------------------------- */

  async searchSites(tenantId: string, q?: string): Promise<SpeedySite[]> {
    const { tenant } = await this.loadStored(tenantId);
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

  async getOffices(tenantId: string, siteId: number): Promise<SpeedyOffice[]> {
    if (!siteId) return [];
    const { tenant } = await this.loadStored(tenantId);
    const key = `speedy:offices:${tenant.slug}:${siteId}`;
    const cached = await this.cache.get<SpeedyOffice[]>(key);
    if (cached !== null) return cached;
    const creds = await this.resolveCreds(tenantId);
    const data = await this.client.callSafe(creds, 'location/office', { countryId: 100, siteId });
    const list = slimOffices(data);
    await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    return list;
  }

  async getStreets(tenantId: string, siteId: number, q?: string): Promise<SpeedyStreet[]> {
    if (!siteId) return [];
    const { tenant } = await this.loadStored(tenantId);
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
    if (row.carrierShipmentId) {
      const creds = await this.resolveCreds(tenantId);
      try {
        await this.client.call(creds, 'shipment/cancel', { shipmentId: row.carrierShipmentId });
      } catch (err) {
        this.logger.warn(`[speedy] cancel failed for ${row.carrierShipmentId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await this.db.delete(shipments).where(eq(shipments.id, shipmentId));
    return { id: shipmentId };
  }
}
