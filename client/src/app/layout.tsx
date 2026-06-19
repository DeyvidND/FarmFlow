import type { Metadata } from 'next';
import { Commissioner, Bitter } from 'next/font/google';
import './globals.css';

const commissioner = Commissioner({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-commissioner',
  display: 'swap',
});

const bitter = Bitter({
  subsets: ['latin', 'cyrillic'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-bitter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FarmFlow — Управление на фермата',
  description: 'FarmFlow — управление на поръчки и доставки за ферми.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Hand the runtime Sentry DSN (from Dokploy env, read server-side per request)
  // to the browser SDK in sentry.client.config.ts via an inline <head> script
  // that runs before the app bundle. Keeps the DSN in Dokploy only — never baked
  // into the image. NOTE: on statically-prerendered pages (login / forgot- &
  // reset-password) this is empty (no env at build); the whole authenticated,
  // server-rendered panel — the part that matters — gets it at request time.
  const sentryDsn = process.env.SENTRY_DSN;
  const sentryEnv = process.env.SENTRY_ENVIRONMENT || 'production';
  return (
    <html lang="bg" className={`${commissioner.variable} ${bitter.variable}`}>
      {sentryDsn ? (
        <head>
          <script
            dangerouslySetInnerHTML={{
              __html: `window.__SENTRY_DSN__=${JSON.stringify(
                sentryDsn,
              )};window.__SENTRY_ENV__=${JSON.stringify(sentryEnv)};`,
            }}
          />
        </head>
      ) : null}
      <body>{children}</body>
    </html>
  );
}
