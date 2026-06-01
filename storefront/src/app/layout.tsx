import type { Metadata } from 'next';
import {
  Lora,
  Commissioner,
  Onest,
  Cormorant_Garamond,
  Mulish,
} from 'next/font/google';
import { DEFAULT_THEME, NO_FLASH_THEME_SCRIPT } from '@/lib/theme';
import { ThemeBar } from '@/components/theme-bar';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { Toaster } from '@/components/toast';
import { StoreHydrator } from '@/components/store-hydrator';
import './globals.css';

// The five template fonts, self-hosted via next/font. Each exposes a CSS
// variable that globals.css feeds into the per-theme --font-head / --font-body.
const lora = Lora({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-lora',
  display: 'swap',
});
const commissioner = Commissioner({
  subsets: ['latin', 'cyrillic'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-commissioner',
  display: 'swap',
});
const onest = Onest({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-onest',
  display: 'swap',
});
const cormorant = Cormorant_Garamond({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
});
const mulish = Mulish({
  subsets: ['latin', 'cyrillic'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-mulish',
  display: 'swap',
});

const fontVars = [
  lora.variable,
  commissioner.variable,
  onest.variable,
  cormorant.variable,
  mulish.variable,
].join(' ');

export const metadata: Metadata = {
  title: 'FarmFlow',
  description: 'Свежи био плодове, брани сутрин и доставени до вратата ти.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="bg" data-theme={DEFAULT_THEME} className={fontVars} suppressHydrationWarning>
      <head>
        {/* No-flash: set data-theme from localStorage before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeBar />
        <SiteHeader />
        {children}
        <SiteFooter />
        <Toaster />
        <StoreHydrator />
      </body>
    </html>
  );
}
