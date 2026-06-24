import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret.util';
import { SpeedyClient, type SpeedyCreds } from './speedy.client';
import {
  type SpeedyStored, slimSites, slimOffices, slimStreets, slimContractClients,
  type SpeedySite, type SpeedyOffice, type SpeedyStreet, type SenderSuggestion,
} from './speedy.helpers';
import { SpeedyCredentialsDto } from './dto/speedy-credentials.dto';
import { SpeedyValidateAddressDto } from './dto/speedy-validate-address.dto';

const SPEEDY_BASE = 'https://api.speedy.bg/v1';
const NOMENCLATURE_TTL = 60 * 60 * 24; // 1 day
const EMPTY_TTL = 60; // negative-cache empty lookups for 60s

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
}
