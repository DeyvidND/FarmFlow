'use client';

import Link from 'next/link';
import { Check, Circle, Rocket, ArrowRight } from 'lucide-react';

export interface StoreReadiness {
  hasProducts: boolean;
  hasPayment: boolean;
  hasDelivery: boolean;
  hasContact: boolean;
}

const STEPS: { key: keyof StoreReadiness; label: string; href: string; cta: string }[] = [
  { key: 'hasProducts', label: 'Добави продукти в магазина', href: '/products', cta: 'Продукти' },
  { key: 'hasPayment', label: 'Включи начин на плащане (наложен платеж или карта)', href: '/setup', cta: 'Плащане' },
  { key: 'hasDelivery', label: 'Избери начин на доставка', href: '/setup', cta: 'Доставка' },
  { key: 'hasContact', label: 'Попълни контакти (телефон / адрес)', href: '/contacts', cta: 'Контакти' },
];

/**
 * First-run guide on the dashboard: the few steps a farmer must do to actually
 * sell. Each signal is derived from real data, so a step ticks itself off once
 * done — and the whole card disappears when the shop is ready. No dismiss state.
 */
export function StoreReadinessCard({ readiness }: { readiness: StoreReadiness }) {
  const done = STEPS.filter((s) => readiness[s.key]).length;
  if (done === STEPS.length) return null; // shop ready — stop nagging

  return (
    <div className="mb-5 rounded-2xl border border-ff-green-200 bg-ff-green-50/70 p-5 shadow-ff-sm">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
          <Rocket size={18} />
        </span>
        <div>
          <h2 className="text-[15px] font-extrabold text-ff-ink">Готовност на магазина</h2>
          <p className="text-[12.5px] text-ff-ink-2">
            Свърши тези стъпки, за да започнеш да продаваш. ({done}/{STEPS.length})
          </p>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {STEPS.map((s) => {
          const ok = readiness[s.key];
          return (
            <li
              key={s.key}
              className="flex items-center justify-between gap-3 rounded-lg bg-ff-surface px-3 py-2.5"
            >
              <span className="flex items-center gap-2.5 text-[13.5px]">
                {ok ? (
                  <Check size={17} className="shrink-0 text-ff-green-700" />
                ) : (
                  <Circle size={17} className="shrink-0 text-ff-muted-2" />
                )}
                <span className={ok ? 'font-semibold text-ff-muted line-through' : 'font-bold text-ff-ink'}>
                  {s.label}
                </span>
              </span>
              {!ok && (
                <Link
                  href={s.href}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-ff-green-700 px-3 py-1.5 text-[12.5px] font-bold text-white hover:bg-ff-green-800"
                >
                  {s.cta} <ArrowRight size={14} />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
