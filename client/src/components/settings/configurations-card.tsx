'use client';

import * as React from 'react';
import {
  SlidersHorizontal, Truck, CalendarDays, ToggleRight, Megaphone, ChevronRight,
  TrendingUp, Home,
  type LucideIcon,
} from 'lucide-react';
import { getTenant } from '@/lib/api-client';

/** The configuration sub-screens, opened inline inside Настройки. */
export type ConfigKey =
  | 'setup'
  | 'delivery'
  | 'slots'
  | 'features'
  | 'merchandising'
  | 'landing'
  | 'marketing';

interface ConfigItem {
  key: ConfigKey;
  label: string;
  Icon: LucideIcon;
  desc: string;
  /** Only relevant when the farm does personal delivery — hidden otherwise. */
  requiresDelivery?: boolean;
}

// All set-up-once configuration lives here so it stays out of the everyday
// sidebar. Each tile opens its screen as a sub-section of Настройки (so the
// settings context + a back button stay), not a whole separate page.
const GROUPS: { title: string; desc: string; items: ConfigItem[] }[] = [
  {
    title: 'Плащане и доставка',
    desc: 'Как клиентът плаща и получава поръчката.',
    items: [
      { key: 'setup', label: 'Методи и цени', Icon: SlidersHorizontal, desc: 'Активирай наложен платеж или плащане с карта и задай цени на доставката.' },
      { key: 'delivery', label: 'Цени и правила', Icon: Truck, desc: 'Цени на методите за доставка, работно време и избор между Еконт/Speedy.' },
      { key: 'slots', label: 'Часове за доставка', Icon: CalendarDays, desc: 'Часове и дни за лична доставка, които клиентът избира.', requiresDelivery: true },
    ],
  },
  {
    title: 'Функции на магазина',
    desc: 'Кои части от сайта да се показват.',
    items: [
      { key: 'features', label: 'Функции на магазина', Icon: ToggleRight, desc: 'Включи или изключи цели страници — фермери, отзиви, статии, категории.' },
      { key: 'merchandising', label: 'Най-продавани и препоръки', Icon: TrendingUp, desc: 'Бутон „Най-продавани“ в магазина и блок „Често купувано заедно“ в количката.' },
      { key: 'landing', label: 'Начална страница', Icon: Home, desc: 'Избери кои блокове (категории, фермери, най-актуални, отзиви) да се показват на началната страница и колко.' },
    ],
  },
  {
    title: 'Маркетинг',
    desc: 'Реклама и проследяване.',
    items: [
      { key: 'marketing', label: 'Маркетинг и проследяване', Icon: Megaphone, desc: 'Кодове за Google Analytics, Google Ads, Meta Pixel и др.' },
    ],
  },
];

export function ConfigurationsCard({ onOpen }: { onOpen: (key: ConfigKey) => void }) {
  // Personal-delivery flag — when off, the «Часове за доставка» tile is useless
  // (the farm doesn't run delivery slots), so it's hidden until delivery is on.
  // Default true so the tile isn't flashed away before the tenant loads.
  const [deliveryEnabled, setDeliveryEnabled] = React.useState(true);
  React.useEffect(() => {
    let on = true;
    getTenant()
      .then((t) => on && setDeliveryEnabled(!!t.deliveryEnabled))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-7">
      <p className="text-[13.5px] text-ff-ink-2">
        Тук активираш и настройваш магазина — плащане, доставка, функции и реклама.
        Текстовете, снимките и контактите на сайта се променят от „Съдържание и сайт“ в менюто вляво.
      </p>
      {GROUPS.map((g) => {
        const items = g.items.filter((it) => !it.requiresDelivery || deliveryEnabled);
        if (items.length === 0) return null;
        return (
        <section key={g.title}>
          <h2 className="text-[15px] font-extrabold text-ff-ink">{g.title}</h2>
          <p className="mb-3 mt-0.5 text-[13px] text-ff-muted">{g.desc}</p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                onClick={() => onOpen(it.key)}
                className="group flex items-start gap-3 rounded-xl border border-ff-border bg-ff-surface p-4 text-left shadow-ff-sm transition hover:border-ff-green-500 hover:bg-ff-green-50"
              >
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ff-green-50 text-ff-green-700 transition group-hover:bg-ff-green-100">
                  <it.Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-[14px] font-bold text-ff-ink">
                    {it.label}
                    <ChevronRight size={15} className="text-ff-muted-2 transition group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-ff-muted">
                    {it.desc}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
        );
      })}
    </div>
  );
}
