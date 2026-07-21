'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, TriangleAlert, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRole } from '@/components/layout/role-context';
import { todayIso } from '@/lib/utils';
import { ApiError, getCheckProtocols } from '@/lib/api-client';
import { readCheckCache, saveCheckCache, type CheckProtocol } from '@/lib/protocol-cache';

const idLine = (p: CheckProtocol['fromSnapshot']) =>
  p?.eik ? `ЕИК ${p.eik}` : p?.regNo ? `рег.№ ${p.regNo}` : null;

const timeLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });

/** „21.07.2026 г." — the date band's label. Built from the plain YYYY-MM-DD the
 *  screen already holds, so it renders identically offline. */
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y} г.`;
};

const signedTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' }) : null;

/**
 * Fullscreen „Проверка" — the day's SIGNED handover protocols shown large for a
 * roadside police check.
 *
 * CACHE-FIRST, then refresh. The roadside failure mode is a stalled connection,
 * not a clean offline one, so painting the IndexedDB copy immediately (and
 * letting a timeboxed refresh replace it) is what keeps a courier from staring
 * at a spinner while an officer waits.
 *
 * States, all reachable from `load()`:
 *   - loading            first paint, no cache yet, before the fetch settles.
 *   - loaded-with-data   refresh ok, rows.length > 0.
 *   - loaded-empty       refresh ok, rows.length === 0 — legitimately no signed
 *                        protocols today. NOT an error; no offline banner.
 *   - cached-then-fresh  a same-day cache painted first, refresh then replaced it.
 *                        No banner — the data is current. (`offline` is asserted
 *                        only after a refresh FAILS, or the banner would flash on
 *                        every online load.)
 *   - offline-from-cache refresh failed, a same-day cache existed — amber banner
 *                        naming when it was cached, rows come from the cache.
 *   - denied             refresh returned 401/403. Distinct copy: this account
 *                        isn't allowed to read protocols, which is NOT a signal
 *                        problem and must not be reported as one.
 *   - failed             refresh failed AND no cache for today — an honest error
 *                        state (never silently rendered as "no protocols", which
 *                        would tell a courier they have nothing to show when they
 *                        actually do).
 * `loading` always resolves via the try/catch/finally below, on every path.
 */
export function ProtocolCheckClient() {
  const role = useRole();
  const [date] = useState(() => todayIso());
  const [rows, setRows] = useState<CheckProtocol[]>([]);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [failed, setFailed] = useState(false);
  // Distinguishes "the server refused this account" from "no network", so the
  // error copy can stop blaming the signal for a permissions problem.
  const [denied, setDenied] = useState(false);
  // The timeout firing means the connection exists but is too slow to use — the
  // classic roadside condition. „Провери връзката" is the wrong advice for it.
  const [timedOut, setTimedOut] = useState(false);
  const [loading, setLoading] = useState(true);

  // Which protocol is on screen. Driven BY the scroll position (so a swipe and a
  // button press stay in agreement) rather than driving it.
  const scroller = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const onScroll = () => {
    const el = scroller.current;
    if (!el || !el.clientWidth) return;
    const next = Math.round(el.scrollLeft / el.clientWidth);
    setIdx((prev) => (prev === next ? prev : next));
  };
  /** Move to a protocol. Sets `idx` itself rather than waiting for `onScroll` to
   *  report back: a programmatic scroll does not reliably emit a scroll event, so
   *  a button that only scrolled left the counter and the prev/next disabled
   *  states stuck on the previous card. `onScroll` still handles real swipes. */
  const go = (to: number) => {
    const el = scroller.current;
    const clamped = Math.max(0, Math.min(to, rows.length - 1));
    setIdx(clamped);
    // Instant, not smooth: a smooth scroll was silently a no-op in testing, which
    // left the counter on the new card while the screen still showed the old one.
    // Paging a document under time pressure wants to be immediate anyway.
    if (el) el.scrollTo({ left: clamped * el.clientWidth, behavior: 'auto' });
  };

  const load = useCallback(async () => {
    setLoading(true);
    // CACHE FIRST, then refresh. The roadside failure mode is a STALLED network,
    // not a clean offline one — network-first left the courier watching a spinner
    // for the browser's full timeout while the protocols he needed sat in
    // IndexedDB. Paint whatever we already have immediately; the refresh below
    // either replaces it or leaves the offline banner standing.
    const cached = await readCheckCache(date);
    if (cached) {
      setRows(cached.rows);
      setCachedAt(cached.cachedAt);
      setFailed(false);
      setLoading(false);
      // Deliberately NOT setOffline(true) here: that would flash the amber
      // „Офлайн" banner on every load of a perfectly online session, in the
      // window before the refresh lands. Offline is asserted only once the
      // refresh has actually failed.
    }

    try {
      const fresh = await getCheckProtocols(date);
      setRows(fresh);
      setOffline(false);
      setFailed(false);
      setCachedAt(null);
      setDenied(false);
      setTimedOut(false);
      await saveCheckCache(date, fresh, Date.now());
    } catch (e) {
      // 401/403 is NOT "no signal" — it's this account not being allowed to read
      // protocols (today: any non-admin role, since GET /handover/check is
      // admin-only). Telling a courier standing next to an officer that his phone
      // has no connection, while it shows four bars, destroys trust in the screen.
      const permission = e instanceof ApiError && (e.status === 401 || e.status === 403);
      // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
      const slow = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
      setDenied(permission);
      setTimedOut(slow);
      if (cached) {
        // Keep the cached protocols on screen — they are what the officer needs —
        // and only NOW admit the data is stale.
        setOffline(!permission);
        setFailed(false);
      } else {
        setRows([]);
        setCachedAt(null);
        setOffline(false);
        setFailed(true);
      }
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-ff-surface">
      <div className="flex shrink-0 items-center justify-between border-b border-ff-border bg-ff-surface px-4 py-2.5">
        {/* A courier came from /route and cannot open the /protocols list at all
            (it's an operator screen; GET /handover is admin-only), so sending
            them there would dead-end on a 403. */}
        <a
          href={role === 'driver' ? '/route' : '/protocols'}
          className="inline-flex items-center gap-1.5 text-[14px] font-bold text-ff-ink"
        >
          <ArrowLeft size={18} /> Назад
        </a>
        {rows.length > 1 && (
          <span className="ff-fig text-[14px] font-bold text-ff-muted">
            {idx + 1} / {rows.length}
          </span>
        )}
        <span className="w-16" />
      </div>

      {/* DATE BAND — the first thing on screen, in EVERY state. The phone gets
          handed to an officer, and a приемо-предавателен протокол without a
          visible date is a list, not a document. Rendered from the plain
          YYYY-MM-DD the screen already holds, so it survives offline. */}
      <div className="shrink-0 border-b border-ff-border bg-ff-surface-2 px-4 py-3">
        <div className="text-[19px] font-extrabold leading-tight text-ff-ink">
          Протоколи за {dayLabel(date)}
        </div>
        <div className="mt-0.5 text-[13px] text-ff-muted">
          {rows.length > 0
            ? `${rows.length} ${rows.length === 1 ? 'подписан протокол' : 'подписани протокола'}`
            : 'Приемо-предавателни протоколи'}
        </div>
      </div>

      {offline && (
        <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-[12.5px] font-bold text-amber-800">
          <WifiOff size={15} className="shrink-0" />
          <span>
            Офлайн — показани са кешираните протоколи
            {cachedAt ? ` (кеширано в ${timeLabel(cachedAt)})` : ''}
          </span>
        </div>
      )}

      {loading && rows.length === 0 && !failed && (
        <p className="px-5 py-16 text-center text-sm text-ff-muted">Зареждане…</p>
      )}

      {!loading && failed && (
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
          <TriangleAlert size={28} className="text-ff-red" />
          <p className="text-[14px] font-bold text-ff-ink">
            {denied
              ? 'Този профил няма достъп до протоколите'
              : timedOut
                ? 'Бавна връзка'
                : 'Неуспешно зареждане на протоколите'}
          </p>
          <p className="max-w-xs text-[13px] text-ff-muted">
            {denied
              ? 'Влез с профила на стопанството или поискай достъп от оператора. Връзката е наред — проблемът не е в сигнала.'
              : timedOut
                ? 'Връзката не отговори навреме и няма запазено копие за днес. Опитай пак — обикновено минава от втория път.'
                : 'Няма връзка и няма запазено копие за днес. Провери връзката и опитай пак.'}
          </p>
          {!denied && (
            <Button size="sm" onClick={() => void load()}>
              Опитай пак
            </Button>
          )}
        </div>
      )}

      {!loading && !failed && rows.length === 0 && (
        <p className="px-5 py-16 text-center text-sm text-ff-muted">Няма подписани протоколи за днес.</p>
      )}

      {/* ONE protocol per screen, swiped horizontally. CSS scroll-snap rather than
          a JS gesture handler: it keeps native momentum and works with a thumb on
          a cold morning. The card is sized to the reader — the officer holding the
          phone — not to the courier scanning a list, so body type starts at 16px
          and the legal id carries the same weight as the party name. */}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-auto"
      >
        {rows.map((r) => (
          <article key={r.id} className="w-full shrink-0 snap-center snap-always px-4 py-4">
            <div className="mx-auto max-w-2xl overflow-hidden rounded-2xl border border-ff-border bg-white shadow-ff-sm">
              <div className="flex items-center justify-between gap-2 border-b border-ff-border-2 bg-ff-surface-2 px-4 py-3">
                <span className="text-[18px] font-extrabold">
                  {r.kind === 'operator_to_customer' ? 'Разписка' : 'Протокол'} № {r.protocolNumber ?? '—'}
                </span>
                <span className="shrink-0 rounded-full bg-ff-green-50 px-2.5 py-1 text-[13px] font-bold text-ff-green-700">
                  Подписан ✓
                </span>
              </div>
              {signedTime(r.signedAt) && (
                <div className="border-b border-ff-border-2 px-4 py-1.5 text-[13px] text-ff-muted">
                  Подписан в {signedTime(r.signedAt)} ч. на {dayLabel(date)}
                </div>
              )}
              {/* Stacked, not two columns: at 375px a two-column split squeezed
                  names to „Кра…" and pushed the legal id to the smallest type on
                  a screen whose whole job is proving legal identity. */}
              <div className="flex flex-col gap-3 px-4 py-3">
                {[r.fromSnapshot, r.toSnapshot].map((p, i) => (
                  <div key={i} className="min-w-0">
                    <div className="text-[12px] font-bold uppercase tracking-wide text-ff-muted">
                      {i === 0 ? 'Предава' : 'Приема'}
                    </div>
                    <div className="break-words text-[17px] font-bold leading-tight text-ff-ink">
                      {p?.name ?? '—'}
                    </div>
                    {idLine(p) && (
                      <div className="break-words text-[16px] font-bold text-ff-ink-2">{idLine(p)}</div>
                    )}
                    {p?.address && <div className="break-words text-[14px] text-ff-muted">{p.address}</div>}
                  </div>
                ))}
              </div>
              <ul className="border-t border-ff-border-2 px-4 py-3 text-[15px]">
                {r.items.map((it, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 py-1">
                    <span className="min-w-0 break-words font-semibold">
                      {it.productName}
                      {it.variantLabel ? ` · ${it.variantLabel}` : ''}
                    </span>
                    <span className="ff-fig shrink-0 whitespace-nowrap font-bold">
                      {it.quantity}
                      {it.unit ? ` ${it.unit}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {(r.fromSignaturePng || r.toSignaturePng) && (
                <div className="grid grid-cols-2 gap-3 border-t border-ff-border-2 px-4 py-3">
                  {[r.fromSignaturePng, r.toSignaturePng].map((s, i) => (
                    <div key={i} className="text-center">
                      <div className="text-[12px] font-bold uppercase tracking-wide text-ff-muted">
                        {i === 0 ? 'Предал' : 'Приел'}
                      </div>
                      {s ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s} alt="" className="mx-auto h-16 w-auto max-w-full object-contain" />
                      ) : (
                        <div className="h-16" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      {/* Explicit prev/next as well as the swipe: a gesture is invisible, and
          this screen must not depend on the courier discovering one under stress. */}
      {rows.length > 1 && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ff-border bg-ff-surface px-4 py-2.5">
          <button
            type="button"
            onClick={() => go(idx - 1)}
            disabled={idx === 0}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-ff-border px-4 text-[14px] font-bold text-ff-ink-2 disabled:opacity-40"
          >
            <ChevronLeft size={18} /> Предишен
          </button>
          <span className="ff-fig text-[14px] font-bold text-ff-muted">
            {idx + 1} / {rows.length}
          </span>
          <button
            type="button"
            onClick={() => go(idx + 1)}
            disabled={idx >= rows.length - 1}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-ff-border px-4 text-[14px] font-bold text-ff-ink-2 disabled:opacity-40"
          >
            Следващ <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
