'use client';

/** Root error boundary — themed fallback for unexpected runtime/render errors. */
import Link from 'next/link';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main data-screen-label="Error">
      <section className="section">
        <div className="wrap center" style={{ maxWidth: 600 }}>
          <div className="big-404">⚠</div>
          <h1 style={{ fontSize: 'clamp(26px,4vw,40px)', margin: '6px 0 12px' }}>
            Нещо се обърка
          </h1>
          <p className="lead">
            Възникна неочаквана грешка. Опитай отново или се върни към началната
            страница.
          </p>
          <div
            style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 26 }}
          >
            <button type="button" className="btn btn--primary btn--lg" onClick={reset}>
              Опитай отново
            </button>
            <Link href="/" className="btn btn--ghost btn--lg">
              Към началото
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
