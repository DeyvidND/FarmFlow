'use client';

import { type ReactNode, useState } from 'react';
import {
  CreditCard,
  ShieldCheck,
  Wallet,
  ExternalLink,
  AlertTriangle,
  ArrowUpRight,
  Banknote,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  moneyFromStotinki,
  BG_MONTHS,
  bgWeekdayShort,
  todayIso,
  shiftIsoDate,
  hhmm,
} from '@/lib/utils';
import {
  startStripeOnboarding,
  type StripeSummary,
  type CodPaymentsSummary,
  type CodPaymentDay,
  type CodPaymentOrder,
} from '@/lib/api-client';

/** The farmer's own full Stripe Dashboard (Standard accounts log in here directly). */
const STRIPE_DASHBOARD_URL = 'https://dashboard.stripe.com';

/** Format an ISO date as "9 юни" (Bulgarian, day + month). */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long' });
  } catch {
    return '';
  }
}

/** Map a Stripe charge status to a Bulgarian label + tone. */
function paymentStatus(status: string): { label: string; cls: string } {
  switch (status) {
    case 'succeeded':
      return { label: 'Платено', cls: 'bg-ff-green-100 text-ff-green-800' };
    case 'pending':
      return { label: 'Изчаква', cls: 'bg-ff-amber-softer text-ff-amber-600' };
    case 'failed':
      return { label: 'Неуспешно', cls: 'bg-ff-surface-2 text-ff-red' };
    default:
      return { label: status, cls: 'bg-ff-surface-2 text-ff-ink-2' };
  }
}

export function PaymentsClient({
  initial,
  cod,
}: {
  initial: StripeSummary;
  cod: CodPaymentsSummary;
}) {
  const summary = initial; // server-fetched; a navigation back from Stripe re-renders with fresh props
  const [busy, setBusy] = useState(false);

  /** Create/refresh the connected account and open Stripe's hosted onboarding in a new tab. */
  async function onboard() {
    setBusy(true);
    // Open the tab synchronously inside the click gesture so the browser doesn't
    // block it as a popup; the URL is filled once the async call returns. Detach
    // opener for safety. If the popup is blocked (tab === null), fall back to a
    // same-tab redirect.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const { url } = await startStripeOnboarding();
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch {
      tab?.close();
      toast.error('Неуспешна връзка със Stripe. Опитай пак.');
    } finally {
      setBusy(false);
    }
  }

  // COD (наложен платеж) sits on top — most farms collect cash on delivery, and a
  // COD-only farm (no Stripe) still gets a useful payments view. Card payments
  // (Stripe) follow as a second channel.
  return (
    <div className="max-w-[820px] animate-ff-fade-up">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Плащания</h1>
        <p className="text-[13.5px] text-ff-muted">
          Преглед на парите от поръчки — наложен платеж и картови плащания.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <CodSection cod={cod} />
        <StripeSection summary={summary} busy={busy} onboard={onboard} />
      </div>
    </div>
  );
}

/* ─────────────────────────────  COD (наложен платеж)  ───────────────────────────── */

const DELIVERY_LABEL: Record<string, string> = {
  pickup: 'На място',
  address: 'Доставка',
  econt: 'Еконт офис',
  econt_address: 'Еконт до адрес',
};

/** "YYYY-MM-DD" → "Днес" / "Вчера" / "Утре" / "Пет, 12 юни". */
function codDayLabel(iso: string): string {
  const today = todayIso();
  if (iso === today) return 'Днес';
  if (iso === shiftIsoDate(today, -1)) return 'Вчера';
  if (iso === shiftIsoDate(today, 1)) return 'Утре';
  const [, m, d] = iso.split('-');
  return `${bgWeekdayShort(iso)}, ${Number(d)} ${BG_MONTHS[Number(m) - 1]}`;
}

/** Short second line under a COD order: delivery method + slot time when set. */
function codMeta(o: CodPaymentOrder): string {
  const dt = DELIVERY_LABEL[o.deliveryType] ?? 'Доставка';
  return o.slotFrom ? `${dt} · ${hhmm(o.slotFrom)}` : dt;
}

function CodSection({ cod }: { cod: CodPaymentsSummary }) {
  return (
    <section className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
      <SectionHeader
        icon={<Banknote size={16} className="text-ff-green-700" />}
        title="Наложен платеж"
        hint="Пари в брой при доставка — групирани по ден."
        right={
          cod.count > 0 ? (
            <div className="text-right">
              <div className="ff-fig text-[18px] font-extrabold text-ff-green-800">
                {moneyFromStotinki(cod.totalStotinki)}
              </div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.03em] text-ff-muted">
                {cod.count} {cod.count === 1 ? 'поръчка' : 'поръчки'}
              </div>
            </div>
          ) : undefined
        }
      />
      {cod.count === 0 ? (
        <div className="mt-4 text-[13.5px] text-ff-muted">
          Още няма плащания с наложен платеж.
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          {cod.days.map((d) => (
            <CodDayBlock key={d.day} day={d} />
          ))}
        </div>
      )}
    </section>
  );
}

