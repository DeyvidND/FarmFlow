import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, eq, isNull, or } from 'drizzle-orm';
import { type Database, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PROTOCOL_EMAIL_QUEUE } from '../../common/queue/queue.constants';
import { HandoverService } from '../handover/handover.service';
import { OrderConfirmationService } from '../order-email/order-confirmation.service';
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
    private readonly orderConfirmation: OrderConfirmationService,
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

    // Fast path: already done. (Doesn't claim — pure read short-circuit for
    // the common case; the real dup-prevention guarantee is the atomic claim
    // below, which is what makes this safe under concurrent callers.)
    if (order.protocolEmailStatus === 'sent') {
      return { ok: true, skipped: 'already-sent' };
    }

    const to = order.customerEmail?.trim();
    if (!to) {
      // Nothing to email — not a failure, and we do NOT claim: there's
      // nothing in flight to make exclusive. Mirrors the existing
      // OrderConfirmationService no-op-without-email convention.
      return { ok: true, skipped: 'no-email' };
    }

    // Atomic exclusive claim: row is claimable ONLY from {NULL, 'failed'} →
    // 'sending'. This is the load-bearing correctness detail — it MUST be
    // `IS NULL OR = 'failed'`, not `<> 'sent'`: in SQL, `NULL <> 'sent'`
    // evaluates to NULL (not TRUE), so a first-ever send would never match
    // and could never claim; and `'sending' <> 'sent'` is TRUE, which would
    // let a second concurrent caller claim a row another worker already owns
    // — defeating exclusivity. Whichever caller's UPDATE returns a row owns
    // this send; every other concurrent caller gets zero rows back and skips.
    //
    // Known accepted tradeoff: if the process crashes between this claim and
    // the terminal write, the row is stranded at 'sending' forever (no
    // stale-reclaim timeout in this batch). Recoverable via a manual reset of
    // protocol_email_status to NULL/'failed'.
    const [claimed] = await this.db
      .update(orders)
      .set({ protocolEmailStatus: 'sending' })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.tenantId, tenantId),
          or(isNull(orders.protocolEmailStatus), eq(orders.protocolEmailStatus, 'failed')),
        ),
      )
      .returning({ id: orders.id });
    // No row back → another worker owns the send ('sending') or it flipped to
    // 'sent' between the read and the claim. Skip; the owner finishes the send.
    if (!claimed) {
      return { ok: true, skipped: 'already-sent' };
    }

    const { id: protocolId } = await this.handover.ensureDraftTarget(tenantId, {
      kind: 'operator_to_customer',
      orderId,
    } as any);

    try {
      // The buyer's ONE email per order (2026-07-23): the full "Получихме
      // поръчката ти" body (items, totals, delivery block) with the разписка
      // PDF attached — replaces the received + потвърдена + разписка triple.
      const built = await this.orderConfirmation.buildReceivedEmail(orderId);
      if (!built) throw new Error('Поръчката вече няма имейл или не е намерена');
      await this.email.sendMailNow({
        ...built,
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
    // Stable per-order jobId de-dupes concurrent enqueues (BullMQ refuses a
    // second add() with a jobId already active/waiting) — belt-and-braces
    // alongside the atomic claim in `sendProtocolEmail` itself.
    // removeOnFail frees the id once settled so a later "прати пак" resend
    // can re-enqueue after a failure.
    await this.queue.add('send-protocol-email', data, {
      jobId: `protocol-${orderId}`,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

}
