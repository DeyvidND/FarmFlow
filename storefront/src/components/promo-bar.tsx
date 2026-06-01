'use client';

/**
 * Dismissible promo strip — React port from app.js. Dismissal persists in
 * localStorage `ff_promo_closed`. Reads storage only after mount (not during
 * render) so SSR and the first client render agree.
 */
import { useEffect, useState } from 'react';
import { Close } from './icons';

const KEY = 'ff_promo_closed';

export function PromoBar() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(KEY) === '1') setHidden(true);
  }, []);

  const close = () => {
    setHidden(true);
    localStorage.setItem(KEY, '1');
  };

  return (
    <div className={`promo${hidden ? ' hide' : ''}`} id="promo">
      🍓 Специални отстъпки за <b>сезонните ни пакети</b>! Безплатна доставка над
      40,00 лв.
      <button
        className="promo__close"
        type="button"
        onClick={close}
        aria-label="Затвори"
      >
        <Close />
      </button>
    </div>
  );
}
