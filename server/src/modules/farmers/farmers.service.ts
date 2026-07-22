import {
  Injectable, Inject, NotFoundException, ConflictException, ServiceUnavailableException, Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { and, eq, asc, desc, inArray, sql } from 'drizzle-orm';
import { type Database, farmers, farmerMedia, users, auditLogs, orders, tenants } from '@fermeribg/db';
import * as argon2 from 'argon2';
import { AuthService } from '../auth/auth.service';
import type { Farmer, FarmerMedia, FarmerRow, PublicFarmer } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { encodeImageJob } from '../../common/queue/image-job';
import { positionCase } from '../../common/db/reorder.util';
import { CreateFarmerDto } from './dto/create-farmer.dto';
import { UpdateFarmerDto } from './dto/update-farmer.dto';
import { UpdateMyFarmerDto } from './dto/update-my-farmer.dto';
import { normalizeLegal } from '../tenants/legal';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { ReorderDto } from '../../common/dto/reorder.dto';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';
import { optimizeImage } from '../storage/image.util';
import { smartFocal, smartFocalFromUrl } from '../storage/smart-crop.util';
import { tenantSlug } from '../../common/tenant-slug.util';
import { encryptSignature, decryptSignature, SignatureKeyMissingError } from '../../common/crypto/signature-crypto';
import { farmerCourierReady, farmerDeliveryNamespace } from '../orders/courier-eligibility';
import { effectiveTier } from './tier-autolink';
import { MapsService } from '../../common/maps/maps.service';

/** Codes for what's missing from a farmer's protocol-readiness (§5.1 of the
 *  consolidated-handover-protocol spec), in the same priority order surfaced to
 *  the "Готовност на фермерите" board. */
export type FarmerReadinessMissing = 'kind' | 'name' | 'identifier' | 'address' | 'signature';

export interface FarmerReadinessRow {
  farmerId: string;
  name: string;
  email: string | null;
  ready: boolean;
  missing: FarmerReadinessMissing[];
}

@Injectable()
export class FarmersService {
  private readonly logger = new Logger(FarmersService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
    private readonly auth: AuthService,
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
    // @Global MapsService — geocodes a farmer's map pin from address/city on change
    // (mirrors platform.service.ts's producersMap geocode-on-read pattern).
    private readonly maps: MapsService,
  ) {}

  /** Location string to geocode a farmer from: prefer the legal seat address (finer),
   *  else the free-text city. Null when neither is set. Mirrors
   *  platform.service.ts's private `producerLocationString` (same logic/name, kept
   *  local — that one isn't exported for cross-module reuse). */
  private producerLocationString(
    legal: { address?: string } | null | undefined,
    city: string | null | undefined,
  ): string | null {
    const addr = legal?.address?.trim();
    const c = city?.trim();
    return addr || c || null;
  }

  /** Farmers for the tenant, ordered by display position then age. `scope` (a
   *  producer's own id) narrows the list to that single farmer; null = all. */
  async findAll(tenantId: string, scope: string | null = null): Promise<FarmerRow[]> {
    const rows = await this.db
      .select()
      .from(farmers)
      .where(
        scope
          ? and(eq(farmers.tenantId, tenantId), eq(farmers.id, scope))
          : eq(farmers.tenantId, tenantId),
      )
      .orderBy(asc(farmers.position), asc(farmers.createdAt));
    return rows.map((r) => this.stripSignature(r));
  }

  /** Persist a new display order for the tenant's farmers. Tenant-scoped, one
   *  transaction; busts the catalog + public farmers caches. */
  async reorder(tenantId: string, dto: ReorderDto): Promise<{ ok: true }> {
    if (dto.items.length) {
      await this.db
        .update(farmers)
        .set({ position: positionCase(farmers.id, farmers.position, dto.items) })
        .where(and(inArray(farmers.id, dto.items.map((i) => i.id)), eq(farmers.tenantId, tenantId)));
    }
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return { ok: true };
  }

  async findOne(id: string, tenantId: string): Promise<FarmerRow> {
    const [row] = await this.db
      .select()
      .from(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Фермерът не е намерен');
    return this.stripSignature(row);
  }

  /** Strip the encrypted signature blob before a row leaves the general CRUD
   *  path (findAll/findOne/create/update) — it's served only by its dedicated
   *  `GET /farmers/:id/signature` endpoint. See `FarmerRow` in @fermeribg/types. */
  private stripSignature(row: Farmer): FarmerRow {
    const { signaturePng: _signaturePng, ...rest } = row;
    return rest;
  }

  /** Producer → login status map for the admin Фермери screen. */
  async listAccess(
    tenantId: string,
  ): Promise<Record<string, { hasLogin: true; loginEmail: string; invitePending: boolean }>> {
    const rows = await this.db
      .select({ farmerId: users.farmerId, email: users.email, mustChange: users.mustChangePassword })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'farmer')));
    const map: Record<string, { hasLogin: true; loginEmail: string; invitePending: boolean }> = {};
    for (const r of rows) {
      if (r.farmerId) map[r.farmerId] = { hasLogin: true, loginEmail: r.email, invitePending: r.mustChange };
    }
    return map;
  }

  /**
   * Per-farmer protocol-readiness for the "Готовност на фермерите" board (spec
   * §5.1/§5.2) — legal identity complete for the CHOSEN kind, AND a signature on
   * file. Read-only / advisory: nothing here blocks a handover (§5.3).
   *
   * The identifier check mirrors client/src/lib/legal-identity.ts's
   * buildLegalPayload EXACTLY: individual → regNo, everyone else (incl. unset
   * kind) → eik. Checking "either identifier" would let a wrongly-filled one
   * pass — an individual who typed their ЕИК instead of Рег.№ is not ready,
   * even though a field is technically filled in.
   *
   * Never decrypts the signature — only NOT NULL is checked, and the ciphertext
   * is never included in the response (same posture as findAll/findOne's
   * stripSignature, just via a narrower SELECT instead of an omit).
   */
  async listReadiness(tenantId: string): Promise<FarmerReadinessRow[]> {
    const rows = await this.db
      .select({
        id: farmers.id,
        name: farmers.name,
        email: farmers.email,
        legal: farmers.legal,
        signaturePng: farmers.signaturePng,
      })
      .from(farmers)
      .where(eq(farmers.tenantId, tenantId))
      .orderBy(asc(farmers.position), asc(farmers.createdAt));

    return rows.map((r) => {
      const legal = r.legal;
      const missing: FarmerReadinessMissing[] = [];
      if (!legal?.kind) missing.push('kind');
      if (!legal?.name?.trim()) missing.push('name');
      const isIndividual = legal?.kind === 'individual';
      const identifierOk = isIndividual ? !!legal?.regNo?.trim() : !!legal?.eik?.trim();
      if (!identifierOk) missing.push('identifier');
      if (!legal?.address?.trim()) missing.push('address');
      if (!r.signaturePng) missing.push('signature');
      return { farmerId: r.id, name: r.name, email: r.email, ready: missing.length === 0, missing };
    });
  }

  /** Invite (or re-invite) a producer: create the scoped login if absent, then email
   *  a set-password link. Idempotent re-invite resends to the (optionally updated)
   *  email. Email must be free across all users. */
  async grantAccess(
    tenantId: string,
    farmerId: string,
    email: string,
  ): Promise<{ hasLogin: true; loginEmail: string; invitePending: boolean }> {
    await this.findOne(farmerId, tenantId); // 404 if cross-tenant / missing

    // Normalize so the stored address matches what the producer types at login
    // (the login lookup is case-sensitive).
    const normalizedEmail = email.trim().toLowerCase();

    const [existing] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.farmerId, farmerId), eq(users.tenantId, tenantId)))
      .limit(1);

    // Email collision check (ignore the producer's own current row on re-invite).
    const [emailOwner] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    if (emailOwner && emailOwner.id !== existing?.id) {
      throw new ConflictException('Този имейл вече се използва');
    }

    let userId: string;
    if (existing) {
      const [updated] = await this.db
        .update(users)
        .set({ email: normalizedEmail, mustChangePassword: true, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, existing.id))
        .returning({ id: users.id });
      userId = updated.id;
    } else {
      const passwordHash = await argon2.hash(`${randomUUID()}${randomUUID()}`);
      const [created] = await this.db
        .insert(users)
        .values({ tenantId, farmerId, email: normalizedEmail, role: 'farmer', passwordHash, mustChangePassword: true })
        .returning({ id: users.id });
      userId = created.id;
    }

    // Swallow invite-send failures (mirrors AuthService.requestPasswordReset): the
    // account is created and the owner can re-send from the Фермери screen, so a
    // transient email outage must not 500 the provisioning call.
    try {
      await this.auth.sendFarmerInvite(userId);
    } catch (err) {
      this.logger.error(
        `Farmer invite email failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { hasLogin: true, loginEmail: normalizedEmail, invitePending: true };
  }

  /** Revoke a producer's login: kill live sessions (token_version bump) then delete. */
  async revokeAccess(tenantId: string, farmerId: string): Promise<{ ok: true }> {
    await this.findOne(farmerId, tenantId);
    const [login] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.farmerId, farmerId), eq(users.tenantId, tenantId)))
      .limit(1);
    if (!login) throw new NotFoundException('Този фермер няма достъп');
    // Clear the FK references to this login BEFORE deleting it — audit_logs.user_id
    // and orders.customer_id are ON DELETE NO ACTION, so a referenced user row can't
    // be deleted (raw delete → FK violation → 500). Null them (keep the audit trail
    // + any orders, just unlinked from the gone login) and bump tokenVersion so a
    // live JWT is rejected at once. All in one transaction so a mid-way failure
    // never leaves the login half-revoked.
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, login.id));
      await tx.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, login.id));
      await tx.update(orders).set({ customerId: null }).where(eq(orders.customerId, login.id));
      await tx.delete(users).where(eq(users.id, login.id));
    });
    return { ok: true };
  }

  async create(tenantId: string, dto: CreateFarmerDto): Promise<FarmerRow> {
    // lat/lng arrive as numbers on the DTO (manual override); the column is a Drizzle
    // numeric (string). Pull them out of the spread so they're never inserted raw.
    const { lat: latOverride, lng: lngOverride, ...fields } = dto;

    let coordFields: { lat: string; lng: string; geocodedAt: Date } | Record<string, never> = {};
    if (latOverride != null && lngOverride != null) {
      coordFields = { lat: String(latOverride), lng: String(lngOverride), geocodedAt: new Date() };
    } else if (this.maps.enabled) {
      // Best-effort geocode from whatever address/city came in at creation. geocodeApprox
      // never throws (graceful-degradation contract) — a maps outage must not fail signup.
      const loc = this.producerLocationString(fields.legal, fields.city);
      if (loc) {
        const ll = await this.maps.geocodeApprox(loc);
        if (ll) coordFields = { lat: String(ll.lat), lng: String(ll.lng), geocodedAt: new Date() };
      }
    }

    const [row] = await this.db
      .insert(farmers)
      .values({ ...fields, tenantId, ...coordFields })
      .returning();
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return this.stripSignature(row);
  }

  async update(id: string, tenantId: string, dto: UpdateFarmerDto): Promise<FarmerRow> {
    // lat/lng are a manual map-pin override, handled separately below — never spread
    // straight into the update set (wrong type: DTO carries them as numbers, the
    // column is a Drizzle numeric/string).
    const { lat: latOverride, lng: lngOverride, ...fields } = dto;

    // Lightweight pre-read for the geocode-on-change decision ONLY (city/legal).
    // Deliberately does NOT include tier/branding — those are re-read fresh inside the
    // write transaction below (same as the original code), so two concurrent PATCHes
    // still can't clobber each other's tier decision (TOCTOU). This read runs outside
    // any transaction because geocodeApprox below is a network call, and a DB
    // transaction must never be held open across one (see ARCHITECTURE.md).
    const [existingLoc] = await this.db
      .select({ city: farmers.city, legal: farmers.legal })
      .from(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .limit(1);
    if (!existingLoc) throw new NotFoundException('Фермерът не е намерен');

    // Resolve the new map pin before opening the write transaction.
    let coordFields: { lat: string; lng: string; geocodedAt: Date } | Record<string, never> = {};
    if (latOverride != null && lngOverride != null) {
      // Manual override always wins — skip geocoding entirely, regardless of maps.enabled.
      coordFields = { lat: String(latOverride), lng: String(lngOverride), geocodedAt: new Date() };
    } else if (this.maps.enabled) {
      const cityChanged = fields.city !== undefined && fields.city !== existingLoc.city;
      const addressChanged =
        fields.legal !== undefined && fields.legal?.address !== existingLoc.legal?.address;
      // Only spend a geocode call when the location-relevant fields actually changed —
      // an unrelated edit (bio, tint, products…) must not touch the pin.
      if (cityChanged || addressChanged) {
        const loc = this.producerLocationString(
          fields.legal !== undefined ? fields.legal : existingLoc.legal,
          fields.city !== undefined ? fields.city : existingLoc.city,
        );
        if (loc) {
          const ll = await this.maps.geocodeApprox(loc);
          // A miss/outage leaves the existing lat/lng/geocodedAt untouched — a transient
          // failure must never null out an already-good pin.
          if (ll) coordFields = { lat: String(ll.lat), lng: String(ll.lng), geocodedAt: new Date() };
        }
      }
    }

    // Read (current tier + branding) and write are wrapped in one transaction so two
    // concurrent PATCHes for the same farmer can't both read the same stale state and
    // have the second write silently clobber the first's tier decision (TOCTOU) —
    // identical safety to the pre-geocoding version. The geocode network call above has
    // already completed, so this transaction only ever wraps DB work.
    const row = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ tier: farmers.tier, branding: farmers.branding })
        .from(farmers)
        .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
        .limit(1);
      if (!existing) throw new NotFoundException('Фермерът не е намерен');

      const brandingEnabled =
        (dto.branding !== undefined ? dto.branding : existing.branding)?.enabled ?? false;
      const tier = effectiveTier({
        currentTier: existing.tier,
        brandingEnabled,
        explicitTier: dto.tier,
      });

      const [updated] = await tx
        .update(farmers)
        .set({ ...fields, tier, ...coordFields })
        .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
        .returning();
      if (!updated) throw new NotFoundException('Фермерът не е намерен');
      return updated;
    });
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return this.stripSignature(row);
  }

  /**
   * A producer editing its OWN row (`PATCH /farmers/me`). `id` is always the token's
   * farmerId — never a client-supplied param — and the WHERE is doubly scoped
   * (id + tenantId), so this can't reach another producer or another tenant.
   *
   * Unlike `update()` this does NOT spread the DTO: each allowed column is copied
   * across explicitly, so adding a field to `UpdateMyFarmerDto` later can never
   * silently widen what a farmer may write. No tier logic either — `tier` is derived
   * from branding, which is not self-editable.
   */
  async updateMe(id: string, tenantId: string, dto: UpdateMyFarmerDto): Promise<FarmerRow> {
    const patch: Partial<Pick<Farmer, 'phone' | 'email' | 'legal'>> = {};
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.email !== undefined) patch.email = dto.email;
    // `normalizeLegal` trims and stamps `confirmedAt` server-side — the farmer signs
    // off on their own identity here, and can never forge the confirmation date.
    if (dto.legal !== undefined) patch.legal = normalizeLegal(dto.legal);

    // Drizzle throws on `.set({})`; an empty PATCH is a no-op read instead.
    if (Object.keys(patch).length === 0) return this.findOne(id, tenantId);

    const [row] = await this.db
      .update(farmers)
      .set(patch)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Фермерът не е намерен');

    // `legal` rides the public farmer projection (required seller disclosure), so the
    // same caches `update()` busts must be busted here too or the storefront goes stale.
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return this.stripSignature(row);
  }

  /** The farmer's saved signature, decrypted, for the operator panel preview.
   *  404 on a missing / cross-tenant farmer — never leaks another tenant's row. */
  async getSignature(id: string, tenantId: string): Promise<{ signaturePng: string | null }> {
    const [row] = await this.db
      .select({ signaturePng: farmers.signaturePng })
      .from(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Фермерът не е намерен');
    return { signaturePng: decryptSignature(row.signaturePng) };
  }

  /** Store (encrypted) or clear the farmer's reusable signature. Refuses to store
   *  anything when ENCRYPTION_KEY is unset — a signature is never persisted in
   *  plaintext. Clearing (png === null) stays allowed with no key. */
  async setSignature(
    id: string,
    tenantId: string,
    png: string | null,
  ): Promise<{ signaturePng: string | null }> {
    let enc: string | null = null;
    if (png) {
      try {
        enc = encryptSignature(png);
      } catch (e) {
        if (e instanceof SignatureKeyMissingError) {
          throw new ServiceUnavailableException(
            'Подписът не може да бъде запазен — липсва ключ за криптиране на сървъра.',
          );
        }
        throw e;
      }
    }
    const [updated] = await this.db
      .update(farmers)
      .set({ signaturePng: enc })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .returning({ id: farmers.id });
    if (!updated) throw new NotFoundException('Фермерът не е намерен');
    return { signaturePng: png };
  }

  /** Hard delete; products.farmer_id FK is ON DELETE SET NULL, so products unlink.
   *  Gallery rows drop via FK cascade; their R2 objects are purged here first. */
  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const farmer = await this.findOne(id, tenantId);
    const media = await this.db
      .select({ url: farmerMedia.url })
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id));
    // Resolve the tenant slug once (instead of once per deleted object) — only when
    // there's actually something to purge, so a farmer with no cover/gallery never
    // pays for the extra SELECT.
    let slug: string | undefined;
    if (media.length || farmer.imageUrl) {
      try {
        slug = await tenantSlug(this.db, tenantId);
      } catch {
        // best-effort: R2 purge skipped, DB delete proceeds
      }
    }
    await Promise.all(media.map((m) => this.deleteObject(m.url, tenantId, slug)));
    if (farmer.imageUrl) await this.deleteObject(farmer.imageUrl, tenantId, slug);
    await this.db.transaction(async (tx) => {
      // The farmer's login (users.farmer_id = id) is ON DELETE cascade, but the cascade
      // can't drop a login still referenced by orders.customer_id / audit_logs.user_id
      // (both ON DELETE NO ACTION) — so deleting a farmer who ever logged in (audit row)
      // or is an order's customer would fail with an FK violation, leaving the farmer +
      // login + its UNIQUE email stuck ("този имейл вече се използва" on re-add). Null
      // those refs first (mirror revokeAccess) so the cascade removes the login cleanly
      // and frees the email for re-use.
      const [login] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.farmerId, id), eq(users.tenantId, tenantId)))
        .limit(1);
      if (login) {
        await tx.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, login.id));
        await tx.update(orders).set({ customerId: null }).where(eq(orders.customerId, login.id));
      }
      await tx
        .delete(farmers)
        .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)));
    });
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return { id };
  }

  async uploadImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<FarmerRow & { imageProcessing: boolean }> {
    const farmer = await this.findOne(id, tenantId);
    await this.imageQueue.add('process', encodeImageJob('farmer-cover', id, tenantId, file));
    return { ...farmer, imageProcessing: true };
  }

  /** Called by the image worker after it has decoded and optimized the bytes. */
  async finishFarmerCover(
    id: string,
    tenantId: string,
    buffer: Buffer,
    mime: string,
  ): Promise<void> {
    const farmer = await this.findOne(id, tenantId);
    const img = await optimizeImage(
      buffer,
      mime,
      PRODUCT_IMAGE_EXT_BY_MIME[mime] ?? 'bin',
    );
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/farmers/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);
    if (farmer.imageUrl) await this.deleteObject(farmer.imageUrl, tenantId, slug);
    await this.db
      .update(farmers)
      .set({ imageUrl: url, coverCrop: await smartFocal(img.buffer) })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .returning();
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
  }

  // ---- Gallery (multi-image) ----

  /** Ordered gallery for a farmer (admin). 404 if missing / cross-tenant. */
  async listMedia(id: string, tenantId: string): Promise<FarmerMedia[]> {
    await this.findOne(id, tenantId);
    return this.db
      .select()
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id))
      .orderBy(asc(farmerMedia.position));
  }

  /** Append an uploaded photo to the gallery (async path): validates ownership
   *  then enqueues the heavy optimize+upload work; returns immediately so the
   *  HTTP response is fast. The worker calls `finishFarmerMedia` once done. */
  async addMedia(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<{ imageProcessing: boolean }> {
    await this.findOne(id, tenantId);
    await this.imageQueue.add('process', encodeImageJob('farmer-media', id, tenantId, file));
    return { imageProcessing: true };
  }

  /** Worker finisher: runs the full synchronous optimize → upload → insert → syncCover
   *  pipeline for a gallery photo after the queue has decoded the raw bytes. */
  async finishFarmerMedia(
    id: string,
    tenantId: string,
    buffer: Buffer,
    mime: string,
  ): Promise<void> {
    const farmer = await this.findOne(id, tenantId);

    const existing = await this.db
      .select()
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id))
      .orderBy(asc(farmerMedia.position));

    // Legacy item (cover set, no gallery yet): adopt the existing cover as photo 0.
    if (existing.length === 0 && farmer.imageUrl) {
      const [adopted] = await this.db
        .insert(farmerMedia)
        .values({ farmerId: id, tenantId, url: farmer.imageUrl, position: 0 })
        .returning();
      existing.push(adopted);
    }

    const img = await optimizeImage(
      buffer,
      mime,
      PRODUCT_IMAGE_EXT_BY_MIME[mime] ?? 'bin',
    );
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/farmers/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);

    await this.db
      .insert(farmerMedia)
      .values({ farmerId: id, tenantId, url, position: existing.length })
      .returning();

    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
  }

  /** Remove one gallery photo (DB row + R2 object), then re-sync the cover. */
  async removeMedia(
    id: string,
    mediaId: string,
    tenantId: string,
  ): Promise<{ id: string }> {
    await this.findOne(id, tenantId);

    const [m] = await this.db
      .select()
      .from(farmerMedia)
      .where(
        and(
          eq(farmerMedia.id, mediaId),
          eq(farmerMedia.farmerId, id),
          eq(farmerMedia.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!m) throw new NotFoundException('Снимката не е намерена');

    await this.deleteObject(m.url, tenantId);
    await this.db.delete(farmerMedia).where(eq(farmerMedia.id, mediaId));
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return { id: mediaId };
  }

  /** Persist a new gallery order; cover follows whichever photo is now position 0. */
  async reorderMedia(
    id: string,
    tenantId: string,
    dto: ReorderMediaDto,
  ): Promise<FarmerMedia[]> {
    await this.findOne(id, tenantId);

    // One UPDATE … CASE … END instead of a statement per row.
    if (dto.items.length) {
      await this.db
        .update(farmerMedia)
        .set({ position: positionCase(farmerMedia.id, farmerMedia.position, dto.items) })
        .where(
          and(
            inArray(farmerMedia.id, dto.items.map((i) => i.id)),
            eq(farmerMedia.farmerId, id),
            eq(farmerMedia.tenantId, tenantId),
          ),
        );
    }
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));

    return this.db
      .select()
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id))
      .orderBy(asc(farmerMedia.position));
  }

  /** Mirror the first gallery photo into `farmers.imageUrl` as the cover; NULLs it
   *  when the gallery is empty. */
  private async syncCover(id: string, tenantId: string): Promise<void> {
    // Two independent reads (gallery cover + current cover) — run them together.
    const [[first], [cur]] = await Promise.all([
      this.db
        .select({ url: farmerMedia.url })
        .from(farmerMedia)
        .where(eq(farmerMedia.farmerId, id))
        .orderBy(asc(farmerMedia.position))
        .limit(1),
      this.db
        .select({ imageUrl: farmers.imageUrl })
        .from(farmers)
        .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
        .limit(1),
    ]);
    const newUrl = first?.url ?? null;
    // Cover image unchanged → keep whatever framing is set (incl. a manual override).
    if (cur?.imageUrl === newUrl) return;
    // New cover → recompute a content-aware focal default (the old framing belonged
    // to the previous image; the cover editor also resets it on a cover change).
    const coverCrop = newUrl
      ? await smartFocalFromUrl(newUrl, this.storage.getPublicBaseUrl())
      : null;
    await this.db
      .update(farmers)
      .set({ imageUrl: newUrl, coverCrop })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)));
  }

  /** Gallery photo URLs (ordered) for a set of farmers — single query, no N+1. */
  private async mediaUrlsByFarmer(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    const rows = await this.db
      .select({ farmerId: farmerMedia.farmerId, url: farmerMedia.url })
      .from(farmerMedia)
      .where(inArray(farmerMedia.farmerId, ids))
      .orderBy(asc(farmerMedia.position));
    for (const r of rows) {
      const list = map.get(r.farmerId!) ?? [];
      list.push(r.url);
      map.set(r.farmerId!, list);
    }
    return map;
  }

  /** Public farmers for a storefront slug — [] unless the tenant has multiFarmer on. */
  async findPublicBySlug(slug: string): Promise<PublicFarmer[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    if (!tenant.multiFarmer) return [];

    const key = publicCacheKeys.farmers(tenant.id);
    const cached = await this.publicCache.get<PublicFarmer[]>(key);
    if (cached) return cached;

    // Explicit column projection — NOT bare `.select()`. Two of the farmers
    // columns (commission_rate_bps / subscription_fee_stotinki) are the operator's
    // owner-only commercial terms and must never reach the storefront; projecting
    // only the public columns strips them at the SQL level. It also keeps this
    // storefront-critical query immune to the schema-ahead-of-migration window
    // (deploy self-heals the schema, but a bare select enumerating a not-yet-
    // migrated column would 500 every multiFarmer bootstrap). email + phone ARE
    // included on purpose — the farmer subpage shows each farmer's own contact
    // (product decision 2026-07-02); the site-wide official contact stays the
    // tenant's.
    const rows = await this.db
      .select({
        id: farmers.id,
        name: farmers.name,
        role: farmers.role,
        bio: farmers.bio,
        phone: farmers.phone,
        email: farmers.email,
        since: farmers.since,
        city: farmers.city,
        tint: farmers.tint,
        imageUrl: farmers.imageUrl,
        coverCrop: farmers.coverCrop,
        // Tier-2 branding is presentational only (no finance) → safe to expose. When
        // enabled, the marketplace renders the branded farmer subpage.
        branding: farmers.branding,
        // Legal seller identity — REQUIRED public КЗП disclosure (who the buyer
        // contracts with). Unlike commissionRateBps/subscriptionFeeStotinki (owner-only
        // finance, stripped below) this is meant to be shown on the storefront.
        legal: farmers.legal,
        // „За фермата" — long public story. Operator-only notes/payout are NOT selected here.
        story: farmers.story,
        tier: farmers.tier,
        position: farmers.position,
        createdAt: farmers.createdAt,
        // Approximate map pin for the storefront farmer map — geocodedAt stays internal
        // (selected nowhere here), only the resolved coords are public.
        lat: farmers.lat,
        lng: farmers.lng,
      })
      .from(farmers)
      .where(eq(farmers.tenantId, tenant.id))
      .orderBy(desc(farmers.tier), asc(farmers.position), asc(farmers.createdAt));
    const mediaByFarmer = await this.mediaUrlsByFarmer(rows.map((r) => r.id));
    const [tRow] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenant.id))
      .limit(1);
    const settings = tRow?.settings ?? null;
    // Defense-in-depth: the projection above already omits the owner-only finance
    // columns and tenantId, but strip them again here so a future bare-select
    // regression (or a join that re-introduces them) can never leak the operator's
    // commercial terms to the storefront. The cast widens the row type so the
    // omit type-checks against the narrow projection.
    const result: PublicFarmer[] = rows.map((row) => {
      const {
        tenantId: _tenantId,
        commissionRateBps: _commissionRateBps,
        subscriptionFeeStotinki: _subscriptionFeeStotinki,
        internalNotes: _internalNotes,
        payout: _payout,
        ...rest
      } = row as typeof row & {
        tenantId?: string | null;
        commissionRateBps?: number | null;
        subscriptionFeeStotinki?: number | null;
        internalNotes?: string | null;
        payout?: unknown;
      };
      const urls = mediaByFarmer.get(rest.id) ?? [];
      const images = urls.length ? urls : rest.imageUrl ? [rest.imageUrl] : [];
      const courierReady = farmerCourierReady(farmerDeliveryNamespace(settings, rest.id));
      // Drizzle numeric columns come back as strings — the public projection converts
      // to number for the storefront map (PublicFarmer.lat/lng are `number | null`).
      const lat = rest.lat != null ? Number(rest.lat) : null;
      const lng = rest.lng != null ? Number(rest.lng) : null;
      return { ...rest, images, courierReady, lat, lng };
    });
    await this.publicCache.set(key, result);
    return result;
  }

  /** Best-effort removal of a stored object given its public URL.
   *  SECURITY: `imageUrl` (and the media URL seeded from it) is a client-settable
   *  DTO field, so a stored URL may point at ANOTHER tenant's object. Only ever
   *  delete objects under this tenant's own `tenants/<slug>/` key prefix — never
   *  trust the raw key. Every uploaded object for this entity lives under that
   *  prefix, so legitimate cleanups are unaffected. */
  private async deleteObject(url: string, tenantId: string, slug?: string): Promise<void> {
    try {
      const key = new URL(url).pathname.replace(/^\/+/, '');
      if (!key) return;
      const s = slug ?? await tenantSlug(this.db, tenantId);
      if (!key.startsWith(`tenants/${s}/`)) return;
      await this.storage.delete(key);
    } catch {
      // a storage hiccup (or a missing/foreign tenant) must not block the DB write
    }
  }
}
