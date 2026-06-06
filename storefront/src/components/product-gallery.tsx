'use client';

/**
 * Product image gallery: a large cover plus clickable thumbnails that swap the
 * main image. Driven by the real ordered `images[]` from the public API (cover
 * first) — no placeholders. Falls back to a labelled placeholder when the
 * product has no photo.
 */
import { useState } from 'react';

export function ProductGallery({ images, name }: { images: string[]; name: string }) {
  const [active, setActive] = useState(0);
  const main = images[active];

  return (
    <div>
      <div className="ph ph--rounded" style={{ aspectRatio: '1' }}>
        {main ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={main}
            alt={name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span className="ph__label">{name}</span>
        )}
      </div>

      {images.length > 1 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4,1fr)',
            gap: 12,
            marginTop: 12,
          }}
        >
          {images.slice(0, 8).map((src, i) => (
            <button
              key={`${src}-${i}`}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`${name} — изглед ${i + 1}`}
              aria-pressed={i === active}
              className="ph ph--square"
              style={{
                aspectRatio: '1',
                padding: 0,
                overflow: 'hidden',
                cursor: 'pointer',
                borderRadius: 10,
                background: 'none',
                border: i === active ? '2px solid var(--primary, #2c5530)' : '1px solid var(--line, #e3dccb)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
