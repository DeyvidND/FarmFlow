import type { ConsolidatedCourierRecipient } from '@/lib/types';

/**
 * §4.4 "Прати на куриерите" — pure display/summary helpers for the recipient
 * confirm dialog. Kept out of the component (which vitest here cannot render —
 * node env only, no jsdom/RTL) so the actual decision logic is unit-tested
 * directly, same idiom as `legLabel` in consolidated-protocol-client.tsx.
 */

/** One line in the confirm dialog: "Лег N — email", or an explicit
 *  "няма имейл" flag for a courier the send will skip. */
export function courierRecipientLine(r: Pick<ConsolidatedCourierRecipient, 'name' | 'email'>): string {
  return r.email ? `${r.name} — ${r.email}` : `${r.name} — няма имейл (ще бъде пропуснат)`;
}

/** How many of the day's active couriers can actually receive a send —
 *  drives the confirm button's label/disabled state. */
export function sendableCourierCount(recipients: Pick<ConsolidatedCourierRecipient, 'email'>[]): number {
  return recipients.filter((r) => r.email).length;
}

/** Per-leg delivery badge for the dialog. Empty for a no-email courier (the
 *  line already flags "няма имейл"); otherwise the send state so the operator
 *  sees who already has their protocol before deciding to resend. */
export function courierStatusLabel(
  r: Pick<ConsolidatedCourierRecipient, 'email' | 'emailStatus'>,
): string {
  if (!r.email) return '';
  if (r.emailStatus === 'sent') return 'Изпратено';
  if (r.emailStatus === 'failed') return 'Неуспешно';
  return 'Непратено';
}

/** How many emailable couriers have NOT yet received their protocol (failed or
 *  never sent). Drives the „Прати на непратените" resend action's visibility and
 *  count — 0 means every courier with an email already has it. */
export function unsentCourierCount(
  recipients: Pick<ConsolidatedCourierRecipient, 'email' | 'emailStatus'>[],
): number {
  return recipients.filter((r) => r.email && r.emailStatus !== 'sent').length;
}

/** Post-send toast summary from the server's {sent, failed} report. */
export function sendResultSummary(report: { sent: unknown[]; failed: unknown[] }): string {
  const sentN = report.sent.length;
  const failedN = report.failed.length;
  const courierWord = sentN === 1 ? 'куриер' : 'куриери';
  if (failedN === 0) return `Изпратено на ${sentN} ${courierWord}.`;
  return `Изпратено на ${sentN}, неуспешно за ${failedN}.`;
}
