import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { and, eq, sql, desc } from 'drizzle-orm';
import { type Database, shipments, orders, codRisk, codRiskEvents } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { NekorektenClient } from './nekorekten.client';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import {
  normalizePhone,
  riskVerdict,
  isReturnedStatus,
  buildReportText,
  toInternalReports,
  toNekorektenReports,
  mergeReports,
  type NekorektenCheck,
  type RiskCheckResult,
} from './cod-risk.helpers';

// Adaptive TTL (seconds): flagged phones rarely heal → cache 90 days.
// Clean phones can turn bad → re-check after 30 days.
const FLAGGED_TTL = 90 * 24 * 3600; // 90 days in seconds
const CLEAN_TTL = 30 * 24 * 3600;   // 30 days in seconds
const BULK_CAP = 500;                 // max unique phones per bulk call
const CONCURRENCY = 5;               // worker-pool width for checkBulk
const MAX_LIVE_CALLS = 50;           // hard cap on live API calls per bulk request
const DAILY_NK_BUDGET = 200;         // per-tenant daily Nekorekten call budget

/** Pick the durable TTL (seconds) based on whether nekorekten found reports. */
function ttlFor(found: boolean | null | undefined): number {
  return found ? FLAGGED_TTL : CLEAN_TTL;
}

export interface BulkRiskResult {
  phone: string;       // original input phone
  normalized: string | null;
  verdict: string;
  strikes: number;
  nekorektenCount: number;
  cached: boolean;
}

