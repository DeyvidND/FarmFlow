import type { Metadata } from 'next';
import Link from 'next/link';
import { CartClient } from '@/components/cart-client';

export const metadata: Metadata = { title: 'Количка' };

export default function CartPage() {
  return (
    <main data-screen-label="Cart">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/">Начало</Link> / <span>Количка</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap">
          <h1 style={{ fontSize: 'clamp(30px,4.5vw,46px)', marginBottom: 24 }}>
            Твоята количка
          </h1>
          <CartClient />
        </div>
      </section>
    </main>
  );
}
