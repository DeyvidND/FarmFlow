import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { and, eq, sql, desc } from 'drizzle-orm';
import { type Database, shipments, orders, codRisk, codRiskEvents } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
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

const NK_CACHE_PREFIX = 'codrisk:nk:';
const NK_CACHE_TTL = 7 * 24 * 3600; // 7 days — one nekorekten read per phone per week

@Injectable()
export class CodRiskService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly nekorekten: NekorektenClient,
    private readonly cache: PublicCacheService,
  ) {}

  /** Combined risk view for a phone — OUR DB first, then nekorekten only when needed
   *  (short-circuit when our strikes already flag `high`; otherwise a 7d Redis cache
   *  means at most one API call per phone per week). Our records + theirs come back in
   *  one unified `reports[]` shape. */
  async check(rawPhone: string): Promise<RiskCheckResult> {
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

    // Our DB first: strike count + the phone's returned-COD events (newest first).
    const [strikeRows, events] = await Promise.all([
      this.db.select({ strikes: codRisk.strikes }).from(codRisk).where(eq(codRisk.phone, phone)).limit(1),
      this.db
        .select({ createdAt: codRiskEvents.createdAt, phone: codRiskEvents.phone, type: codRiskEvents.type })
        .from(codRiskEvents)
        .where(and(eq(codRiskEvents.phone, phone), eq(codRiskEvents.type, 'returned')))
        .orderBy(desc(codRiskEvents.createdAt))
        .limit(20),
    ]);
    const strikes = strikeRows[0]?.strikes ?? 0;

    let nk: NekorektenCheck;
    let cached: boolean;
    if (riskVerdict(strikes, 0) === 'high') {
      // Already flagged by our own strikes — don't spend nekorekten quota.
      nk = { configured: this.nekorekten.configured, found: false, count: 0, reports: [] };
      cached = true;
    } else {
      const key = `${NK_CACHE_PREFIX}${phone}`;
      const hit = await this.cache.get<NekorektenCheck>(key).catch(() => null);
      if (hit) {
        nk = hit;
        cached = true;
      } else {
        nk = await this.nekorekten.checkPhone(phone);
        cached = false;
        // Only cache a real (configured) answer — failures degrade to empty and must retry.
        if (nk.configured) await this.cache.set(key, nk, NK_CACHE_TTL).catch(() => undefined);
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
