import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE, telHref } from '@/lib/site';
import { Truck, Heart, Leaf, Facebook, Instagram, TikTok } from '@/components/icons';
import { ContactForm } from '@/components/contact-form';

export const metadata: Metadata = { title: 'Контакти' };

const iconBox = {
  width: 44,
  height: 44,
  borderRadius: 'var(--radius-sm)',
  display: 'grid',
  placeItems: 'center',
  background: 'var(--primary-050)',
  color: 'var(--primary)',
  flex: 'none' as const,
};

export default function ContactPage() {
  return (
    <main data-screen-label="Contact">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <span>Контакти</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap">
          <div className="section-head">
            <span className="eyebrow">Контакти</span>
            <h2 style={{ marginTop: 8 }}>Ще се радваме да чуем</h2>
            <p>
              Въпрос за поръчка, идея за пакет или просто здравей — пиши ни по
              който начин ти е удобен.
            </p>
          </div>

          <div className="split" style={{ marginTop: 30, alignItems: 'flex-start' }}>
            {/* contact info */}
            <div className="stack" style={{ gap: 18 }}>
              <div className="grid grid--2" style={{ gap: 14 }}>
                <a
                  href={telHref(SITE.phone)}
                  className="card"
                  style={{ padding: 20, display: 'flex', gap: 14, alignItems: 'center' }}
                >
                  <span style={iconBox}>
                    <Truck style={{ width: 22, height: 22 }} />
                  </span>
                  <span>
                    <span className="muted" style={{ fontSize: 13 }}>
                      Телефон / Viber
                    </span>
                    <br />
                    <b>{SITE.phone}</b>
                  </span>
                </a>
                <a
                  href={`mailto:${SITE.email}`}
                  className="card"
                  style={{ padding: 20, display: 'flex', gap: 14, alignItems: 'center' }}
                >
                  <span style={iconBox}>
                    <Heart style={{ width: 22, height: 22 }} />
                  </span>
                  <span>
                    <span className="muted" style={{ fontSize: 13 }}>
                      Имейл
                    </span>
                    <br />
                    <b>{SITE.email}</b>
                  </span>
                </a>
              </div>

              <div
                className="card"
                style={{ padding: 20, display: 'flex', gap: 14, alignItems: 'center' }}
              >
                <span style={iconBox}>
                  <Leaf style={{ width: 22, height: 22 }} />
                </span>
                <span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    Адрес
                  </span>
                  <br />
                  <b>{SITE.city}</b> · {SITE.hours}
                </span>
              </div>

              <div className="ph ph--rounded" style={{ aspectRatio: '16 / 10' }}>
                <span className="ph__label">Карта · {SITE.city} · Google Maps</span>
              </div>

              <div>
                <div className="muted" style={{ fontSize: 13.5, marginBottom: 10 }}>
                  Последвай ни
                </div>
                <div className="socials" style={{ margin: 0 }}>
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
            </div>

            {/* message form */}
            <div className="card" style={{ padding: 'clamp(22px,3vw,34px)' }}>
              <h3 style={{ fontSize: 24, marginBottom: 6 }}>Изпрати съобщение</h3>
              <p className="muted" style={{ marginBottom: 22 }}>
                Отговаряме в рамките на работния ден.
              </p>
              <ContactForm />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
