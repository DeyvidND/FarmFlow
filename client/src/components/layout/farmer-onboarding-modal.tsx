'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { UserCircle2, HelpCircle, X, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

const SEEN_KEY = 'ff:farmer-onboarding-seen';

/** First-run orientation for a farmer sub-account (role='farmer'). The owner's
 *  OnboardingModal never mounts for them (dashboard-gated, and farmers are
 *  bounced off /dashboard by FarmerRouteGuard) — without this a new farmer had
 *  zero explanation of the owner/farmer split. Dismissable, shown once
 *  (localStorage), same layer as the owner modal since the two are mutually
 *  exclusive by role. */
export function FarmerOnboardingModal() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(SEEN_KEY) !== '1') setShow(true);
    } catch {
      setShow(true); // localStorage blocked → still show the one-time welcome
    }
  }, []);

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
            <UserCircle2 size={23} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">
              Добре дошъл
            </div>
            <h2 className="font-display text-[20px] font-extrabold tracking-[-0.015em] text-ff-ink">
              Ето как работи твоят достъп
            </h2>
          </div>
          <button
            onClick={dismiss}
            aria-label="Затвори"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-3.5 px-7 pb-7 pt-5">
          <p className="text-[14px] leading-relaxed text-ff-ink-2">
            Това е <b>твоят личен акаунт</b> като фермер (производител) в тази ферма — виждаш само
            своята част от магазина.
          </p>

          <div className="rounded-xl border border-ff-green-100 bg-ff-green-50 p-4">
            <div className="text-[14px] font-extrabold text-ff-ink">Виждаш и управляваш:</div>
            <div className="mt-0.5 text-[13.5px] leading-relaxed text-ff-ink-2">
              Своите продукти и наличности, поръчките в които участваш, плащанията си и доставките с
              куриер.
            </div>
          </div>

          <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-3">
            <div className="text-[14px] font-extrabold text-ff-ink">Собственикът управлява:</div>
            <div className="mt-0.5 text-[13.5px] leading-relaxed text-ff-ink-2">
              Сайта и текстовете, контактите, методите и цените за доставка, куриерските акаунти.
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-3">
            <HelpCircle size={18} className="mt-0.5 shrink-0 text-ff-green-700" />
            <div className="text-[13px] leading-relaxed text-ff-ink-2">
              Виж <b>„Помощ“</b> в менюто вляво за кратко ръководство точно за твоите екрани.
            </div>
          </div>

          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={dismiss} className="rounded-sm">
              Разбрах
            </Button>
            <Button asChild variant="primary" className="w-full rounded-sm sm:w-auto">
              <Link href="/help" onClick={dismiss}>
                Виж помощта <ArrowRight size={16} />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
