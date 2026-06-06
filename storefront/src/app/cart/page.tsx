import type { Metadata } from 'next';
import Link from 'next/link';
import { getStorefront, resolveSlug } from '@/lib/api';
import { DEFAULT_DELIVERY } from '@/lib/shipping';
import { CartClient } from '@/components/cart-client';

export const metadata: Metadata = { title: 'Количка' };

export default async function CartPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  // Load the farm's own delivery fees so the cart estimate matches the charge.
  const profile = await getStorefront(resolveSlug(searchParams?.slug)).catch(() => null);
  const delivery = profile?.delivery ?? DEFAULT_DELIVERY;

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
          <CartClient delivery={delivery} />
        </div>
      </section>
    </main>
  );
}
