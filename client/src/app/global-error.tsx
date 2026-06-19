'use client';

// Root error boundary — catches errors that escape the React tree (including the
// root layout) and reports them to Sentry. Next renders this only in production
// when an error bubbles to the very top.
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="bg">
      <body
        style={{
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ marginBottom: 8 }}>Нещо се обърка.</h2>
          <p style={{ color: '#666' }}>Опитайте да презаредите страницата.</p>
        </div>
      </body>
    </html>
  );
}
