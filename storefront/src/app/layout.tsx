import type { Metadata } from 'next';
import {
  Lora,
  Commissioner,
  Onest,
  Cormorant_Garamond,
  Mulish,
} from 'next/font/google';
import { DEFAULT_THEME, NO_FLASH_THEME_SCRIPT } from '@/lib/theme';
import { SITE } from '@/lib/site';
import { getStorefront, resolveSlug } from '@/lib/api';
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

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3003';
const DESCRIPTION = 'Свежи био плодове, брани сутрин и доставени до вратата ти.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // Per-page `title: 'X'` renders as "X · <Farm>"; the home/default omits the suffix.
  title: {
    default: `${SITE.name} · Свежи био плодове`,
    template: `%s · ${SITE.name}`,
  },
  description: DESCRIPTION,
  applicationName: SITE.name,
  openGraph: {
    type: 'website',
    locale: 'bg_BG',
    siteName: SITE.name,
    title: `${SITE.name} · Свежи био плодове`,
    description: DESCRIPTION,
  },
  twitter: { card: 'summary_large_image' },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Chrome flags: multi-farmer surfaces the "Фермери" nav item; articles/reviews
  // gate the «Влог»/«Отзиви» nav items (and their sections). Missing → on.
  const profile = await getStorefront(resolveSlug()).catch(() => null);
  const hasFarmers = profile?.multiFarmer ?? false;
  const articlesEnabled = profile?.articlesEnabled ?? true;
  const reviewsEnabled = profile?.reviewsEnabled ?? true;

  return (
    <html lang="bg" data-theme={DEFAULT_THEME} className={fontVars} suppressHydrationWarning>
      <head>
        {/* No-flash: set data-theme from localStorage before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeBar />
        <SiteHeader
          hasFarmers={hasFarmers}
          articlesEnabled={articlesEnabled}
          reviewsEnabled={reviewsEnabled}
        />
        {children}
        <SiteFooter
          hasFarmers={hasFarmers}
          articlesEnabled={articlesEnabled}
          reviewsEnabled={reviewsEnabled}
        />
        <Toaster />
        <StoreHydrator />
      </body>
    </html>
  );
}
