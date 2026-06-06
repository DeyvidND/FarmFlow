'use client';

/**
 * Cart page body — React port of `cart.html`. Empty state, line items with qty
 * steppers + remove, and the summary with the free-shipping rule. Reads/writes
 * the persisted cart store; gated on hydration so the empty state never flashes
 * before localStorage is read. (Demo "зареди примерна количка" button dropped.)
 */
import Link from 'next/link';
import { useCart, selectSubtotal, useCartHydrated, type CartItem } from '@/lib/cart';
import { money } from '@/lib/api';
import { shippingFor, remainingForFreeShipping, DEFAULT_DELIVERY, type StorefrontDelivery } from '@/lib/shipping';
import { QtyStepper } from './qty-stepper';
import { Leaf } from './icons';

function LineItem({ item }: { item: CartItem }) {
  const setQty = useCart((s) => s.setQty);
  const remove = useCart((s) => s.remove);
  const meta = [item.weight, money(item.priceStotinki)].filter(Boolean).join(' · ');

  return (
    <div className="line-item" data-product>
      <div className="ph">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt={item.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span className="ph__label" style={{ fontSize: 9 }}>
            {item.name}
          </span>
        )}
      </div>
      <div>
        <div
          style={{
            fontFamily: 'var(--font-head)',
            fontSize: 19,
            fontWeight: 'var(--h-weight)' as unknown as number,
          }}
        >
          {item.name}
        </div>
        <div className="muted" style={{ fontSize: 13.5 }}>
          {meta}
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 10 }}>
          <QtyStepper value={item.qty} onChange={(n) => setQty(item.productId, n)} />
          <button
            type="button"
            onClick={() => remove(item.productId)}
            style={{
              color: 'var(--muted)',
              fontSize: 13.5,
              textDecoration: 'underline',
            }}
          >
            Премахни
          </button>
        </div>
      </div>
      <div className="li-price" style={{ fontWeight: 700, fontSize: 18 }}>
        {money(item.priceStotinki * item.qty)}
      </div>
    </div>
  );
}

export function CartClient({ delivery = DEFAULT_DELIVERY }: { delivery?: StorefrontDelivery }) {
  const hydrated = useCartHydrated();
  const items = useCart((s) => s.items);
  const subtotal = useCart(selectSubtotal);

  if (!hydrated) {
    return <p className="muted">Зареждане…</p>;
  }

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <div className="ph">
          <span className="ph__label">
            празна
            <br />
            количка
          </span>
        </div>
        <h2 style={{ fontSize: 28, marginBottom: 10 }}>Количката е празна</h2>
        <p className="muted" style={{ marginBottom: 24 }}>
          Разгледай свежата реколта и добави любимите си плодове.
        </p>
        <Link href="/products" className="btn btn--primary">
          Към продуктите
        </Link>
      </div>
    );
  }

  const ship = shippingFor(subtotal, 'address', delivery);
  const remaining = remainingForFreeShipping(subtotal, delivery);

  return (
    <div className="commerce-grid">
      <div>
        <div>
          {items.map((it) => (
            <LineItem key={it.productId} item={it} />
          ))}
        </div>
        <div style={{ marginTop: 18 }}>
          <Link href="/products" className="btn btn--ghost btn--sm">
            ← Продължи пазаруването
          </Link>
        </div>
      </div>

      <aside className="summary">
        <h3 style={{ fontSize: 22, marginBottom: 14 }}>Резюме</h3>
        <div className="summary__row">
          <span>Междинна сума</span>
          <span>{money(subtotal)}</span>
        </div>
        <div className="summary__row">
          <span>Доставка</span>
          <span>{ship === 0 ? 'безплатна' : money(ship)}</span>
        </div>
        {ship > 0 && (
          <div className="muted" style={{ fontSize: 13 }}>
            Добави за {money(remaining)} за безплатна доставка
          </div>
        )}
        <div className="summary__row total">
          <span>Общо</span>
          <span>{money(subtotal + ship)}</span>
        </div>
        <Link
          href="/checkout"
          className="btn btn--primary btn--full btn--lg"
          style={{ marginTop: 16 }}
        >
          Към касата
        </Link>
        <div
          className="note-fresh"
          style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
        >
          <Leaf /> Берем в деня на доставката
        </div>
      </aside>
    </div>
  );
}
