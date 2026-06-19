'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Rocket, Settings, ListChecks, HelpCircle, ArrowRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { StoreReadiness } from './store-readiness-card';

const SEEN_KEY = 'ff:onboarding-seen';

/**
 * First-run welcome for the shop owner. Sits one layer below the blocking
 * password modal (z-90 < z-100), so it appears once that's done. Owner-only by
 * placement — producers (role='farmer') never reach the dashboard.
 *
 * Purpose: orient a brand-new farmer before the shop can sell. The star message
 * is "all settings live in Настройки"; it then points at the Табло readiness
 * checklist (the running what's-left tracker) and the per-screen Помощ buttons.
 * Dismissable, shown once (localStorage), and never shown once the shop is ready.
 */
export function OnboardingModal({ readiness }: { readiness: StoreReadiness }) {
  const done = [
    readiness.hasProducts,
    readiness.hasPayment,
    readiness.hasDelivery,
    readiness.hasContact,
  ].filter(Boolean).length;

  // The primary button does the next productive thing, not "go look at settings".
  const firstTodo = !readiness.hasProducts
    ? { href: '/products', label: 'Добави първия продукт' }
    : !readiness.hasPayment
      ? { href: '/settings?config=setup', label: 'Настрой плащане' }
      : !readiness.hasDelivery
        ? { href: '/settings?config=setup', label: 'Настрой доставка' }
        : { href: '/contacts', label: 'Попълни контакти' };

  const [show, setShow] = useState(false);

  useEffect(() => {
    if (done === 4) return; // shop already live — nothing to onboard
    try {
      if (localStorage.getItem(SEEN_KEY) !== '1') setShow(true);
    } catch {
      setShow(true); // localStorage blocked → still show the one-time welcome
    }
  }, [done]);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* private mode / quota — it just may show again next visit */
    }
    setShow(false);
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]">
      <div className="animate-ff-pop max-h-[94vh] w-[480px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
        <div className="flex items-start gap-3 border-b border-ff-border-2 px-7 pb-5 pt-6">
          <span className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
            <Rocket size={23} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">
              Добре дошъл
            </div>
            <h2 className="font-display text-[20px] font-extrabold tracking-[-0.015em] text-ff-ink">
              Ето как да пуснеш магазина
            </h2>
          </div>
          <button
            onClick={dismiss}
            aria-label="Затвори"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-3.5 px-7 pb-7 pt-5">
          <p className="text-[14px] leading-relaxed text-ff-ink-2">
            Само няколко неща, преди клиентите да могат да поръчват.
          </p>

          {/* Star message: where everything is configured. */}
          <div className="rounded-xl border border-ff-green-100 bg-ff-green-50 p-4">
            <div className="flex items-start gap-2.5">
              <Settings size={18} className="mt-0.5 shrink-0 text-ff-green-700" />
              <div>
                <div className="text-[14px] font-extrabold text-ff-ink">
                  Всичко се настройва от „Настройки → Конфигурации“
                </div>
                <div className="mt-0.5 text-[13px] leading-relaxed text-ff-ink-2">
                  Плащане, доставка, функции на магазина и реклама — всичко е на едно място там.
                </div>
              </div>
            </div>
          </div>

          {/* Pointer: the running readiness checklist on Табло. */}
          <div className="flex items-start gap-2.5 rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-3">
            <ListChecks size={18} className="mt-0.5 shrink-0 text-ff-green-700" />
            <div className="text-[13px] leading-relaxed text-ff-ink-2">
              На <b>Табло</b> следи списъка <b>„Готовност на магазина“</b> ({done}/4 готови) — показва
              какво още липсва: продукти, плащане, доставка, контакти.
            </div>
          </div>

          {/* Pointer: per-screen help. */}
          <div className="flex items-start gap-2.5 rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-3">
            <HelpCircle size={18} className="mt-0.5 shrink-0 text-ff-green-700" />
            <div className="text-[13px] leading-relaxed text-ff-ink-2">
              На всеки екран горе има бутон <b>„Помощ“ / „Обяснения“</b> с кратки упътвания.
            </div>
          </div>

          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={dismiss} className="rounded-sm">
              Разбрах
            </Button>
            <Button asChild variant="primary" className="w-full rounded-sm sm:w-auto">
              <Link href={firstTodo.href} onClick={dismiss}>
                {firstTodo.label} <ArrowRight size={16} />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
