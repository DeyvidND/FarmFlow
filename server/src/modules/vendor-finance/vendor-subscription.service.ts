import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { type Database, farmers, tenants, vendorSubscriptionCharges } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { readVendorFinance } from './vendor-finance.settings';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface VendorChargeRow {
  id: string;
  farmerId: string | null;
  farmerName: string | null;
  period: string;
  feeStotinki: number;
  status: 'due' | 'paid' | 'waived';
  paidAt: Date | null;
  note: string | null;
}

/**
 * Vendor monthly subscription tracker (DORMANT until
 * `settings.vendorFinance.subscriptionEnabled`). Nothing is auto-charged anywhere:
 * the operator collects the fee off-platform (as today) and this ledger only
 * answers "who owes what for which month". Generation is an explicit owner action
 * (no cron), idempotent per (farmer, period).
 */
@Injectable()
export class VendorSubscriptionService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /** Create the month's `due` rows for every farmer with a resolvable fee > 0. */
  async generateForPeriod(
    tenantId: string,
    period: string,
  ): Promise<{ created: number; skipped: number }> {
    if (!PERIOD_RE.test(period)) {
      throw new BadRequestException('Невалиден период — очаква се формат YYYY-MM.');
    }
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    const vf = readVendorFinance(tenant.settings);
    if (!vf.subscriptionEnabled) {
      throw new ConflictException(
        'Абонаментното таксуване е изключено за тази ферма (settings.vendorFinance.subscriptionEnabled).',
      );
    }

    const vendorRows: { id: string; subscriptionFeeStotinki: number | null }[] = await this.db
      .select({ id: farmers.id, subscriptionFeeStotinki: farmers.subscriptionFeeStotinki })
      .from(farmers)
      .where(eq(farmers.tenantId, tenantId));

    const rows = vendorRows
      .map((f) => ({
        tenantId,
        farmerId: f.id,
        period,
        feeStotinki: f.subscriptionFeeStotinki ?? vf.defaultSubscriptionFeeStotinki,
      }))
      .filter((r) => r.feeStotinki > 0);
    if (rows.length === 0) return { created: 0, skipped: vendorRows.length };

    // Idempotent: (farmer, period) unique index — re-running a month is a no-op.
    const inserted: { id: string }[] = await this.db
      .insert(vendorSubscriptionCharges)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: vendorSubscriptionCharges.id });

    return { created: inserted.length, skipped: vendorRows.length - inserted.length };
  }

  /** Charges for the tenant (optionally one month), newest period first. */
  async list(tenantId: string, period?: string): Promise<VendorChargeRow[]> {
    if (period && !PERIOD_RE.test(period)) {
      throw new BadRequestException('Невалиден период — очаква се формат YYYY-MM.');
    }
    const rows: Omit<VendorChargeRow, 'farmerName'>[] = await this.db
      .select({
        id: vendorSubscriptionCharges.id,
        farmerId: vendorSubscriptionCharges.farmerId,
        period: vendorSubscriptionCharges.period,
        feeStotinki: vendorSubscriptionCharges.feeStotinki,
        status: vendorSubscriptionCharges.status,
        paidAt: vendorSubscriptionCharges.paidAt,
        note: vendorSubscriptionCharges.note,
      })
      .from(vendorSubscriptionCharges)
      .where(
        and(
          eq(vendorSubscriptionCharges.tenantId, tenantId),
          ...(period ? [eq(vendorSubscriptionCharges.period, period)] : []),
        ),
      )
      .orderBy(desc(vendorSubscriptionCharges.period), desc(vendorSubscriptionCharges.createdAt));

    const farmerIds = [...new Set(rows.map((r) => r.farmerId).filter((v): v is string => !!v))];
    const nameById = new Map<string, string>();
    if (farmerIds.length > 0) {
      const names: { id: string; name: string }[] = await this.db
        .select({ id: farmers.id, name: farmers.name })
        .from(farmers)
        .where(inArray(farmers.id, farmerIds));
      for (const n of names) nameById.set(n.id, n.name);
    }
    return rows.map((r) => ({ ...r, farmerName: r.farmerId ? (nameById.get(r.farmerId) ?? null) : null }));
  }

  /** Owner bookkeeping: mark a charge paid / waived / back to due. */
  async setStatus(
    id: string,
    tenantId: string,
    status: 'due' | 'paid' | 'waived',
    note?: string,
  ): Promise<VendorChargeRow> {
    const [row] = await this.db
      .update(vendorSubscriptionCharges)
      .set({
        status,
        paidAt: status === 'paid' ? new Date() : null,
        ...(note !== undefined ? { note: note || null } : {}),
      })
      .where(
        and(eq(vendorSubscriptionCharges.id, id), eq(vendorSubscriptionCharges.tenantId, tenantId)),
      )
      .returning({
        id: vendorSubscriptionCharges.id,
        farmerId: vendorSubscriptionCharges.farmerId,
        period: vendorSubscriptionCharges.period,
        feeStotinki: vendorSubscriptionCharges.feeStotinki,
        status: vendorSubscriptionCharges.status,
        paidAt: vendorSubscriptionCharges.paidAt,
        note: vendorSubscriptionCharges.note,
      });
    if (!row) throw new NotFoundException('Таксата не е намерена');
    return { ...row, farmerName: null };
  }
}
