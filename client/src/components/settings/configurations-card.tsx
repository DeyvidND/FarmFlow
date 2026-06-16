'use client';

import {
  SlidersHorizontal, Truck, CalendarDays, ToggleRight, Megaphone, ChevronRight,
  type LucideIcon,
} from 'lucide-react';

/** The configuration sub-screens, opened inline inside Настройки. */
export type ConfigKey = 'setup' | 'delivery' | 'slots' | 'features' | 'marketing';

interface ConfigItem {
  key: ConfigKey;
  label: string;
  Icon: LucideIcon;
  desc: string;
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
      { key: 'delivery', label: 'Доставка', Icon: Truck, desc: 'Куриер Еконт и зони на доставка.' },
      { key: 'slots', label: 'Часове за доставка', Icon: CalendarDays, desc: 'Часове и дни за лична доставка, които клиентът избира.' },
    ],
  },
  {
    title: 'Функции на магазина',
    desc: 'Кои части от сайта да се показват.',
    items: [
      { key: 'features', label: 'Функции на магазина', Icon: ToggleRight, desc: 'Включи или изключи цели страници — фермери, отзиви, статии, категории.' },
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
  return (
    <div className="flex flex-col gap-7">
      <p className="text-[13.5px] text-ff-ink-2">
        Тук активираш и настройваш магазина — плащане, доставка, функции и реклама.
      </p>
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h2 className="text-[15px] font-extrabold text-ff-ink">{g.title}</h2>
          <p className="mb-3 mt-0.5 text-[13px] text-ff-muted">{g.desc}</p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {g.items.map((it) => (
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
      ))}
    </div>
  );
}
