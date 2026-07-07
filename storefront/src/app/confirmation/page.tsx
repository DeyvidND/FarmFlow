'use client';

/**
 * Order confirmation — React port of `confirmation.html`, wired to the public
 * API. Reads `?order=<id>` (from `window.location`, so the route stays static
 * without a Suspense boundary), fetches the real recap, and clears the cart on
 * success. Server-fetched by id, so a refresh still shows the order.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getOrder,
  resolveSlug,
  money,
  ApiError,
  type PublicOrderSummary,
} from '@/lib/api';
import { useCart } from '@/lib/cart';
import { Check, Leaf, Truck } from '@/components/icons';

const MONTHS = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
const WEEKDAYS_FULL = [
  'понеделник',
  'вторник',
  'сряда',
  'четвъртък',
  'петък',
  'събота',
  'неделя',
];

function formatSlotDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** Day name for a `YYYY-MM-DD` slot date, parsed as UTC so it lines up with
 *  how the picker built its pills. */
function formatSlotWeekday(iso: string): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  return WEEKDAYS_FULL[(dt.getUTCDay() + 6) % 7];
}

/** Slot label for the confirmation recap. Day-rows (post migration 0081) carry
 *  no time window (`startTime`/`endTime` come back empty) — show the day name
 *  + date. Legacy orders that still have real `HH:MM` times keep the old
 *  `date, start–end` format so they don't look broken. */
function formatSlotLabel(slot: { date: string; startTime: string; endTime: string }): string {
  if (slot.startTime && slot.endTime) {
    return `${formatSlotDate(slot.date)}, ${slot.startTime}–${slot.endTime}`;
  }
  return `${formatSlotWeekday(slot.date)}, ${formatSlotDate(slot.date)}`;
}

type Phase = 'loading' | 'ok' | 'notfound';

export default function ConfirmationPage() {
  const clear = useCart((s) => s.clear);
  const [phase, setPhase] = useState<Phase>('loading');
  const [order, setOrder] = useState<PublicOrderSummary | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('order');
    if (!id) {
      setPhase('notfound');
      return;
    }
    let alive = true;
    getOrder(resolveSlug(), id)
      .then((o) => {
        if (!alive) return;
        setOrder(o);
        setPhase('ok');
        clear(); // successful order → empty the cart
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setPhase('notfound');
        else setPhase('notfound');
      });
    return () => {
      alive = false;
    };
  }, [clear]);

  return (
    <main data-screen-label="Order confirmation">
      <section className="section">
        <div className="wrap" style={{ maxWidth: 760 }}>
          <div className="center">
            <div
              style={{
                width: 88,
                height: 88,
                borderRadius: '50%',
                background: 'var(--primary)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 22px',
              }}
            >
              <Check style={{ width: 40, height: 40 }} />
            </div>

            {phase === 'ok' && order && (
              <span className="eyebrow">Поръчка #{order.id.slice(0, 8).toUpperCase()}</span>
            )}
            <h1 style={{ fontSize: 'clamp(32px,5vw,52px)', margin: '10px 0 14px' }}>
              {phase === 'notfound'
                ? 'Благодарим за поръчката!'
                : 'Благодарим! Поръчката е приета 🍓'}
            </h1>
            <p className="lead">
              {phase === 'notfound'
                ? 'Ще се свържем с теб за потвърждение на детайлите.'
                : 'Изпратихме потвърждение на имейла ти. Ще се чуем по телефона, ако се наложи да уточним нещо.'}
            </p>
          </div>

          {phase === 'loading' && (
            <p className="muted center" style={{ marginTop: 28 }}>
              Зареждане на поръчката…
            </p>
          )}

          {phase === 'ok' && order && (
            <div className="card" style={{ padding: 28, marginTop: 32 }}>
              <div className="split" style={{ gap: 24, alignItems: 'flex-start' }}>
                <div>
                  <h4
                    style={{
                      textTransform: 'uppercase',
                      letterSpacing: '.1em',
                      fontSize: 12.5,
                      color: 'var(--muted)',
                      marginBottom: 8,
                    }}
                  >
                    Доставка
                  </h4>
                  <div style={{ fontWeight: 600 }}>
                    {order.deliveryType === 'econt' ? 'Еконт офис' : 'Доставка до адрес'}
                  </div>
                  <div className="muted">
                    {order.deliveryType === 'econt'
                      ? order.econtOffice ?? '—'
                      : order.deliveryAddress ?? '—'}
                  </div>
                  {order.slot && (
                    <div className="note-fresh" style={{ marginTop: 12 }}>
                      <Truck /> {formatSlotLabel(order.slot)}
                    </div>
                  )}
                </div>
                <div>
                  <h4
                    style={{
                      textTransform: 'uppercase',
                      letterSpacing: '.1em',
                      fontSize: 12.5,
                      color: 'var(--muted)',
                      marginBottom: 8,
                    }}
                  >
                    Поръчано
                  </h4>
                  <div>
                    {order.items.map((it, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 16,
                          fontSize: 14.5,
                          padding: '3px 0',
                        }}
                      >
                        <span>
                          {it.name} × {it.quantity}
                        </span>
                        <span>{money(it.priceStotinki * it.quantity)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <hr className="divider" style={{ margin: '20px 0' }} />
              <div className="summary__row total" style={{ border: 0, padding: 0 }}>
                <span>{order.paidAt ? 'Платено' : 'Общо'}</span>
                <span>{money(order.totalStotinki)}</span>
              </div>
            </div>
          )}

          {/* next steps */}
          <div className="grid grid--3" style={{ marginTop: 28 }}>
            <div className="card value-card">
              <div className="ic">
                <Check />
              </div>
              <h3 style={{ fontSize: 18 }}>Потвърждение</h3>
              <p style={{ fontSize: 14.5 }}>Получаваш имейл с детайлите веднага.</p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Leaf />
              </div>
              <h3 style={{ fontSize: 18 }}>Берем сутринта</h3>
              <p style={{ fontSize: 14.5 }}>Плодовете се берат в деня на доставка.</p>
            </div>
            <div className="card value-card">
              <div className="ic">
                <Truck />
              </div>
              <h3 style={{ fontSize: 18 }}>На път към теб</h3>
              <p style={{ fontSize: 14.5 }}>Куриерът звъни преди да пристигне.</p>
            </div>
          </div>

          <div
            className="center"
            style={{ marginTop: 32, display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}
          >
            <Link href="/products" className="btn btn--primary">
              Поръчай отново
            </Link>
            <Link href="/" className="btn btn--ghost">
              Към началото
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
