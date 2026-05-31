/** Slot pill palette by fill ratio (pages2.jsx slotColor): full=gray, ≥80%=amber, else green. */
export function slotColor(booked: number, cap: number): { bg: string; ink: string; bar: string } {
  if (booked >= cap) {
    return { bg: 'var(--ff-gray-badge-bg)', ink: 'var(--ff-gray-badge-ink)', bar: 'var(--ff-muted-2)' };
  }
  if (cap > 0 && booked / cap >= 0.8) {
    return { bg: 'var(--ff-amber-softer)', ink: 'var(--ff-amber-600)', bar: 'var(--ff-amber)' };
  }
  return { bg: 'var(--ff-green-50)', ink: 'var(--ff-green-700)', bar: 'var(--ff-green-500)' };
}