function CodDayBlock({ day }: { day: CodPaymentDay }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between border-b border-ff-border-2 pb-1.5">
        <span className="text-[12.5px] font-extrabold capitalize text-ff-ink">
          {codDayLabel(day.day)}
        </span>
        <span className="ff-fig text-[13px] font-extrabold text-ff-green-800">
          {moneyFromStotinki(day.totalStotinki)}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-ff-border-2">
        {day.orders.map((o) => (
          <CodRow key={o.id} o={o} />
        ))}
      </ul>
    </div>
  );
}

function CodRow({ o }: { o: CodPaymentOrder }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold text-ff-ink">
          {o.orderNumber ? `#${o.orderNumber}` : 'Поръчка'}
          {o.customerName ? ` · ${o.customerName}` : ''}
        </div>
        <div className="text-[11.5px] text-ff-muted">{codMeta(o)}</div>
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-extrabold ${
          o.collected ? 'bg-ff-green-100 text-ff-green-800' : 'bg-ff-amber-softer text-ff-amber-600'
        }`}
      >
        {o.collected ? 'Получено' : 'Очаквано'}
      </span>
      <div className="ff-fig w-[84px] shrink-0 text-right text-[14px] font-extrabold">
        {moneyFromStotinki(o.totalStotinki)}
      </div>
    </li>
  );
}

/* ─────────────────────────────  Card payments (Stripe)  ───────────────────────────── */

function StripeSection({
  summary,
  busy,
  onboard,
}: {
  summary: StripeSummary;
  busy: boolean;
  onboard: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        icon={<CreditCard size={16} className="text-ff-green-700" />}
        title="Картови плащания"
        hint="Плащане с карта онлайн — парите идват по банковата ти сметка."
      />
      {/* Platform hasn't enabled card payments (no Stripe secret key on the server). */}
      {!summary.enabled ? (
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 text-[14px] leading-[1.55] text-ff-ink-2 shadow-ff-sm">
          Картовите плащания още не са активирани от платформата. Свържи се с поддръжката, за да ги
          включим за твоята ферма.
        </div>
      ) : !summary.connected ? (
        // Not connected yet — explainer CTA. No Stripe account is created until the
        // farmer clicks "Свържи Stripe".
        <ConnectCta busy={busy} onStart={onboard} />
      ) : !summary.chargesEnabled ? (
        // Connected but onboarding isn't finished — Stripe still wants details.
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2.5 rounded-2xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3.5">
            <AlertTriangle size={18} className="mt-px shrink-0 text-ff-amber-600" />
            <div>
              <div className="text-[13.5px] font-extrabold text-ff-amber-600">Почти готово</div>
              <div className="text-[12.5px] leading-[1.45] text-ff-ink-2">
                Stripe иска още няколко данни (банкова сметка / документ), за да активира плащанията.
              </div>
            </div>
          </div>
          <Button
            variant="primary"
            onClick={onboard}
            disabled={busy}
            className="self-start rounded-sm px-6 py-3 text-[15px]"
          >
            <CreditCard size={18} /> {busy ? 'Отваряне…' : 'Довърши регистрацията'}
          </Button>
        </div>
      ) : (
        // Fully connected — native FarmFlow dashboard.
        <StripeDashboard summary={summary} />
      )}
    </section>
  );
}

function StripeDashboard({ summary }: { summary: StripeSummary }) {
  return (
    <div className="flex flex-col gap-4">
      {/* status header */}
      <div className="flex items-center gap-3.5 rounded-2xl border border-ff-green-100 bg-ff-green-50 px-5 py-4">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-ff-green-600 shadow-[0_0_0_4px_rgba(56,112,64,0.18)]" />
        <div>
          <div className="text-[15px] font-extrabold text-ff-green-800">
            Свързано · приемаш плащания с карта
          </div>
          <div className="text-[12.5px] font-semibold text-ff-green-700">
            {summary.payoutsEnabled
              ? 'Картовите плащания и изплащанията са активни.'
              : 'Картовите плащания са активни.'}
          </div>
        </div>
        <a
          href={STRIPE_DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-ff-green-500 bg-ff-surface px-3.5 py-2 text-[12.5px] font-extrabold text-ff-green-700 transition-colors hover:bg-ff-green-50"
        >
          <ExternalLink size={15} /> Отвори Stripe
        </a>
      </div>

      {/* payout / balance card */}
      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <div className="mb-1 flex items-center gap-2 text-[13px] font-extrabold">
          <Wallet size={16} className="text-ff-green-700" /> Кога идват парите
        </div>
        <p className="mb-3 text-[12.5px] text-ff-muted">Следващо изплащане по банковата ти сметка</p>
        {summary.nextPayout ? (
          <>
            <div className="ff-fig text-[30px] font-extrabold tracking-[-0.01em]">
              {moneyFromStotinki(summary.nextPayout.amountStotinki)}
            </div>
            <div className="text-[12.5px] font-semibold text-ff-muted">
              очаквано {formatDate(summary.nextPayout.arrivalDate)}
            </div>
          </>
        ) : (
          <div className="text-[14px] font-semibold text-ff-ink-2">Няма предстоящо изплащане.</div>
        )}
        <div className="mt-4 flex gap-2.5">
          <Mini k="Налично сега" v={moneyFromStotinki(summary.availableStotinki)} />
          <Mini k="Изчакващо" v={moneyFromStotinki(summary.pendingStotinki)} />
        </div>
      </div>

      {/* recent payments (native) */}
      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold">
          <ArrowUpRight size={16} className="text-ff-green-700" /> Скорошни плащания
        </div>
        {summary.recentPayments.length === 0 ? (
          <div className="text-[13.5px] text-ff-muted">Още няма плащания.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-ff-border-2">
            {summary.recentPayments.map((p, i) => {
              const s = paymentStatus(p.status);
              return (
                <li key={i} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-semibold text-ff-ink">
                      {p.description ?? 'Плащане'}
                    </div>
                    <div className="text-[11.5px] text-ff-muted">{formatDate(p.created)}</div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-extrabold ${s.cls}`}
                  >
                    {s.label}
                  </span>
                  <div className="ff-fig w-[84px] shrink-0 text-right text-[14px] font-extrabold">
                    {moneyFromStotinki(p.amountStotinki)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <a
          href={STRIPE_DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-[12px] font-bold text-ff-green-700 hover:underline"
        >
          Всички плащания в Stripe <ExternalLink size={12} />
        </a>
      </div>

      {/* commission transparency */}
      <p className="text-center text-[12px] text-ff-muted">
        {summary.feeBps > 0
          ? `Комисиона FarmFlow: ${summary.feeBps / 100}%`
          : 'Получаваш 100% от плащанията.'}
      </p>
    </div>
  );
}

