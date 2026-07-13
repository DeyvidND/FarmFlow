import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type Database, orders, deliverySlots, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { SmsService } from '../../common/sms/sms.service';
import { normalizePhone } from '../cod-risk/cod-risk.helpers';
import { scheduledForDay } from '../orders/order-scheduling';
import { bgToday } from '../../common/time/bg-time';

/** 'HH:MM:SS' pg time → 'HH:MM'. */
const hhmm = (t: string | null): string => (t ?? '').slice(0, 5);

/** The Cyrillic day-of reminder body. */
export function buildBody(orderNumber: number | null, start: string, end: string): string {
  const n = orderNumber != null ? `#${orderNumber}` : '';
  return `ФермериБГ: доставка днес на поръчка ${n}, между ${start}–${end} ч.`.replace(
    'поръчка ,',
    'поръчка,',
  );
}

@Injectable()
export class SmsReminderService {
  private readonly logger = new Logger(SmsReminderService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly sms: SmsService,
  ) {}

  /** Tenants that opted into the day-of SMS reminder. */
  async eligibleTenantIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`(${tenants.settings} #>> '{sms,dayOfReminder}') = 'true'`);
    return rows.map((r) => r.id);
  }

  /**
   * SMS every own-delivery customer their approved window for `date` (default
   * today, Europe/Sofia). Claim-before-send on delivery_window_sms_at makes this
   * idempotent: a re-run or concurrent worker never double-sends. Mirrors the
   * email path RoutingService.notifyDeliveryWindows.
   */
  async sendForTenant(
    tenantId: string,
    date?: string,
  ): Promise<{ sent: number; skipped: number; failed: number; total: number; date: string }> {
    const day = date ?? bgToday();
    const rows = await this.db
      .select({
        id: orders.id,
        phone: orders.customerPhone,
        orderNumber: orders.orderNumber,
        windowStart: orders.deliveryWindowStart,
        windowEnd: orders.deliveryWindowEnd,
      })
      .from(orders)
      // scheduledForDay references deliverySlots.date — join per its contract.
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          eq(orders.deliveryType, 'address'),
          scheduledForDay(day),
          // Approved OR already-emailed (sent): the morning SMS still fires.
          inArray(orders.deliveryWindowStatus, ['approved', 'sent']),
          isNotNull(orders.deliveryWindowStart),
          isNull(orders.deliveryWindowSmsAt),
        ),
      );

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of rows) {
      // Validity gate only — SmsService.sendSms normalizes again internally
      // (and is what actually records the normalized number in sms_log), so
      // the raw phone is what we forward downstream.
      if (!normalizePhone(r.phone)) {
        skipped += 1;
        continue;
      }
      const phone = r.phone as string;
      // Atomic claim: only one runner sets sms_at from NULL → now().
      const [claimed] = await this.db
        .update(orders)
        .set({ deliveryWindowSmsAt: new Date() })
        .where(
          and(
            eq(orders.id, r.id),
            eq(orders.tenantId, tenantId),
            isNull(orders.deliveryWindowSmsAt),
          ),
        )
        .returning({ id: orders.id });
      if (!claimed) {
        skipped += 1;
        continue;
      }
      const body = buildBody(r.orderNumber, hhmm(r.windowStart), hhmm(r.windowEnd));
      const res = await this.sms.sendSms(phone, body, {
        tenantId,
        orderId: r.id,
        kind: 'delivery_window',
      });
      if (res.status === 'sent') {
        sent += 1;
      } else {
        // Release the claim so a later run retries — no dup (send failed).
        await this.db
          .update(orders)
          .set({ deliveryWindowSmsAt: null })
          .where(and(eq(orders.id, r.id), eq(orders.tenantId, tenantId)));
        failed += 1;
      }
    }
    return { sent, skipped, failed, total: rows.length, date: day };
  }
}
