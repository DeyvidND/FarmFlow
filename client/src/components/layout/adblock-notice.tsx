'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert, X, RefreshCw, Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Permanent dismissal (the user chose to ignore it) and a per-session "already
// checked" flag so we run the probe at most once per session, not per page view.
const DISMISS_KEY = 'ff:adblock-dismissed';
const CHECKED_KEY = 'ff:adblock-checked';

/**
 * Detect whether an ad-blocker is active — specifically one that would stop our
 * error monitoring (the browser SDK posts straight to Sentry's ingest host, which
 * uBlock/AdBlock drop). Two signals:
 *   1) DOM bait — blockers hide elements with ad-like class names (cosmetic lists).
 *   2) Network probe — can the browser actually reach Sentry's ingest host? That's
 *      exactly the request that matters; if it's blocked, our reports never arrive.
 * Either firing → treat as blocked.
 */
async function detectAdblock(): Promise<boolean> {
  // 1) DOM bait (instant, no network).
  try {
    const bait = document.createElement('div');
    bait.className = 'adsbox ad-banner ad-placement pub_300x250 text-ad';
    bait.style.cssText =
      'position:absolute;left:-9999px;top:-9999px;height:10px;width:10px;pointer-events:none;';
    bait.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bait);
    await new Promise((r) => setTimeout(r, 120));
    const cs = getComputedStyle(bait);
    const blocked =
      bait.offsetParent === null ||
      bait.offsetHeight === 0 ||
      bait.clientHeight === 0 ||
      cs.display === 'none' ||
      cs.visibility === 'hidden';
    bait.remove();
    if (blocked) return true;
  } catch {
    /* ignore — fall through to the network probe */
  }

  // 2) Network probe to Sentry's ingest host (the thing we actually care about).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    await fetch(
      'https://o4511580150366208.ingest.de.sentry.io/api/4511592377614416/envelope/',
      { method: 'POST', mode: 'no-cors', cache: 'no-store', body: '', keepalive: true },
    );
    return false; // reachable → not blocked
  } catch {
    return true; // request dropped → blocked
  }
}

/**
 * Friendly, non-blocking notice shown to panel users running an ad-blocker that
 * would suppress our automatic error reports. Explains WHY turning it off helps
 * (we catch and fix errors fast), makes clear it's not ads/tracking, and offers a
 * reload. Shown once per session; "Разбрах" dismisses it for good (localStorage).
 */
export function AdblockNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return; // user opted out
      if (sessionStorage.getItem(CHECKED_KEY) === '1') return; // already checked
    } catch {
      /* storage blocked — still run the check once */
    }
    let cancelled = false;
    void detectAdblock().then((blocked) => {
      try {
        sessionStorage.setItem(CHECKED_KEY, '1');
      } catch {
        /* ignore */
      }
      if (!cancelled && blocked) setShow(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode / quota — it may show again next session */
    }
    setShow(false);
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]">
      <div className="animate-ff-pop max-h-[94vh] w-[480px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
        <div className="flex items-start gap-3 border-b border-ff-border-2 px-7 pb-5 pt-6">
          <span className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700">
            <ShieldAlert size={23} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">
              Засякохме блокер на реклами
            </div>
            <h2 className="font-display text-[20px] font-extrabold tracking-[-0.015em] text-ff-ink">
              Изключи го за този сайт
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
            Изглежда ползваш блокер на реклами (напр. uBlock или AdBlock).
          </p>

          {/* The why: automatic error reporting, blocked by the ad-blocker. */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-start gap-2.5">
              <Bug size={18} className="mt-0.5 shrink-0 text-amber-700" />
              <div>
                <div className="text-[14px] font-extrabold text-ff-ink">
                  Панелът сам следи за технически грешки
                </div>
                <div className="mt-0.5 text-[13px] leading-relaxed text-ff-ink-2">
                  Когато нещо се счупи, системата автоматично ни изпраща сигнал, за да го
                  поправим бързо — често преди да ти попречи. Блокерът спира тези сигнали и
                  грешките остават скрити за нас.
                </div>
              </div>
            </div>
          </div>

          {/* Reassurance — it's not ads or behaviour tracking. */}
          <p className="text-[13px] leading-relaxed text-ff-ink-2">
            Това не са реклами и не следим поведението ти — изпращат се{' '}
            <b>само технически грешки</b>, за да работи панелът гладко.
          </p>

          {/* How to disable. */}
          <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ff-ink-2">
            Кликни иконата на блокера горе вдясно в браузъра → избери{' '}
            <b>изключи за този сайт</b> → презареди страницата.
          </div>

          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={dismiss} className="rounded-sm">
              Разбрах
            </Button>
            <Button
              variant="primary"
              onClick={() => window.location.reload()}
              className="w-full rounded-sm sm:w-auto"
            >
              <RefreshCw size={16} /> Презареди
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
