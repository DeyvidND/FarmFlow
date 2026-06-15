/** Slot pill palette. A slot holds one order → taken (booked) = gray, free = green. */
export function slotColor(booked: number): { bg: string; ink: string } {
  if (booked >= 1) {
    return { bg: 'var(--ff-gray-badge-bg)', ink: 'var(--ff-gray-badge-ink)' };
  }
  return { bg: 'var(--ff-green-50)', ink: 'var(--ff-green-700)' };
}
