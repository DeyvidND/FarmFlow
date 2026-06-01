import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Страницата не е намерена' };

export default function NotFound() {
  return (
    <main data-screen-label="404">
      <section className="section">
        <div className="wrap center" style={{ maxWidth: 620 }}>
          <div
            className="ph"
            style={{ width: 150, height: 150, borderRadius: '50%', margin: '0 auto 18px' }}
          >
            <span className="ph__label" style={{ fontSize: 48 }}>
              🫐
            </span>
          </div>
          <div className="big-404">404</div>
          <h1 style={{ fontSize: 'clamp(26px,4vw,40px)', margin: '6px 0 12px' }}>
            Това плодче го няма
          </h1>
          <p className="lead">
            Страницата, която търсиш, е откъсната или преместена. Но реколтата те
            чака на началната страница.
          </p>
          <div
            style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 26 }}
          >
            <Link href="/" className="btn btn--primary btn--lg">
              Към началото
            </Link>
            <Link href="/products" className="btn btn--ghost btn--lg">
              Разгледай продуктите
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
