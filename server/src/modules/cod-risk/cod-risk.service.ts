import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { and, eq, sql, desc } from 'drizzle-orm';
import { type Database, shipments, orders, codRisk, codRiskEvents } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { NekorektenClient } from './nekorekten.client';
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
  /** 'ok'|'caution'|'high' for answered; 'rate_limited'|'unavailable' for non-answers. */
  status: 'ok' | 'caution' | 'high' | 'rate_limited' | 'unavailable';
  retryAfterSeconds?: number;
}

export interface BulkMeta {
  /** Phones that received a real verdict this run. */
  checked: number;
  /** Phones returned as rate_limited (not answered). */
  rateLimited: number;
  /** Which limit was hit first (null if no limit was hit). */
  limit: 'minute' | 'day' | null;
  /** Seconds until the first limit resets (0 if no limit). */
  retryAfterSeconds: number;
}

@Injectable()
export class CodRiskService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly nekorekten: NekorektenClient,
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
      nk = { configured: this.nekorekten.configured, found: false, count: 0, reports: [], status: 'ok' };
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
          status: (row?.nkFound ? 'ok' : 'not_found') as NekorektenCheck['status'],
        };
        cached = true;
      } else {
        // Stale / never checked / force-refresh → hit the API.
        nk = await this.nekorekten.checkPhone(phone);
        cached = false;

        // Rate-limited or unavailable — do NOT persist (never cache a non-answer as clean).
        // Serve the existing DB snapshot if the row already has nk_* data.
        if (nk.status === 'rate_limited' || nk.status === 'unavailable') {
          const snapshotNk: NekorektenCheck = {
            configured: this.nekorekten.configured,
            found: row?.nkFound ?? false,
            count: row?.nkCount ?? 0,
            reports: Array.isArray(row?.nkReports) ? (row!.nkReports as any[]) : [],
            status: nk.status,
            retryAfterSeconds: nk.retryAfterSeconds,
          };
          // cached=true signals no successful live write happened
          return {
            phone,
            verdict: riskVerdict(strikes, snapshotNk.count),
            strikes,
            nekorektenCount: snapshotNk.count,
            nekorektenConfigured: snapshotNk.configured,
            cached: true,
            reports: mergeReports(toInternalReports(events, phone), toNekorektenReports(snapshotNk)),
            nkStatus: nk.status,
            retryAfterSeconds: nk.retryAfterSeconds,
          };
        }

        // Persist to DB only when the key is configured and the call succeeded.
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
      nkStatus: nk.status,
    };
  }

  /** Bulk risk check for a list of phones. Dedupes by normalized phone, caps at
   *  BULK_CAP unique phones. Runs a bounded-concurrency worker pool (CONCURRENCY=5).
   *  Stop-on-limit (behavior A): the first rate_limited result stops further API calls.
   *  Remaining phones are processed with skipApi:true (DB/local only). */
  async checkBulk(
    tenantId: string,
    phones: string[],
  ): Promise<{ results: BulkRiskResult[]; meta: BulkMeta }> {
    // Normalize + dedupe: preserve original input but process each unique normalized
    // phone only once, then map results back to all inputs.
    const seen = new Map<string, string>(); // normalized → first original input
    for (const p of phones) {
      const norm = normalizePhone(p);
      const key = norm ?? p; // group un-normalizable phones by raw value
      if (!seen.has(key)) seen.set(key, p);
      if (seen.size >= BULK_CAP) break; // cap to bound quota burst
    }

    // Bounded-concurrency worker pool over unique phones.
    // Stop-on-limit: once a check returns rate_limited, remaining phones use skipApi.
    let stopped = false;
    let stopLimit: 'minute' | 'day' | null = null;
    let stopRetryAfter = 0;
    let checkedCount = 0;
    let rateLimitedCount = 0;

    const resultMap = new Map<string, RiskCheckResult>();
    const entries = Array.from(seen.entries());
    let idx = 0;

    const self = this;
    async function worker(): Promise<void> {
      while (idx < entries.length) {
        const [normKey, origPhone] = entries[idx++];
        const skipApi = stopped;
        const r = await self.check(origPhone, { skipApi });

        if (r.nkStatus === 'rate_limited') {
          // First rate-limit hit: engage stop-on-limit flag.
          if (!stopped) {
            stopped = true;
            // Heuristic: day limit yields much larger retryAfterSeconds (hours vs <60s).
            stopLimit = (r.retryAfterSeconds ?? 0) > 120 ? 'day' : 'minute';
            stopRetryAfter = r.retryAfterSeconds ?? 0;
          }
          rateLimitedCount++;
        } else {
          // Answered (ok / caution / high / unavailable / cached).
          if (!skipApi) checkedCount++;
        }

        resultMap.set(normKey, r);
      }
    }

    // Launch CONCURRENCY workers in parallel; each pulls the next entry atomically
    // (single-threaded JS — no race on idx/stopped).
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // Map every INPUT phone (including duplicates) to its verdict.
    const out: BulkRiskResult[] = [];
    const counted = new Set<string>(); // avoid re-processing duplicates in output

    for (const p of phones) {
      const norm = normalizePhone(p);
      const key = norm ?? p;
      const r = resultMap.get(key);
      const isDupe = counted.has(key);
      if (!isDupe) counted.add(key);

      if (r) {
        const statusForBulk: BulkRiskResult['status'] =
          r.nkStatus === 'rate_limited' ? 'rate_limited'
          : r.nkStatus === 'unavailable' ? 'unavailable'
          : (r.verdict as 'ok' | 'caution' | 'high');

        out.push({
          phone: p,
          normalized: r.phone,
          verdict: r.verdict,
          strikes: r.strikes,
          nekorektenCount: r.nekorektenCount,
          cached: r.cached,
          status: statusForBulk,
          ...(r.retryAfterSeconds != null ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
        });
      }
    }

    return {
      results: out,
      meta: {
        checked: checkedCount,
        rateLimited: rateLimitedCount,
        limit: stopLimit,
        retryAfterSeconds: stopRetryAfter,
      },
    };
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
