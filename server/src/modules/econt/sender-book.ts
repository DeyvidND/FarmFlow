/** A saved pickup point = the carrier's sender fields + id + label. Carrier-agnostic
 *  here (the sender fields differ per carrier; we only touch id/label generically). */
export type PickupPoint = Record<string, unknown> & { id: string; label: string };

/**
 * Read the pickup-point book off a carrier blob, migrating a legacy single `sender`
 * into a one-point book on the fly (no DB migration). Returns the list + the active id
 * (defaulting to the first point when the stored activeSenderId is missing/unknown).
 */
export function readSenderBook(
  blob: Record<string, unknown> | null | undefined,
): { senders: PickupPoint[]; activeId: string | null } {
  const b = (blob ?? {}) as Record<string, unknown>;
  const raw = b.senders;
  if (Array.isArray(raw) && raw.length) {
    const senders = raw as PickupPoint[];
    const stored = b.activeSenderId;
    const activeId =
      typeof stored === 'string' && senders.some((p) => p.id === stored) ? stored : senders[0].id;
    return { senders, activeId };
  }
  const sender = b.sender as Record<string, unknown> | undefined;
  if (sender && Object.keys(sender).length) {
    return { senders: [{ id: 'p1', label: 'Основна', ...sender }], activeId: 'p1' };
  }
  return { senders: [], activeId: null };
}

/**
 * Write the book onto a carrier blob and mirror the active point's sender fields into
 * `sender` (stripped of id/label) so the waybill builder — which reads `.sender` —
 * transparently uses the active point. Unknown activeId → first point; empty book →
 * cleared active sender. Never touches other blob keys (creds/handling/package/COD).
 */
export function applySenderBook(
  blob: Record<string, unknown>,
  senders: PickupPoint[],
  activeId: string,
): Record<string, unknown> {
  const active = senders.find((p) => p.id === activeId) ?? senders[0] ?? null;
  let sender: Record<string, unknown> = {};
  if (active) {
    const rest = { ...active } as Record<string, unknown>;
    delete rest.id;
    delete rest.label;
    sender = rest;
  }
  return { ...blob, senders, activeSenderId: active ? active.id : null, sender };
}