@Injectable()
export class CodRiskService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly nekorekten: NekorektenClient,
    private readonly cache: PublicCacheService,
  ) {}

  /** Combined risk view for a phone — OUR DB first (durable nekorekten snapshot with
   *  adaptive TTL), then a live Nekorekten call only when the snapshot is stale/absent.
   *  Short-circuits when our own strikes already verdict `high`.
   *
   *  opts.forceRefresh — bypass TTL and hit the API even if the row is fresh.
   *  opts.skipApi     — never hit the API; serve DB snapshot (possibly stale/absent).
   *                     When set and the row is stale/absent, returns whatever DB has
   *                     (possibly empty/local-only) with cached=true. */
  async check(rawPhone: string, opts?: { forceRefresh?: boolean; skipApi?: boolean }): Promise<RiskCheckResult> {
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return {
        phone: null,
        verdict: 'ok',
        strikes: 0,
        nekorektenCount: 0,
        nekorektenConfigured: this.nekorekten.configured,
        cached: true,
        reports: [],
      };
    }

    // Load both the cod_risk row (strikes + nk_* snapshot) and recent returned events.
    const [riskRows, events] = await Promise.all([
      this.db
        .select({
          strikes: codRisk.strikes,
          nkFound: codRisk.nkFound,
          nkCount: codRisk.nkCount,
          nkReports: codRisk.nkReports,
          nkCheckedAt: codRisk.nkCheckedAt,
        })
        .from(codRisk)
        .where(eq(codRisk.phone, phone))
        .limit(1),
      this.db
        .select({ createdAt: codRiskEvents.createdAt, phone: codRiskEvents.phone, type: codRiskEvents.type })
        .from(codRiskEvents)
        .where(and(eq(codRiskEvents.phone, phone), eq(codRiskEvents.type, 'returned')))
        .orderBy(desc(codRiskEvents.createdAt))
        .limit(20),
    ]);

    const row = riskRows[0];
    const strikes = row?.strikes ?? 0;

    let nk: NekorektenCheck;
    let cached: boolean;

    if (riskVerdict(strikes, 0) === 'high') {
      // Already flagged by our own strikes — don't spend nekorekten quota.
      nk = { configured: this.nekorekten.configured, found: false, count: 0, reports: [] };
      cached = true;
    } else {
      // Decide freshness from DB snapshot.
      const nkCheckedAt = row?.nkCheckedAt ?? null;
      const ageMs = nkCheckedAt ? Date.now() - new Date(nkCheckedAt).getTime() : Infinity;
      const ttlMs = ttlFor(row?.nkFound) * 1000;
      const fresh = nkCheckedAt != null && ageMs < ttlMs && !opts?.forceRefresh;

      if (fresh || opts?.skipApi) {
        // Serve from DB snapshot — no API call.
        // When skipApi and the row is stale/absent, return whatever DB has (may be empty).
        nk = {
          configured: this.nekorekten.configured,
          found: row?.nkFound ?? false,
          count: row?.nkCount ?? 0,
          reports: Array.isArray(row?.nkReports) ? (row!.nkReports as any[]) : [],
        };
        cached = true;
      } else {
        // Stale / never checked / force-refresh → hit the API.
        nk = await this.nekorekten.checkPhone(phone);
        cached = false;
        // Persist to DB only when the key is configured (degraded calls return empty).
        if (nk.configured) {
          await this.db
            .insert(codRisk)
            .values({
              phone,
              strikes: 0,
              nkFound: nk.found,
              nkCount: nk.count,
              nkReports: nk.reports as any,
              nkCheckedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: codRisk.phone,
              set: {
                nkFound: nk.found,
                nkCount: nk.count,
                nkReports: nk.reports as any,
                nkCheckedAt: new Date(),
                updatedAt: new Date(),
              },
            });
        }
      }
    }

    return {
      phone,
      verdict: riskVerdict(strikes, nk.count),
      strikes,
      nekorektenCount: nk.count,
      nekorektenConfigured: nk.configured,
      cached,
      reports: mergeReports(toInternalReports(events, phone), toNekorektenReports(nk)),
    };
  }

  /** Bulk risk check for a list of phones. Dedupes by normalized phone, caps at
   *  BULK_CAP unique phones. Runs a bounded-concurrency worker pool (CONCURRENCY=5)
   *  with a per-request live-call cap (MAX_LIVE_CALLS) and a per-tenant daily budget
   *  (DAILY_NK_BUDGET). Phones beyond the live-call cap are served from DB snapshot. */
  async checkBulk(tenantId: string, phones: string[]): Promise<BulkRiskResult[]> {
    // Normalize + dedupe: preserve original input but process each unique normalized
    // phone only once, then map results back to all inputs.
    const seen = new Map<string, string>(); // normalized → first original input
    for (const p of phones) {
      const norm = normalizePhone(p);
      const key = norm ?? p; // group un-normalizable phones by raw value
      if (!seen.has(key)) seen.set(key, p);
      if (seen.size >= BULK_CAP) break; // cap to bound quota burst
    }

    // Read per-tenant daily budget from Redis.
    const budgetKey = `nk:budget:${tenantId}:${new Date().toISOString().slice(0, 10)}`;
    const usedRaw = await this.cache.get<number>(budgetKey);
    const used = typeof usedRaw === 'number' ? usedRaw : 0;
    const remaining = Math.max(0, DAILY_NK_BUDGET - used);
    const liveCap = Math.min(MAX_LIVE_CALLS, remaining);

    // Bounded-concurrency worker pool over unique phones.
    // liveUsed counts how many check() calls returned cached=false (i.e. hit the API).
    let liveUsed = 0;
    const resultMap = new Map<string, RiskCheckResult>();

    const entries = Array.from(seen.entries());
    let idx = 0;

    async function worker(self: CodRiskService): Promise<void> {
      while (idx < entries.length) {
        const [normKey, origPhone] = entries[idx++];
        const skipApi = liveUsed >= liveCap;
        const r = await self.check(origPhone, { skipApi });
        if (!r.cached) liveUsed++;
        resultMap.set(normKey, r);
      }
    }

    // Launch CONCURRENCY workers in parallel; each pulls the next entry atomically
    // (single-threaded JS — no race on idx/liveUsed).
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(this)));

    // Write back the updated budget counter if any live calls were made.
    if (liveUsed > 0) {
      await this.cache.set(budgetKey, used + liveUsed, 24 * 3600);
    }

    // Map every INPUT phone (including duplicates) to its verdict.
    const out: BulkRiskResult[] = [];
    const counted = new Set<string>(); // avoid re-processing duplicates in output
    for (const p of phones) {
      const norm = normalizePhone(p);
      const key = norm ?? p;
      if (counted.has(key)) {
        // Duplicate: emit with same result as canonical; use canonical r.phone for normalized.
        const r = resultMap.get(key);
        if (r) {
          out.push({ phone: p, normalized: r.phone, verdict: r.verdict, strikes: r.strikes, nekorektenCount: r.nekorektenCount, cached: r.cached });
        }
        continue;
      }
      counted.add(key);
      const r = resultMap.get(key);
      if (r) {
        out.push({ phone: p, normalized: r.phone, verdict: r.verdict, strikes: r.strikes, nekorektenCount: r.nekorektenCount, cached: r.cached });
      }
    }
    return out;
  }

  /** Called from the Econt refresh hook. Idempotent: only the first transition of a
   *  COD shipment into a returned/refused status records a strike + a candidate. */
  async recordReturnIfApplicable(shipment: typeof shipments.$inferSelect): Promise<void> {
    if (shipment.codAmountStotinki == null) return; // not a COD parcel
    if (!isReturnedStatus(shipment.status)) return;
    if (shipment.reportStatus && shipment.reportStatus !== 'none') return; // cheap fast-path

    // Atomically claim this shipment as a candidate (compare-and-set on report_status):
    // only the transition FROM 'none' proceeds, so two concurrent refreshes (the cron
    // pass overlapping a manual refresh) can't both record a strike — counted once.
    const claimed = await this.db
      .update(shipments)
      .set({ reportStatus: 'candidate' })
      .where(and(eq(shipments.id, shipment.id), eq(shipments.reportStatus, 'none')))
      .returning({ id: shipments.id });
    if (claimed.length === 0) return; // lost the race / already handled

    let rawPhone: string | null = shipment.receiverPhone;
    if (!rawPhone && shipment.orderId) {
      const [o] = await this.db
        .select({ phone: orders.customerPhone })
        .from(orders)
        .where(eq(orders.id, shipment.orderId))
        .limit(1);
      rawPhone = o?.phone ?? null;
    }
    const phone = normalizePhone(rawPhone ?? '');
    if (!phone) return; // claimed (won't re-process) but no phone to key a strike

    await this.db
      .insert(codRisk)
      .values({ phone, strikes: 1, lastEventType: 'returned', lastEventAt: new Date() })
      .onConflictDoUpdate({
        target: codRisk.phone,
        set: { strikes: sql`${codRisk.strikes} + 1`, lastEventType: 'returned', lastEventAt: new Date(), updatedAt: new Date() },
      });
    await this.db.insert(codRiskEvents).values({ phone, tenantId: shipment.tenantId, shipmentId: shipment.id, type: 'returned' });
  }

  /** Returned-COD shipments for this tenant awaiting a report decision. */
  async listCandidates(tenantId: string): Promise<Array<{ shipmentId: string; receiverName: string | null; phone: string | null; codAmountStotinki: number | null }>> {
    const rows = await this.db
      .select({
        shipmentId: shipments.id,
        receiverName: shipments.receiverName,
        receiverPhone: shipments.receiverPhone,
        codAmountStotinki: shipments.codAmountStotinki,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.reportStatus, 'candidate')));
    return rows.map((r) => ({
      shipmentId: r.shipmentId,
      receiverName: r.receiverName,
      phone: normalizePhone(r.receiverPhone ?? ''),
      codAmountStotinki: r.codAmountStotinki,
    }));
  }

  /** Farmer-confirmed: report this returned COD shipment to nekorekten (under the
   *  platform account). Tenant-scoped. Keeps the candidate on failure for retry. */
  async confirmReport(tenantId: string, shipmentId: string): Promise<{ reported: true }> {
    const [s] = await this.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)))
      .limit(1);
    if (!s) throw new NotFoundException('Пратката не е намерена');

    let rawPhone: string | null = s.receiverPhone;
    if (!rawPhone && s.orderId) {
      const [o] = await this.db.select({ phone: orders.customerPhone }).from(orders).where(eq(orders.id, s.orderId)).limit(1);
      rawPhone = o?.phone ?? null;
    }
    const phone = normalizePhone(rawPhone ?? '');
    if (!phone) throw new BadRequestException('Няма валиден телефон за докладване');

    await this.nekorekten.reportPhone({ phone, text: buildReportText(s), name: s.receiverName ?? undefined });

    await this.db.update(shipments).set({ reportStatus: 'reported' }).where(eq(shipments.id, shipmentId));
    await this.db.insert(codRiskEvents).values({ phone, tenantId, shipmentId, type: 'reported' });
    return { reported: true };
  }
}
