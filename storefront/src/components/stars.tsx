import { Star } from './icons';

/** Row of 5 stars; the first `value` are filled (reuses the template's `.stars`). */
export function Stars({ value, size = 18 }: { value: number; size?: number }) {
  return (
    <span className="stars" style={{ display: 'inline-flex', gap: 3, color: 'var(--accent)' }}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          style={{ opacity: i < value ? 1 : 0.25, width: size, height: size, display: 'inline-flex' }}
        >
          <Star style={{ width: size, height: size }} />
        </span>
      ))}
    </span>
  );
}
