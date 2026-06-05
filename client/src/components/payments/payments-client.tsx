'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, ShieldCheck, Wallet, Settings2, AlertTriangle } from 'lucide-react';
import {
  ConnectComponentsProvider,
  ConnectAccountOnboarding,
  ConnectPayments,
  ConnectAccountManagement,
  ConnectNotificationBanner,
} from '@stripe/react-connect-js';
import type { StripeConnectInstance } from '@stripe/connect-js';
import { Button } from '@/components/ui/button';
import { moneyFromStotinki } from '@/lib/utils';
import { createStripeAccountSession, type StripeSummary } from '@/lib/api-client';

/** Format an ISO date as "9 юни" (Bulgarian, day + month). */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long' });
  } catch {
    return '';
  }
}

export function PaymentsClient({
  initial,
  publishableKey,
}: {
  initial: StripeSummary;
  publishableKey: string;
}) {
  const router = useRouter();
  const summary = initial; // server-fetched; router.refresh() re-renders with fresh props
  const [connect, setConnect] = useState<StripeConnectInstance | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showManage, setShowManage] = useState(false);

  // Each embedded session is minted on demand (and creates the Express account
  // on first call via the API's ensureConnectedAccount).
  const fetchClientSecret = useCallback(async () => {
    const { clientSecret } = await createStripeAccountSession();
    return clientSecret;
  }, []);

  // Initialise the Connect instance in the browser only. connect-js touches
  // `window`, so it's dynamically imported inside the effect (SSR-safe).
  useEffect(() => {
    // Defer initialisation — and the implicit Express-account creation that
    // mounting an embedded component triggers — until the farm is connected or
    // has explicitly chosen to start onboarding.
    if (!publishableKey || (!summary.connected && !showOnboarding)) return;
    let active = true;
    void import('@stripe/connect-js').then(({ loadConnectAndInitialize }) => {
      const instance = loadConnectAndInitialize({
        publishableKey,
        fetchClientSecret,
        appearance: {
          variables: {
            colorPrimary: '#2c5530',
            colorBackground: '#ffffff',
            colorText: '#26241d',
            colorBorder: '#e6dece',
            borderRadius: '12px',
            fontFamily: 'Commissioner, system-ui, sans-serif',
          },
        },
      });
      if (active) setConnect(instance);
    });
    return () => {
      active = false;
    };
  }, [publishableKey, fetchClientSecret, summary.connected, showOnboarding]);

  const heading = (
    <div className="mb-6">
      <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Плащания</h1>
      <p className="text-[13.5px] text-ff-muted">
        Приемай плащания с карта. Парите отиват директно при теб, по твоята банкова сметка.
      </p>
    </div>
  );

  // Platform hasn't enabled card payments (no publishable key, or the API has no
  // Stripe secret key) — nothing to mount.
  if (!publishableKey || !summary.enabled) {
    return (
      <div className="max-w-[760px] animate-ff-fade-up">
        {heading}
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 text-[14px] leading-[1.55] text-ff-ink-2 shadow-ff-sm">
          Картовите плащания още не са активирани от платформата. Свържи се с поддръжката, за да ги
          включим за твоята ферма.
        </div>
      </div>
    );
  }

  // Not connected yet and the farm hasn't chosen to start — explainer CTA only.
  // No embedded component mounts here, so no Stripe account is created until the
  // farmer explicitly clicks "Свържи Stripe".
  if (!summary.connected && !showOnboarding) {
    return (
      <div className="max-w-[820px] animate-ff-fade-up">
        {heading}
        <ConnectCta onStart={() => setShowOnboarding(true)} />
      </div>
    );
  }

  if (!connect) {
    return (
      <div className="max-w-[760px] animate-ff-fade-up">
        {heading}
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 text-[14px] text-ff-muted shadow-ff-sm">
          Зареждане…
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[820px] animate-ff-fade-up">
      {heading}
      <ConnectComponentsProvider connectInstance={connect}>
        {summary.chargesEnabled ? (
          <div className="flex flex-col gap-4">
            <ConnectNotificationBanner />

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
              <button
                onClick={() => setShowManage((v) => !v)}
                className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-ff-green-500 bg-ff-surface px-3.5 py-2 text-[12.5px] font-extrabold text-ff-green-700 transition-colors hover:bg-ff-green-50"
              >
                <Settings2 size={15} /> {showManage ? 'Скрий' : 'Управлявай в Stripe'}
              </button>
            </div>

            {showManage && (
              <div className="rounded-2xl border border-ff-border bg-ff-surface p-2 shadow-ff-sm">
                <ConnectAccountManagement />
              </div>
            )}

            {/* payout / balance card */}
            <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
              <div className="mb-1 flex items-center gap-2 text-[13px] font-extrabold">
                <Wallet size={16} className="text-ff-green-700" /> Кога идват парите
              </div>
              <p className="mb-3 text-[12.5px] text-ff-muted">
                Следващо изплащане по банковата ти сметка
              </p>
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
                <div className="text-[14px] font-semibold text-ff-ink-2">
                  Няма предстоящо изплащане.
                </div>
              )}
              <div className="mt-4 flex gap-2.5">
                <Mini k="Налично сега" v={moneyFromStotinki(summary.availableStotinki)} />
                <Mini k="Изчакващо" v={moneyFromStotinki(summary.pendingStotinki)} />
              </div>
            </div>

            {/* recent payments (embedded) */}
            <div className="overflow-hidden rounded-2xl border border-ff-border bg-ff-surface p-2 shadow-ff-sm">
              <ConnectPayments />
            </div>

            {/* commission transparency */}
            <p className="text-center text-[12px] text-ff-muted">
              {summary.feeBps > 0
                ? `Комисиона FarmFlow: ${summary.feeBps / 100}%`
                : 'Получаваш 100% от плащанията.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <ConnectNotificationBanner />
            {summary.connected && !summary.chargesEnabled && (
              <div className="flex items-start gap-2.5 rounded-2xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3.5">
                <AlertTriangle size={18} className="mt-px shrink-0 text-ff-amber-600" />
                <div>
                  <div className="text-[13.5px] font-extrabold text-ff-amber-600">Почти готово</div>
                  <div className="text-[12.5px] leading-[1.45] text-ff-ink-2">
                    Stripe иска още няколко данни (банкова сметка / документ), за да активира
                    плащанията.
                  </div>
                </div>
              </div>
            )}
            <div className="rounded-2xl border border-ff-border bg-ff-surface p-2 shadow-ff-sm">
              <ConnectAccountOnboarding onExit={() => router.refresh()} />
            </div>
          </div>
        )}
      </ConnectComponentsProvider>
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

function ConnectCta({ onStart }: { onStart: () => void }) {
  return (
    <div className="rounded-2xl border border-ff-border bg-ff-surface p-8 text-center shadow-ff-sm">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-ff-green-100 text-ff-green-700">
        <CreditCard size={26} />
      </div>
      <h2 className="mb-2 text-[18px] font-extrabold">Приемай плащания с карта</h2>
      <p className="mx-auto mb-5 max-w-[440px] text-[13.5px] leading-[1.55] text-ff-muted">
        Свържи Stripe — услуга за картови плащания. Клиентите плащат онлайн, а парите идват директно
        при теб, по твоята банкова сметка. Отнема около 5 минути.
      </p>
      <Button variant="primary" onClick={onStart} className="rounded-sm px-6 py-3 text-[15px]">
        <CreditCard size={18} /> Свържи Stripe
      </Button>
      <div className="mt-5 flex items-center justify-center gap-1.5 text-[11.5px] font-semibold text-ff-muted-2">
        <ShieldCheck size={14} /> Сигурно · регистрацията се обработва от Stripe
      </div>
    </div>
  );
}
