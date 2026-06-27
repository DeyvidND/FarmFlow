'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Truck, Zap, Plug, X, ArrowRight, Scale } from 'lucide-react';
import { getEcontConfig, getSpeedyConfig } from '@/lib/api-client';

const SEEN_KEY = 'ff-delivery-carrier-onboarding-seen';

/**
 * Onboarding nudge for a freshly created delivery account. Two parts:
 *  1. A one-time welcome modal (like the "turn off ad-block" popup) shown the
 *     very first time an operator enters with no carrier connected. Dismissed
 *     forever via localStorage.
 *  2. A persistent slim banner that keeps nudging until a carrier is connected:
 *     0 connected → "connect at least one"; 1 connected → "connect the second
 *     for the best price". Both vanish once both carriers are linked.
 *
 * Both are suppressed on /settings, where the operator is already connecting.
 */
export function CarrierOnboarding() {
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    // On /settings the banner + modal are suppressed and SettingsClient already
    // fetches both configs — skip the duplicate fetch this component would otherwise
    // fire on every panel route via PanelChrome.
    const onSettingsRoute = pathname === '/settings' || pathname.startsWith('/settings/');
    if (onSettingsRoute) return;
    let alive = true;
    Promise.all([
      getEcontConfig().catch(() => null),
      getSpeedyConfig().catch(() => null),
    ]).then(([e, s]) => {
      if (!alive) return;
      const n = (e?.configured ? 1 : 0) + (s?.configured ? 1 : 0);
      setCount(n);
      const seen = typeof window !== 'undefined' && localStorage.getItem(SEEN_KEY) === '1';
      if (n === 0 && !seen) setShowModal(true);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismissModal() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
    setShowModal(false);
  }

  // Don't nag on the settings screen — they're already there connecting.
  const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');

  if (count === null) return null;

  return (
    <>
      {/* persistent banner */}
      {!onSettings && count < 2 && (
        count === 0 ? (
          <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-3 px-8 pt-5 max-sm:px-4">
            <div className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-[#e7c9a0] bg-ff-amber-softer px-4 py-3">
              <Plug size={18} className="shrink-0 text-ff-amber-600" />
              <span className="text-[13.5px] font-semibold text-ff-ink-2">
                Все още нямаш свързан куриер. Свържи поне един, за да пускаш пратки.
              </span>
              <Link href="/settings" className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-ff-green-700 px-3 py-1.5 text-[13px] font-bold text-white hover:brightness-95">
                Свържи куриер <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-3 px-8 pt-5 max-sm:px-4">
            <div className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-ff-green-100 bg-ff-green-50 px-4 py-3">
              <Scale size={18} className="shrink-0 text-ff-green-700" />
              <span className="text-[13.5px] font-semibold text-ff-ink-2">
                Свържи и втория куриер, за да получаваш автоматично най-добрата цена за всяка пратка.
              </span>
              <Link href="/settings" className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-ff-green-600 bg-ff-surface px-3 py-1.5 text-[13px] font-bold text-ff-green-700 hover:bg-ff-surface-2">
                Свържи втория <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        )
      )}

      {/* one-time welcome modal */}
      {showModal && (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]">
          <div className="w-[460px] max-w-full overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
            <div className="flex items-start gap-3 border-b border-ff-border px-7 pb-5 pt-6">
              <span className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-xl bg-ff-green-50 text-ff-green-700">
                <Truck size={23} />
              </span>
              <div className="min-w-0">
                <div className="mb-0.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Първа стъпка</div>
                <h2 className="font-display text-[20px] font-extrabold tracking-[-0.015em] text-ff-ink">Свържи куриер, за да започнеш</h2>
              </div>
              <button onClick={dismissModal} aria-label="Затвори" className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2">
                <X size={18} />
              </button>
            </div>

            <div className="px-7 pb-7 pt-5">
              <p className="text-[14px] leading-relaxed text-ff-ink-2">
                За да създаваш пратки, трябва да свържеш поне един куриерски акаунт с твоите данни за вход:
              </p>
              <div className="mt-4 flex flex-col gap-2.5">
                <div className="flex items-center gap-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-green-50 text-ff-green-700"><Truck size={18} /></span>
                  <div className="text-[13.5px] text-ff-ink-2"><b className="text-ff-ink">Econt</b> — потребител и парола от e-Econt профила ти.</div>
                </div>
                <div className="flex items-center gap-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-amber-softer text-ff-amber-600"><Zap size={18} /></span>
                  <div className="text-[13.5px] text-ff-ink-2"><b className="text-ff-ink">Speedy</b> — API потребител и парола от Speedy.</div>
                </div>
              </div>
              <div className="mt-4 rounded-xl border border-ff-green-100 bg-ff-green-50 p-3.5">
                <div className="flex items-start gap-2.5">
                  <Scale size={17} className="mt-0.5 shrink-0 text-ff-green-700" />
                  <span className="text-[13px] leading-relaxed text-ff-ink-2">
                    Свържи <b>и двата</b> куриера, за да получаваш автоматично <b>най-добрата цена</b> за всяка пратка.
                  </span>
                </div>
              </div>

              <div className="mt-6 flex gap-2.5">
                <button onClick={dismissModal} className="rounded-xl border border-ff-border bg-ff-surface px-4 py-3 text-[14px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">
                  По-късно
                </button>
                <Link
                  href="/settings"
                  onClick={dismissModal}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-5 py-3 text-[15px] font-bold text-white hover:brightness-95"
                >
                  <Plug size={17} /> Свържи сега
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
