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
  title: 'ФермериБГ · Доставка',
  description: 'ФермериБГ — масов внос и управление на пратки.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg" className={`${commissioner.variable} ${bitter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
