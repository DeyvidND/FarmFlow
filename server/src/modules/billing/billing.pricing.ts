/**
 * Newsletter per-recipient pricing. The rate is in MICRO-euros (1e-6 €) so the
 * sub-cent per-recipient figure stays integer; the per-send total is rounded to
 * whole stotinki (EUR cents). One helper for the quote AND the charge → the
 * quoted price can never drift from the billed price.
 *
 *   micro / 10_000 = stotinki   (1 stotinka = 1e-2 €, 1 micro = 1e-6 €)
 */
export function priceForRecipients(recipients: number, perRecipientMicro: number): number {
  if (recipients <= 0) return 0;
  return Math.round((recipients * perRecipientMicro) / 10_000);
}

/** Underlying Resend cost for `recipients`, in stotinki (margin view only). */
export function emailCostStotinki(recipients: number, costPerRecipientMicro: number): number {
  if (recipients <= 0) return 0;
  return Math.round((recipients * costPerRecipientMicro) / 10_000);
}
