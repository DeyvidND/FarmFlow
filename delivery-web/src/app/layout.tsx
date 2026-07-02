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
  title: 'ФермериБГ · Доставка',
  description: 'ФермериБГ — масов внос и управление на пратки.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg" className={`${commissioner.variable} ${bitter.variable}`}>
      <head>
        {/* Apply the „Едър текст" preference before first paint — see client
            app's layout.tsx for the same pattern; CSS override in globals.css. */}
        <Script id="a11y-init" strategy="beforeInteractive">
          {`try { if (localStorage.getItem('ff_a11y_large') === '1') document.documentElement.setAttribute('data-a11y-large', '1'); } catch (e) {}`}
        </Script>
      </head>
      <body>{children}</body>
    </html>
  );
}
