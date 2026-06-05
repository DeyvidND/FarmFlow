'use client';

import { useState } from 'react';
import { Receipt, CreditCard, Settings2, AlertTriangle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { moneyFromStotinki } from '@/lib/utils';
import {
  startBillingCheckout,
  openBillingPortal,
  type BillingSummary,
} from '@/lib/api-client';

/** Whole days from now until an ISO date (min 0). */
function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * Farmer-facing SaaS subscription status: the platform's €30/mo + €2/broadcast
 * plan charged to this farm (distinct from the Connect order-payments card below
 * it). Premium farms see the free state.
 */
export function SubscriptionCard({ summary }: { summary: BillingSummary }) {
  const [busy, setBusy] = useState<null | 'checkout' | 'portal'>(null);

  async function go(kind: 'checkout' | 'portal') {
    setBusy(kind);
    try {
      const { url } = kind === 'checkout' ? await startBillingCheckout() : await openBillingPortal();
      if (url) window.location.href = url;
      else setBusy(null);
    } catch {
      setBusy(null);
    }
  }

  // Premium is free regardless of whether Stripe billing is live — check it first.
  if (summary.plan === 'premium') {
    return (
      <Section>
        <div className="flex items-center gap-3.5 rounded-xl border border-ff-green-100 bg-ff-green-50 px-4 py-3.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ff-green-100 text-ff-green-700">
            <Sparkles size={18} />
          </span>
          <div>
            <div className="text-[14.5px] font-extrabold text-ff-green-800">Премиум — безплатно</div>
            <div className="text-[12.5px] font-semibold text-ff-green-700">
              Нямаш абонаментна такса. Бюлетините също са безплатни.
            </div>
          </div>
        </div>
      </Section>
    );
  }

  // Platform billing isn't configured — say so plainly, don't pretend it's free.
  if (!summary.enabled) {
    return (
      <Section>
        <div className="text-[13.5px] text-ff-muted">
          Абонаментът не е активиран от платформата.
        </div>
      </Section>
    );
  }

  const graceDays = summary.graceUntil ? daysUntil(summary.graceUntil) : 0;

  return (
    <Section>
      {/* status row */}
      {summary.status === 'inactive' ? (
        <Banner tone="danger" title="Абонаментът е спрян">
          Плати, за да възстановиш достъпа до производство, маршрут, слотове и статии.
        </Banner>
      ) : summary.status === 'past_due' ? (
        <Banner tone="warn" title={`Просрочено плащане — спира след ${graceDays} ${graceDays === 1 ? 'ден' : 'дни'}`}>
          Обнови картата си, за да не спре магазинът.
        </Banner>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border border-ff-green-100 bg-ff-green-50 px-4 py-3">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-ff-green-600 shadow-[0_0_0_4px_rgba(56,112,64,0.18)]" />
          <div className="text-[13.5px] font-extrabold text-ff-green-800">Активен абонамент</div>
        </div>
      )}

      {/* plan + estimate */}
      <div className="mt-4 rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
        <div className="text-[15px] font-extrabold">
          Стандартен план — {moneyFromStotinki(summary.basePriceStotinki)}/мес
        </div>
        <div className="mt-0.5 text-[12.5px] text-ff-muted">
          + {moneyFromStotinki(summary.emailPriceStotinki)} на изпратен бюлетин
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl border border-ff-border-2 bg-ff-surface-2 px-4 py-3">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.03em] text-ff-muted">
              Следваща сметка (прибл.)
            </div>
            <div className="ff-fig mt-0.5 text-[18px] font-extrabold">
              {moneyFromStotinki(summary.estimatedNextStotinki)}
            </div>
          </div>
          {summary.hasCard ? (
            <div className="text-right text-[12.5px] font-semibold text-ff-ink-2">
              {summary.cardBrand?.toUpperCase()} •••• {summary.cardLast4}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ff-amber-600">
              <AlertTriangle size={14} /> Няма карта
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2.5">
          {summary.hasCard ? (
            <Button
              variant="outline"
              onClick={() => go('portal')}
              disabled={busy !== null}
              className="rounded-sm px-4 py-2.5 text-[13.5px]"
            >
              <Settings2 size={16} /> {busy === 'portal' ? 'Отваряне…' : 'Управление на плащането'}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => go('checkout')}
              disabled={busy !== null}
              className="rounded-sm px-4 py-2.5 text-[13.5px]"
            >
              <CreditCard size={16} /> {busy === 'checkout' ? 'Зареждане…' : 'Добави карта'}
            </Button>
          )}
        </div>
      </div>

      <p className="mt-3 text-center text-[12px] text-ff-muted">
        0% комисиона върху поръчките — таксуваме само абонамента.
      </p>
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold text-ff-ink-2">
        <Receipt size={16} className="text-ff-green-700" /> Абонамент за FarmFlow
      </div>
      {children}
    </div>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'danger';
  title: string;
  children: React.ReactNode;
}) {
  const danger = tone === 'danger';
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-4 py-3.5 ${
        danger ? 'border-ff-red' : 'border-ff-amber-soft bg-ff-amber-softer'
      }`}
      style={danger ? { background: 'rgba(191,68,52,0.07)' } : undefined}
    >
      <AlertTriangle size={18} className={`mt-px shrink-0 ${danger ? 'text-ff-red' : 'text-ff-amber-600'}`} />
      <div>
        <div className={`text-[13.5px] font-extrabold ${danger ? 'text-ff-red' : 'text-ff-amber-600'}`}>
          {title}
        </div>
        <div className="text-[12.5px] leading-[1.45] text-ff-ink-2">{children}</div>
      </div>
    </div>
  );
}
