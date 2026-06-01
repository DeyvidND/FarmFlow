import Link from 'next/link';

/**
 * Temporary home placeholder. The full hero/home lands in a later feature; for
 * now it just routes into the live catalog (S2).
 */
export default function HomePage() {
  return (
    <main className="wrap section center">
      <span className="eyebrow">FarmFlow storefront</span>
      <h1 style={{ marginTop: 14 }}>Магазинът се изгражда.</h1>
      <p
        className="lead"
        style={{ marginTop: 16, maxWidth: '48ch', marginInline: 'auto' }}
      >
        Каталогът е на линия. Разгледай продуктите ни.
      </p>
      <div className="cta-row" style={{ justifyContent: 'center', marginTop: 28 }}>
        <Link href="/products" className="btn btn--primary btn--lg">
          Към продуктите
        </Link>
      </div>
    </main>
  );
}
