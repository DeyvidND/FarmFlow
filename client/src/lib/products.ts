/** Stock pill label + color, driven by the product's «Задай наличност» count.
 *  `remaining` null/undefined = no stock set → unlimited (always available). */
export function availabilityMeta(remaining: number | null | undefined): { label: string; color: string } {
  if (remaining == null) return { label: 'В наличност', color: 'var(--ff-green-700)' };
  if (remaining === 0) return { label: 'Изчерпан', color: 'var(--ff-muted)' };
  if (remaining <= 6) return { label: `Ниска наличност · ${remaining}`, color: 'var(--ff-amber-600)' };
  return { label: `В наличност · ${remaining}`, color: 'var(--ff-green-700)' };
}
