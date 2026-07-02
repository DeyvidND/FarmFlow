import type { Metadata } from 'next';
import Script from 'next/script';
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
  title: 'ФермериБГ — Управление на фермата',
  description: 'ФермериБГ — управление на поръчки и доставки за ферми.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg" className={`${commissioner.variable} ${bitter.variable}`}>
      <head>
        {/* Apply the „Едър текст" preference before first paint — a pure
            display preference (no cross-device sync needed), so localStorage
            is enough; the CSS override lives in globals.css. */}
        <Script id="a11y-init" strategy="beforeInteractive">
          {`try { if (localStorage.getItem('ff_a11y_large') === '1') document.documentElement.setAttribute('data-a11y-large', '1'); } catch (e) {}`}
        </Script>
      </head>
      <body>{children}</body>
    </html>
  );
}