/* ─────────────────────────────  shared bits  ───────────────────────────── */

function SectionHeader({
  icon,
  title,
  hint,
  right,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 text-[13px] font-extrabold">
          {icon} {title}
        </div>
        {hint && <p className="mt-0.5 text-[12.5px] text-ff-muted">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex-1 rounded-xl border border-ff-border-2 bg-ff-surface-2 px-3 py-2.5">
      <div className="text-[9.5px] font-extrabold uppercase tracking-[0.03em] text-ff-muted">{k}</div>
      <div className="ff-fig mt-0.5 text-[16px] font-extrabold">{v}</div>
    </div>
  );
}

const CTA_STEPS = [
  'Натисни „Свържи Stripe“ — отваря се сигурната страница на Stripe.',
  'Попълни данните си и IBAN на банковата сметка (около 5 минути).',
  'Връщаш се готов — клиентите вече плащат с карта, парите идват при теб.',
];

function ConnectCta({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  return (
    <div className="rounded-2xl border border-ff-border bg-ff-surface p-8 shadow-ff-sm">
      <div className="text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-ff-green-100 text-ff-green-700">
          <CreditCard size={26} />
        </div>
        <h2 className="mb-2 text-[18px] font-extrabold">Приемай плащания с карта</h2>
        <p className="mx-auto mb-5 max-w-[460px] text-[13.5px] leading-[1.55] text-ff-muted">
          Свържи Stripe — услуга за картови плащания. Клиентите плащат онлайн, а парите идват
          директно при теб, по твоята банкова сметка. 0% комисиона върху поръчките.
        </p>
      </div>

      {/* what you need */}
      <div className="mx-auto max-w-[520px] rounded-xl border border-ff-border-2 bg-ff-surface-2 px-4 py-3">
        <div className="text-[10.5px] font-extrabold uppercase tracking-[0.03em] text-ff-muted">
          Какво ти трябва
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] font-semibold text-ff-ink-2">
          <span>Лична карта</span>
          <span>IBAN на сметката</span>
          <span>~5 минути</span>
        </div>
      </div>

      {/* steps */}
      <ol className="mx-auto mt-4 flex max-w-[520px] flex-col gap-2.5">
        {CTA_STEPS.map((s, i) => (
          <li key={i} className="flex items-start gap-3 text-[13.5px] leading-[1.5] text-ff-ink-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[12px] font-extrabold text-[#EAF1E4]">
              {i + 1}
            </span>
            <span className="mt-0.5">{s}</span>
          </li>
        ))}
      </ol>

      <div className="mt-6 text-center">
        <Button
          variant="primary"
          onClick={onStart}
          disabled={busy}
          className="rounded-sm px-6 py-3 text-[15px]"
        >
          <CreditCard size={18} /> {busy ? 'Отваряне…' : 'Свържи Stripe'}
        </Button>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] font-semibold text-ff-muted-2">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck size={14} /> Сигурно · регистрацията се обработва от Stripe
          </span>
          <a href="/help#stripe-connect" className="text-ff-green-700 hover:underline">
            Виж пълния гид
          </a>
        </div>
      </div>
    </div>
  );
}
