'use client';

/**
 * Storefront checkout (client island) — React port of `checkout.html`, wired to
 * the public API. Contact + delivery method + the live <SlotPicker> + order
 * summary. `deliveryEnabled` (from the storefront profile) gates **personal
 * delivery**: when the farm doesn't self-deliver, "Доставка до адрес" and the
 * slot picker disappear and only Еконт courier is offered. Submitting posts to
 * `/checkout`: with Stripe it redirects to the hosted page; for a cash farm it
 * lands on the confirmation page.
 */
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCart, selectSubtotal, useCartHydrated } from '@/lib/cart';
import { money, createCheckout, resolveSlug, ApiError, type DeliveryType } from '@/lib/api';
import { shippingFor } from '@/lib/shipping';
import { SlotPicker } from '@/components/slot-picker';
import { toast } from '@/components/toast';

export function CheckoutClient({ deliveryEnabled }: { deliveryEnabled: boolean }) {
  const router = useRouter();
  const slug = resolveSlug();
  const items = useCart((s) => s.items);
  const subtotal = useCart(selectSubtotal);
  const clear = useCart((s) => s.clear);
  const hydrated = useCartHydrated();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  // Personal delivery off → start on (and lock to) Еконт courier.
  const [deliveryType, setDeliveryType] = useState<DeliveryType>(
    deliveryEnabled ? 'address' : 'econt',
  );
  const [addressInput, setAddressInput] = useState('');
  const [slotId, setSlotId] = useState<string | null>(null);
  const [hasSlots, setHasSlots] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isEcont = deliveryType === 'econt';
  const shipping = shippingFor(subtotal, deliveryType);
  const total = subtotal + shipping;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!items.length) {
      toast('Количката е празна');
      return;
    }
    if (!name.trim() || !phone.trim()) {
      toast('Моля, попълни име и телефон');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createCheckout(slug, {
        items: items.map((it) => ({ productId: it.productId, quantity: it.qty })),
        customerName: name.trim(),
        customerPhone: phone.trim(),
        customerEmail: email.trim() || undefined,
        slotId: slotId ?? undefined,
        deliveryType,
        deliveryAddress: isEcont ? undefined : addressInput.trim() || undefined,
        econtOffice: isEcont ? addressInput.trim() || undefined : undefined,
      });
      if (res.checkoutUrl) {
        // Stripe-hosted payment — leave the cart intact until the webhook confirms.
        window.location.href = res.checkoutUrl;
        return;
      }
      // Cash farm: the order is placed (pending). Clear the cart and confirm.
      clear();
      router.push(`/confirmation?order=${res.orderId}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Възникна грешка. Опитайте отново.');
      setSubmitting(false);
    }
  };

  // Empty-cart guard (after hydration, so the empty state never flashes).
  if (hydrated && items.length === 0) {
    return (
      <main data-screen-label="Checkout">
        <div className="wrap">
          <nav className="breadcrumb">
            <Link href="/cart">Количка</Link> / <span>Каса</span>
          </nav>
        </div>
        <section className="section--tight">
          <div className="wrap">
            <h1 style={{ fontSize: 'clamp(28px,4vw,42px)', margin: '14px 0 12px' }}>Каса</h1>
            <p className="muted" style={{ marginBottom: 18 }}>
              Количката е празна — добави продукти, преди да продължиш към касата.
            </p>
            <Link href="/products" className="btn btn--primary">
              Към продуктите
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main data-screen-label="Checkout">
      <div className="wrap">
        <nav className="breadcrumb">
          <Link href="/cart">Количка</Link> / <span>Каса</span>
        </nav>
      </div>

      <section className="section--tight">
        <div className="wrap">
          <div className="steps">
            <span className="step done">
              <span className="num">1</span>Количка
            </span>
            <span className="sep"></span>
            <span className="step current">
              <span className="num">2</span>Доставка и плащане
            </span>
            <span className="sep"></span>
            <span className="step">
              <span className="num">3</span>Готово
            </span>
          </div>
          <h1 style={{ fontSize: 'clamp(28px,4vw,42px)', margin: '14px 0 24px' }}>
            Финализирай поръчката
          </h1>

          <form className="commerce-grid" onSubmit={submit}>
            <div className="stack" style={{ gap: 26 }}>
              {/* contact */}
              <div className="card" style={{ padding: 24, boxShadow: 'none' }}>
                <h3 style={{ fontSize: 20, marginBottom: 16 }}>Контакти</h3>
                <div className="stack" style={{ gap: 14 }}>
                  <div className="field">
                    <label>Име и фамилия</label>
                    <input
                      className="input"
                      placeholder="Иван Иванов"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label>Телефон</label>
                      <input
                        className="input"
                        type="tel"
                        placeholder="+359 88 ..."
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Имейл</label>
                      <input
                        className="input"
                        type="email"
                        placeholder="ime@example.bg"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* delivery method */}
              <div className="card" style={{ padding: 24, boxShadow: 'none' }}>
                <h3 style={{ fontSize: 20, marginBottom: 16 }}>Начин на доставка</h3>
                <div className="stack" style={{ gap: 12 }}>
                  {/* Personal (address) delivery — only when the farm self-delivers. */}
                  {deliveryEnabled && (
                    <label
                      className={`radio-card${!isEcont ? ' is-active' : ''}`}
                      onClick={() => setDeliveryType('address')}
                    >
                      <span className="dot"></span>
                      <span>
                        <b>Доставка до адрес</b>
                        <br />
                        <span className="muted" style={{ fontSize: 14 }}>
                          Куриер до врата · 4,90 лв · безплатна над 40 лв
                        </span>
                      </span>
                    </label>
                  )}
                  <label
                    className={`radio-card${isEcont ? ' is-active' : ''}`}
                    onClick={() => setDeliveryType('econt')}
                  >
                    <span className="dot"></span>
                    <span>
                      <b>Еконт офис</b>
                      <br />
                      <span className="muted" style={{ fontSize: 14 }}>
                        Вземане от офис на Еконт · 3,50 лв
                      </span>
                    </span>
                  </label>
                </div>
                <div className="field" style={{ marginTop: 14 }}>
                  <label>{isEcont ? 'Избери офис на Еконт' : 'Адрес за доставка'}</label>
                  <input
                    className="input"
                    placeholder={isEcont ? 'напр. Еконт Варна Център' : 'ул., №, град, пощенски код'}
                    value={addressInput}
                    onChange={(e) => setAddressInput(e.target.value)}
                  />
                </div>
              </div>

              {/* delivery slot — only for personal delivery, when the farm offers slots */}
              {deliveryEnabled && !isEcont && hasSlots !== false && (
                <div className="card" style={{ padding: 24, boxShadow: 'none' }}>
                  <h3 style={{ fontSize: 20, marginBottom: 6 }}>Часови слот за доставка</h3>
                  <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>
                    Избери удобен ден и час. Заетите слотове не се показват.
                  </p>
                  <SlotPicker
                    value={slotId}
                    onChange={(id) => setSlotId(id)}
                    onAvailabilityResolved={setHasSlots}
                  />
                </div>
              )}
            </div>

            {/* summary */}
            <aside className="summary">
              <h3 style={{ fontSize: 22, marginBottom: 14 }}>Твоята поръчка</h3>
              <div>
                {items.map((it) => (
                  <div className="summary__row" key={it.productId}>
                    <span>
                      {it.name} <span className="muted">× {it.qty}</span>
                    </span>
                    <span>{money(it.priceStotinki * it.qty)}</span>
                  </div>
                ))}
              </div>
              <div>
                <div
                  className="summary__row"
                  style={{ borderTop: '1px solid var(--line)', marginTop: 6, paddingTop: 12 }}
                >
                  <span>Доставка</span>
                  <span>{shipping === 0 ? 'безплатна' : money(shipping)}</span>
                </div>
                <div className="summary__row total">
                  <span>Общо</span>
                  <span>{money(total)}</span>
                </div>
              </div>
              <button
                className="btn btn--primary btn--full btn--lg"
                type="submit"
                style={{ marginTop: 16 }}
                disabled={submitting}
              >
                {submitting ? 'Обработка…' : 'Завърши поръчката'}
              </button>
              <p className="muted center" style={{ fontSize: 12.5, marginTop: 10 }}>
                С натискане приемаш Общите условия
              </p>
            </aside>
          </form>
        </div>
      </section>
    </main>
  );
}
