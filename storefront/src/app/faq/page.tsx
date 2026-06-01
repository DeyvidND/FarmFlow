import type { Metadata } from 'next';
import Link from 'next/link';
import { FaqAccordion } from '@/components/faq-accordion';

export const metadata: Metadata = { title: 'Често задавани въпроси' };

export default function FaqPage() {
  return (
    <main data-screen-label="FAQ">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <span>ЧЗВ</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap" style={{ maxWidth: 820 }}>
          <div className="section-head center" style={{ marginInline: 'auto' }}>
            <span className="eyebrow">Често задавани въпроси</span>
            <h2 style={{ marginTop: 8 }}>Каквото обикновено ни питат</h2>
            <p>
              Не намираш отговор?{' '}
              <Link href="/contact" style={{ color: 'var(--primary)', textDecoration: 'underline' }}>
                Пиши ни
              </Link>{' '}
              — отговаряме лично.
            </p>
          </div>

          <FaqAccordion />
        </div>
      </section>
    </main>
  );
}
