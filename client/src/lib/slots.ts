/** Slot pill palette. A slot is free while booked < capacity (green), else full (gray). */
export function slotColor(booked: number, capacity: number): { bg: string; ink: string } {
  if (booked >= Math.max(1, capacity)) {
    return { bg: 'var(--ff-gray-badge-bg)', ink: 'var(--ff-gray-badge-ink)' };
  }
  return { bg: 'var(--ff-green-50)', ink: 'var(--ff-green-700)' };
}
