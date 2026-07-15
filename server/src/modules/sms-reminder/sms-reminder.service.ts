import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { type Database, orders, deliverySlots, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { SmsService } from '../../common/sms/sms.service';
import { OrderConfirmationService } from '../order-email/order-confirmation.service';
import { parseSmsSettings } from '../tenants/sms-settings';
import { normalizePhone } from '../cod-risk/cod-risk.helpers';
import { scheduledForDay } from '../orders/order-scheduling';
import { bgToday } from '../../common/time/bg-time';

/** Reminder delivery channel. */
export type ReminderChannel = 'email' | 'sms';

/** 'HH:MM:SS' pg time → 'HH:MM'. */
const hhmm = (t: string | null): string => (t ?? '').slice(0, 5);

/** The Cyrillic day-of reminder body (SMS channel only). */
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
    private readonly orderEmail: OrderConfirmationService,
  ) {}

  /**
   * Tenants that opted into the day-of reminder, with each one's channel.
   * Channel defaults to 'email' (free) until the SMS gateway is wired.
   */
  async eligibleTenants(): Promise<Array<{ id: string; channel: ReminderChannel }>> {
    const rows = await this.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(sql`(${tenants.settings} #>> '{sms,dayOfReminder}') = 'true'`);
    return rows.map((r) => ({ id: r.id, channel: parseSmsSettings(r.settings).channel }));
  }

  /**
   * Remind every own-delivery customer of their approved window for `date`
   * (default today, Europe/Sofia) over `channel`. Claim-before-send on
   * delivery_window_sms_at makes this idempotent regardless of channel: a re-run
   * or concurrent worker never double-sends. Mirrors the email path
   * RoutingService.notifyDeliveryWindows.
   */
  async sendForTenant(
    tenantId: string,
    channel: ReminderChannel = 'email',
    date?: string,
  ): Promise<{ sent: number; skipped: number; failed: number; total: number; date: string }> {
    const day = date ?? bgToday();
    const rows = await this.db
      .select({
        id: orders.id,
        email: orders.customerEmail,
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
          // Approved OR already-emailed (sent): the morning reminder still fires.
          inArray(orders.deliveryWindowStatus, ['approved', 'sent']),
          isNotNull(orders.deliveryWindowStart),
          // Guard the END too: a null end would render "между 09:00– ч.".
          isNotNull(orders.deliveryWindowEnd),
          isNull(orders.deliveryWindowSmsAt),
          // Day-level opt-out lives on the slot row; a slotless order (NULL join,
          // no matching deliverySlots row) must still remind — hence isNull too,
          // not a bare eq(...,false) which NULL fails in SQL.
          or(isNull(deliverySlots.reminderOptOut), eq(deliverySlots.reminderOptOut, false)),
        ),
      );

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of rows) {
      // Contact gate depends on the channel — no valid contact → skip, no claim.
      if (channel === 'email') {
        if (!r.email?.trim()) {
          skipped += 1;
          continue;
        }
      } else if (!normalizePhone(r.phone)) {
        skipped += 1;
        continue;
      }
      // Atomic claim: only one runner sets sms_at (the channel-agnostic
      // reminder-sent marker) from NULL → now().
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
      // From the claim onward, any throw (DB error, a send error, or a violated
      // never-throws contract) must not abort the batch or strand a claimed row:
      // release the claim (tenant-scoped) and continue, counting failed.
      try {
        const ok = await this.dispatch(channel, r, day, tenantId);
        if (ok) {
          sent += 1;
        } else {
          await this.releaseClaim(r.id, tenantId);
          failed += 1;
        }
      } catch (err) {
        this.logger.warn(`sendForTenant: failed to remind order ${r.id}: ${err}`);
        await this.releaseClaim(r.id, tenantId);
        failed += 1;
        continue;
      }
    }
    return { sent, skipped, failed, total: rows.length, date: day };
  }

  /** Send one reminder over the channel. Returns false when a send is
   *  recoverable-failed (so the caller releases the claim to retry). Throws are
   *  handled the same way by the caller. */
  private async dispatch(
    channel: ReminderChannel,
    r: {
      id: string;
      email: string | null;
      phone: string | null;
      orderNumber: number | null;
      windowStart: string | null;
      windowEnd: string | null;
    },
    day: string,
    tenantId: string,
  ): Promise<boolean> {
    const start = hhmm(r.windowStart);
    const end = hhmm(r.windowEnd);
    if (channel === 'email') {
      // Throws on failure (caller releases + retries); resolves on success.
      await this.orderEmail.sendDeliveryWindowReminder(r.id, start, end, day);
      return true;
    }
    // SMS: sendSms normalizes internally + records the sms_log row, so we
    // forward the raw phone. It never throws — signals failure via status.
    const res = await this.sms.sendSms(r.phone as string, buildBody(r.orderNumber, start, end), {
      tenantId,
      orderId: r.id,
      kind: 'delivery_window',
    });
    return res.status === 'sent';
  }

  /** Release the reminder claim so a later run retries. Best-effort: a release
   *  error just leaves the claim set (no dup, at worst a missed retry). */
  private async releaseClaim(orderId: string, tenantId: string): Promise<void> {
    try {
      await this.db
        .update(orders)
        .set({ deliveryWindowSmsAt: null })
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
    } catch (releaseErr) {
      this.logger.error(`sendForTenant: claim release failed for order ${orderId}: ${releaseErr}`);
    }
  }
}
