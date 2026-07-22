import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { type Database, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PROTOCOL_EMAIL_QUEUE } from '../../common/queue/queue.constants';
import { HandoverService } from '../handover/handover.service';
import { EmailService } from '../../common/email/email.service';

export type SendProtocolEmailResult =
  | { ok: true; skipped?: 'no-email' | 'already-sent' }
  | { ok: false; error: string };

/** The one BullMQ job shape carried by PROTOCOL_EMAIL_QUEUE. */
export interface ProtocolEmailJobData {
  tenantId: string;
  orderId: string;
}

/**
 * The one place render → await-real-send → write-tracking-columns happens for
 * the customer's bilateral protocol. Deliberately does NOT touch orders.status
 * — every caller decides the flip itself:
 *  - OrdersService.updateStatus (Task 6, human path) calls `sendProtocolEmail`
 *    INLINE, awaits it, and flips status only on `ok: true` — the one path
 *    allowed to pay the latency (§4.3).
 *  - OrdersService.confirmPending (Task 7) and StripeService.markOrderPaid
 *    (Task 8) flip status per their own existing logic FIRST, then call
 *    `enqueueProtocolEmail` — fire a PROTOCOL_EMAIL_QUEUE job and return
 *    immediately. `OrderProtocolEmailProcessor` (below) is what eventually
 *    calls `sendProtocolEmail` for those two paths, off the request entirely.
 *  - OrdersService.resendProtocolEmail (Task 9, "прати пак") also just calls
 *    `enqueueProtocolEmail` again — idempotent via the `already-sent` check
 *    below.
 */
@Injectable()
export class OrderProtocolEmailService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly handover: HandoverService,
    private readonly email: EmailService,
    @InjectQueue(PROTOCOL_EMAIL_QUEUE) private readonly queue: Queue,
  ) {}

  async sendProtocolEmail(tenantId: string, orderId: string): Promise<SendProtocolEmailResult> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) return { ok: false, error: 'Поръчката не е намерена' };

    // Idempotent: a prior successful send (this attempt, a previous confirm
    // attempt, or an earlier queued job) must not re-render/re-send. The
    // caller still gets `ok: true` so any status flip it's gating proceeds.
    if (order.protocolEmailStatus === 'sent') {
      return { ok: true, skipped: 'already-sent' };
    }

    const to = order.customerEmail?.trim();
    if (!to) {
      // Nothing to email — not a failure. Mirrors the existing
      // OrderConfirmationService no-op-without-email convention.
      return { ok: true, skipped: 'no-email' };
    }

    const { id: protocolId } = await this.handover.ensureDraftTarget(tenantId, {
      kind: 'operator_to_customer',
      orderId,
    } as any);

    try {
      await this.email.sendMailNow({
        to,
        subject: `Разписка за поръчка №${order.orderNumber ?? ''}`.trim(),
        html: this.renderHtml(order),
        attachments: [{ kind: 'handover-protocol', protocolId, tenantId }],
        stream: 'transactional',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(orders)
        .set({ protocolEmailStatus: 'failed', protocolEmailAt: new Date(), protocolEmailError: message })
        .where(eq(orders.id, orderId));
      return { ok: false, error: message };
    }

    await this.db
      .update(orders)
      .set({ protocolEmailStatus: 'sent', protocolEmailAt: new Date(), protocolEmailError: null })
      .where(eq(orders.id, orderId));
    return { ok: true };
  }

  /**
   * Non-blocking counterpart to `sendProtocolEmail`, for the paths that flip
   * `orders.status` BEFORE the email outcome is known (bulk confirm-pending,
   * Stripe webhook, and the "прати пак" resend action) — per §4.3, only the
   * human confirm path (Task 6) is allowed to await the real send. Hands a
   * small `{tenantId, orderId}` descriptor to PROTOCOL_EMAIL_QUEUE;
   * `OrderProtocolEmailProcessor` picks it up and runs the SAME
   * `sendProtocolEmail` — so render/send/track logic exists in exactly one
   * place regardless of which path triggered it.
   */
  async enqueueProtocolEmail(tenantId: string, orderId: string): Promise<void> {
    const data: ProtocolEmailJobData = { tenantId, orderId };
    await this.queue.add('send-protocol-email', data);
  }

  /** Minimal transactional body — this is NOT the storefront thank-you email
   *  (OrderConfirmationService owns that, unchanged); it exists only to carry
   *  the attachment and explain what it is. Kept intentionally plain. */
  private renderHtml(order: { customerName: string | null; orderNumber: number | null }): string {
    const greeting = order.customerName ? `Здравей, ${order.customerName}!` : 'Здравей!';
    return `<!doctype html><html lang="bg"><body style="font-family:Arial,Helvetica,sans-serif">
<p>${greeting}</p>
<p>Прилагаме разписка за получена стока по поръчка №${order.orderNumber ?? ''}. Документът е
предварителен — подписва се при предаването на стоката.</p>
</body></html>`;
  }
}
