'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, TriangleAlert, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { todayIso } from '@/lib/utils';
import { getCheckProtocols } from '@/lib/api-client';
import { readCheckCache, saveCheckCache, type CheckProtocol } from '@/lib/protocol-cache';

const idLine = (p: CheckProtocol['fromSnapshot']) =>
  p?.eik ? `ЕИК ${p.eik}` : p?.regNo ? `рег.№ ${p.regNo}` : null;

const timeLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });

/**
 * Fullscreen „Проверка" — the day's SIGNED handover protocols shown large for a
 * roadside police check. Loads from the network, caches to IndexedDB (Task 11's
 * `saveCheckCache`), and falls back to the cache when offline so it still renders
 * with no signal.
 *
 * States, all reachable from `load()`:
 *   - loading            first paint, before the initial fetch settles.
 *   - loaded-with-data   network ok, rows.length > 0.
 *   - loaded-empty       network ok, rows.length === 0 — legitimately no signed
 *                        protocols today. NOT an error; no offline banner.
 *   - offline-from-cache network failed, a same-day cache existed — amber banner
 *                        naming when it was cached, rows come from the cache.
 *   - failed             network failed AND no cache for today — an honest error
 *                        state (never silently rendered as "no protocols", which
 *                        would tell a courier they have nothing to show when they
 *                        actually do).
 * `loading` always resolves via the try/catch/finally below, on every path.
 */
export function ProtocolCheckClient() {
  const [date] = useState(() => todayIso());
  const [rows, setRows] = useState<CheckProtocol[]>([]);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await getCheckProtocols(date);
      setRows(fresh);
      setOffline(false);
      setFailed(false);
      setCachedAt(null);
      await saveCheckCache(date, fresh, Date.now());
    } catch {
      const cached = await readCheckCache(date);
      if (cached) {
        setRows(cached.rows);
        setCachedAt(cached.cachedAt);
        setOffline(true);
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
    <div className="min-h-screen overflow-x-hidden bg-ff-surface">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-ff-border bg-ff-surface/95 px-4 py-3 backdrop-blur">
        <a href="/protocols" className="inline-flex items-center gap-1.5 text-[14px] font-bold text-ff-ink">
          <ArrowLeft size={18} /> Назад
        </a>
        <span className="text-[15px] font-extrabold">
          Проверка{rows.length > 0 ? ` · ${rows.length}` : ''}
        </span>
        <span className="w-16" />
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
          <p className="text-[14px] font-bold text-ff-ink">Неуспешно зареждане на протоколите</p>
          <p className="max-w-xs text-[13px] text-ff-muted">
            Няма връзка и няма запазено копие за днес. Провери връзката и опитай пак.
          </p>
          <Button size="sm" onClick={() => void load()}>
            Опитай пак
          </Button>
        </div>
      )}

      {!loading && !failed && rows.length === 0 && (
        <p className="px-5 py-16 text-center text-sm text-ff-muted">Няма подписани протоколи за днес.</p>
      )}

      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        {rows.map((r) => (
          <article key={r.id} className="overflow-hidden rounded-2xl border border-ff-border bg-white shadow-ff-sm">
            <div className="flex items-center justify-between gap-2 border-b border-ff-border-2 bg-ff-surface-2 px-4 py-3">
              <span className="text-[15px] font-extrabold">
                {r.kind === 'operator_to_customer' ? 'Разписка' : 'Протокол'} № {r.protocolNumber ?? '—'}
              </span>
              <span className="shrink-0 rounded-full bg-ff-green-50 px-2.5 py-0.5 text-[12px] font-bold text-ff-green-700">
                Подписан ✓
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 px-4 py-3">
              {[r.fromSnapshot, r.toSnapshot].map((p, i) => (
                <div key={i} className="min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-ff-muted">
                    {i === 0 ? 'Предава' : 'Приема'}
                  </div>
                  <div className="break-words text-[14px] font-bold text-ff-ink">{p?.name ?? '—'}</div>
                  {idLine(p) && <div className="break-words text-[12px] text-ff-muted">{idLine(p)}</div>}
                  {p?.address && <div className="break-words text-[12px] text-ff-muted">{p.address}</div>}
                </div>
              ))}
            </div>
            <ul className="border-t border-ff-border-2 px-4 py-3 text-[13.5px]">
              {r.items.map((it, i) => (
                <li key={i} className="flex items-start justify-between gap-3 py-0.5">
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
                    <div className="text-[11px] font-bold uppercase tracking-wide text-ff-muted">
                      {i === 0 ? 'Предал' : 'Приел'}
                    </div>
                    {s ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s} alt="" className="mx-auto h-14 w-auto max-w-full object-contain" />
                    ) : (
                      <div className="h-14" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
