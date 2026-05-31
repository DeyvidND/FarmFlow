/** Stock pill label + color, mirroring pages2.jsx stockMeta. */
export function stockMeta(stock: number | null): { label: string; color: string } {
  if (stock === null) return { label: 'В наличност', color: 'var(--ff-green-700)' };
  if (stock === 0) return { label: 'Изчерпан', color: 'var(--ff-muted)' };
  if (stock <= 6) return { label: `Ниска наличност · ${stock}`, color: 'var(--ff-amber-600)' };
  return { label: `В наличност · ${stock}`, color: 'var(--ff-green-700)' };
}
