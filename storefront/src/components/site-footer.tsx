/**
 * Site footer — React port of `buildFooter` (shop / info / contact columns).
 * Static, so it stays a server component.
 */
import Link from 'next/link';
import { Berry, Facebook, Instagram, TikTok } from './icons';
import { SITE, telHref, footerShop, footerInfo } from '@/lib/site';
import { NewsletterForm } from './newsletter-form';

export function SiteFooter({
  hasFarmers = false,
  articlesEnabled = true,
  reviewsEnabled = true,
}: {
  hasFarmers?: boolean;
  articlesEnabled?: boolean;
  reviewsEnabled?: boolean;
}) {
  const year = 2026;
  const flags = { articlesEnabled, reviewsEnabled };
  const shop = footerShop(hasFarmers, flags);
  const info = footerInfo(flags);
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div>
          <span className="brand">
            <span className="brand__mark">
              <Berry />
            </span>
            <span className="brand__name">{SITE.name}</span>
          </span>
          <p
            style={{
              marginTop: 14,
              opacity: 0.85,
              maxWidth: '30ch',
              fontSize: 15,
            }}
          >
            {SITE.blurb}
          </p>
          <div className="socials">
            <a href={SITE.socials.facebook} aria-label="Facebook">
              <Facebook />
            </a>
            <a href={SITE.socials.instagram} aria-label="Instagram">
              <Instagram />
            </a>
            <a href={SITE.socials.tiktok} aria-label="TikTok">
              <TikTok />
            </a>
          </div>
        </div>

        <div>
          <h4>Магазин</h4>
          <div className="footer-links">
            {shop.map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
          </div>
        </div>

        <div>
          <h4>Информация</h4>
          <div className="footer-links">
            {info.map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
          </div>
        </div>

        <div>
          <h4>Контакти</h4>
          <div className="footer-contact">
            <a href={telHref(SITE.phone)}>{SITE.phone}</a>
            <br />
            <a href={`mailto:${SITE.email}`}>{SITE.email}</a>
            <br />
            {SITE.city}
            <br />
            {SITE.hours}
          </div>
          <h4 style={{ marginTop: 22 }}>Бюлетин</h4>
          <p style={{ opacity: 0.85, fontSize: 14, marginTop: 2 }}>
            Сезонни оферти и новини от градината.
          </p>
          <NewsletterForm />
        </div>
      </div>

      <div className="wrap footer-bottom">
        <span>© {year} {SITE.name}. Всички права запазени.</span>
        <span>Шаблон FarmFlow</span>
      </div>
    </footer>
  );
}
