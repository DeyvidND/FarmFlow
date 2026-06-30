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
import {
  money,
  createCheckout,
  resolveSlug,
  ApiError,
  type DeliveryType,
  type DeliveryMethods,
} from '@/lib/api';
import { shippingFor, type StorefrontDelivery } from '@/lib/shipping';
import { SlotPicker } from '@/components/slot-picker';
import { AddressFields, composeGeocodeLine, type AddressParts } from '@/components/address-fields';
import { toast } from '@/components/toast';

export function CheckoutClient({
  deliveryEnabled,
  delivery,
  codEnabled,
  stripeEnabled,
  econtMode,
  methods,
}: {
  deliveryEnabled: boolean;
  delivery: StorefrontDelivery;
  codEnabled: boolean;
  stripeEnabled: boolean;
  econtMode: 'off' | 'manual' | 'auto';
  methods: DeliveryMethods;
}) {
  // Show a method only when the farm switched it on. Self-delivery needs the
  // master toggle too; Econt's visible variant depends on the mode (office in
  // auto, address in manual).
  const showSelf = deliveryEnabled && methods.ownSlots;
  const showEcont =
    (econtMode === 'manual' && methods.econtAddress) ||
    (econtMode === 'auto' && methods.econtOffice);
  const showPickup = methods.pickup;
  const router = useRouter();
  const slug = resolveSlug();
  const items = useCart((s) => s.items);
  const subtotal = useCart(selectSubtotal);
  const clear = useCart((s) => s.clear);
  const hydrated = useCartHydrated();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  // Start on self-delivery when it's offered, else Econt, else pickup.
  const [deliveryType, setDeliveryType] = useState<DeliveryType>(
    showSelf ? 'address' : showEcont ? 'econt' : showPickup ? 'pickup' : 'address',
  );
  const [addressInput, setAddressInput] = useState('');
  // Structured parts of the farm-delivery address (from AddressFields) — lets us send
  // the block/entrance as `deliveryNote` and the city/postcode on their own fields,
  // instead of folding everything into the geocoded `deliveryAddress` string.
  const [addressParts, setAddressParts] = useState<AddressParts | null>(null);
  // Structured settlement for Econt door (econt_address) — the courier needs a
  // city to route the waybill; the server requires it for door delivery.
  const [cityInput, setCityInput] = useState('');
  // Precise pin coordinates from the address autocomplete/map (address delivery only).
  const [addressLat, setAddressLat] = useState<number | null>(null);
  const [addressLng, setAddressLng] = useState<number | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  // Card only when the farm has Stripe; COD when offered. Default to card if
  // available, else COD. At least one is always present (COD defaults on).
  const [paymentMethod, setPaymentMethod] = useState<'online' | 'cod'>(
    stripeEnabled ? 'online' : 'cod',
  );
  const showPaymentChoice = stripeEnabled && codEnabled;
  const [hasSlots, setHasSlots] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isEcont = deliveryType === 'econt';
  const isPickup = deliveryType === 'pickup';
  // Manual Econt has no API office picker: the customer gives an address and the
  // farm ships it by hand, so the order goes out as `econt_address`. Auto mode
  // uses the office method (`econt`).
  const manualEcont = econtMode === 'manual';
  const sentDeliveryType: DeliveryType = isPickup
    ? 'pickup'
    : isEcont
      ? (manualEcont ? 'econt_address' : 'econt')
      : 'address';
  const shipping = shippingFor(subtotal, sentDeliveryType, delivery);
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
    if (sentDeliveryType === 'econt_address' && !cityInput.trim()) {
      toast('Моля, попълни град за доставка с Еконт');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createCheckout(slug, {
        items: items.map((it) => ({ productId: it.productId, quantity: it.qty })),
        customerName: name.trim(),
        customerPhone: phone.trim(),
        customerEmail: email.trim() || undefined,
        slotId: isPickup ? undefined : (slotId ?? undefined),
        deliveryType: sentDeliveryType,
        // Manual Econt + self-delivery carry an address; auto Econt carries an office.
        // Farm self-delivery sends the geocoder-clean line (street+town, no block) so the
        // pin doesn't snap to a wrong point; the block/entrance rides on deliveryNote.
        deliveryAddress: isPickup
          ? undefined
          : !isEcont && addressParts
            ? composeGeocodeLine(addressParts) || undefined
            : (!isEcont || manualEcont ? addressInput.trim() || undefined : undefined),
        deliveryNote:
          !isPickup && !isEcont && addressParts?.extra.trim() ? addressParts.extra.trim() : undefined,
        deliveryCity:
          sentDeliveryType === 'econt_address' ? cityInput.trim() || undefined : undefined,
        deliveryLat: isPickup || isEcont ? undefined : addressLat ?? undefined,
        deliveryLng: isPickup || isEcont ? undefined : addressLng ?? undefined,
        econtOffice: isEcont && !manualEcont ? addressInput.trim() || undefined : undefined,
        paymentMethod,
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
                  {showSelf && (
                    <label
                      className={`radio-card${deliveryType === 'address' ? ' is-active' : ''}`}
                      onClick={() => setDeliveryType('address')}
                    >
                      <span className="dot"></span>
                      <span>
                        <b>Доставка до адрес</b>
                        <br />
                        <span className="muted" style={{ fontSize: 14 }}>
                          {delivery.addressFeeStotinki > 0
                            ? `Куриер до врата · ${money(delivery.addressFeeStotinki)}${
                                delivery.freeThresholdStotinki > 0
                                  ? ` · безплатна над ${money(delivery.freeThresholdStotinki)}`
                                  : ''
                              }`
                            : 'Куриер до врата · безплатна'}
                        </span>
                      </span>
                    </label>
                  )}
                  {showEcont && (
                    <label
                      className={`radio-card${isEcont ? ' is-active' : ''}`}
                      onClick={() => setDeliveryType('econt')}
                    >
                      <span className="dot"></span>
                      <span>
                        <b>{manualEcont ? 'Доставка с Еконт' : 'Еконт офис'}</b>
                        <br />
                        <span className="muted" style={{ fontSize: 14 }}>
                          {manualEcont
                            ? `Еконт до твоя адрес · ${money(delivery.econtAddressFeeStotinki)}`
                            : `Вземане от офис на Еконт · ${money(delivery.econtFeeStotinki)}`}
                        </span>
                      </span>
                    </label>
                  )}
                  {showPickup && (
                    <label
                      className={`radio-card${deliveryType === 'pickup' ? ' is-active' : ''}`}
                      onClick={() => setDeliveryType('pickup')}
                    >
                      <span className="dot"></span>
                      <span>
                        <b>Вземане от място</b>
                        <br />
                        <span className="muted" style={{ fontSize: 14 }}>
                          Вземаш поръчката от фермата · безплатно
                        </span>
                      </span>
                    </label>
                  )}
                  {!showSelf && !showEcont && !showPickup && (
                    <p className="muted" style={{ fontSize: 14 }}>
                      Фермата не предлага доставка в момента. Свържи се с нас за уговорка.
                    </p>
                  )}
                </div>
                {isEcont ? (
                  manualEcont ? (
                    <div style={{ marginTop: 14 }}>
                      <div className="field">
                        <label>Град / населено място</label>
                        <input
                          className="input"
                          placeholder="напр. Варна"
                          value={cityInput}
                          onChange={(e) => setCityInput(e.target.value)}
                        />
                      </div>
                      <div className="field" style={{ marginTop: 10 }}>
                        <label>Адрес (улица, №)</label>
                        <input
                          className="input"
                          placeholder="ул. Иван Вазов 5"
                          value={addressInput}
                          onChange={(e) => setAddressInput(e.target.value)}
                        />
                        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                          Еконт доставя до най-близкия офис до твоя адрес.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="field" style={{ marginTop: 14 }}>
                      <label>Избери офис на Еконт</label>
                      <input
                        className="input"
                        placeholder="напр. Еконт Варна Център"
                        value={addressInput}
                        onChange={(e) => setAddressInput(e.target.value)}
                      />
                    </div>
                  )
                ) : (
                  !isPickup && (
                    <div style={{ marginTop: 14 }}>
                      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
                        Адрес за доставка
                      </label>
                      <AddressFields
                        onChange={(text, parts) => {
                          setAddressInput(text);
                          setAddressParts(parts);
                          // Structured text → server geocodes (region+town disambiguate).
                          setAddressLat(null);
                          setAddressLng(null);
                        }}
                      />
                    </div>
                  )
                )}
              </div>

              {/* payment method */}
              <div className="card" style={{ padding: 24, boxShadow: 'none' }}>
                <h3 style={{ fontSize: 20, marginBottom: 16 }}>Начин на плащане</h3>
                {showPaymentChoice ? (
                  <div className="stack" style={{ gap: 12 }}>
                    <label
                      className={`radio-card${paymentMethod === 'online' ? ' is-active' : ''}`}
                      onClick={() => setPaymentMethod('online')}
                    >
                      <span className="dot"></span>
                      <span>
                        <b>Карта (онлайн)</b>
                        <br />
                        <span className="muted" style={{ fontSize: 14 }}>
                          Плащаш сигурно с карта сега
                        </span>
                      </span>
                    </label>
                    <label
                      className={`radio-card${paymentMethod === 'cod' ? ' is-active' : ''}`}
                      onClick={() => setPaymentMethod('cod')}
                    >
                      <span className="dot"></span>
                      <span>
                        <b>Наложен платеж</b>
                        <br />
                        <span className="muted" style={{ fontSize: 14 }}>
                          Плащаш при получаване (напр. в офис на Еконт)
                        </span>
                      </span>
                    </label>
                  </div>
                ) : (
                  <p className="muted" style={{ fontSize: 14 }}>
                    {paymentMethod === 'online'
                      ? 'Плащане с карта (онлайн) при завършване на поръчката.'
                      : 'Плащане при получаване (наложен платеж).'}
                  </p>
                )}
              </div>

              {/* delivery slot — only for personal delivery, when the farm offers slots */}
              {showSelf && !isEcont && !isPickup && hasSlots !== false && (
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
