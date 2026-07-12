'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Database, Server, ListChecks, OctagonAlert, RefreshCw, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ApiError,
  getHealthBoard,
  type HealthBoard,
  type QueueHealth,
  type RecentError,
  type ServiceStatus,
} from '@/lib/api-client';

/** ISO → "14:32" for the "обновено в …" strapline. */
function fmtClock(iso: string): string {
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** ISO → "11.07, 21:51" for the recent-errors timeline. */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}, ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const QUEUE_STATUS: Record<
  QueueHealth['status'],
  { label: string; bg: string; ink: string; dot: string; row?: string }
> = {
  ok: { label: 'ОК', bg: 'bg-ff-green-100', ink: 'text-ff-green-700', dot: 'bg-ff-green-500' },
  backlog: {
    label: 'Натрупване',
    bg: 'bg-ff-amber-soft',
    ink: 'text-ff-amber-600',
    dot: 'bg-ff-amber',
    row: 'bg-ff-amber-softer',
  },
  error: {
    label: 'Грешка',
    bg: 'bg-ff-red-soft',
    ink: 'text-ff-red',
    dot: 'bg-ff-red',
    row: 'bg-ff-red-soft',
  },
};

function ServiceTile({
  icon,
  label,
  status,
}: {
  icon: React.ReactNode;
  label: string;
  status: ServiceStatus;
}) {
  const up = status === 'up';
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border p-4 shadow-ff-sm',
        up ? 'border-ff-green-100 bg-ff-green-50' : 'border-ff-red bg-ff-red-soft',
      )}
    >
      <span
        className={cn(
          'grid h-11 w-11 shrink-0 place-items-center rounded-xl',
          up ? 'bg-ff-green-100 text-ff-green-700' : 'bg-ff-red-soft text-ff-red',
        )}
      >
        {icon}
      </span>
      <div>
        <div className="text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">{label}</div>
        <div
          className={cn(
            'mt-0.5 flex items-center gap-1.5 text-[15.5px] font-extrabold',
            up ? 'text-ff-green-800' : 'text-ff-red',
          )}
        >
          <span className={cn('h-[8px] w-[8px] rounded-full', up ? 'bg-ff-green-500' : 'bg-ff-red')} />
          {up ? 'Работи' : 'Не работи'}
        </div>
      </div>
    </div>
  );
}

function QueueBadge({ status }: { status: QueueHealth['status'] }) {
  const s = QUEUE_STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-xs font-bold',
        s.bg,
        s.ink,
      )}
    >
      <span className={cn('h-[7px] w-[7px] rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

/** One recent failure: method + path + farm + time, and the verbatim error message
 *  (the actual cause, e.g. a failing SQL) in a monospace, scrollable block. */
function RecentErrorCard({ err }: { err: RecentError }) {
  return (
    <li className="rounded-xl border border-ff-border bg-ff-surface p-3.5 shadow-ff-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="ff-fig inline-flex shrink-0 items-center rounded-md bg-ff-red-soft px-1.5 py-0.5 text-[11.5px] font-extrabold text-ff-red">
          {err.statusCode}
        </span>
        <span className="shrink-0 font-mono text-[11.5px] font-bold text-ff-muted">{err.method}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ff-ink-2" title={err.path}>
          {err.path}
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap text-[11.5px] text-ff-muted-2">
          {err.tenantName ?? '(без ферма)'} · {fmtDateTime(err.createdAt)}
        </span>
      </div>
      {err.message ? (
        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ff-surface-2 p-2.5 font-mono text-[11.5px] leading-[1.5] text-ff-ink-2">
          {err.message}
        </pre>
      ) : (
        <div className="mt-2 text-[12px] italic text-ff-muted-2">Няма съобщение за грешката.</div>
      )}
    </li>
  );
}

export function HealthClient() {
  const [data, setData] = useState<HealthBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getHealthBoard();
      setData(res);
      setFailed(false);
    } catch (e) {
      setFailed(true);
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно зареждане на здравето');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Здраве</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            Живо състояние на платформата — услуги, опашки и грешки за последните 24ч.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && <span className="text-[12px] text-ff-muted-2">обновено в {fmtClock(data.generatedAt)}</span>}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[13px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
            Обнови
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="mt-5 flex flex-col gap-3">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-[76px] animate-pulse rounded-xl border border-ff-border bg-ff-surface-2 shadow-ff-sm"
              />
            ))}
          </div>
          <div className="h-[160px] animate-pulse rounded-xl border border-ff-border bg-ff-surface-2 shadow-ff-sm" />
          <div className="h-[160px] animate-pulse rounded-xl border border-ff-border bg-ff-surface-2 shadow-ff-sm" />
        </div>
      ) : failed && !data ? (
        <div className="mt-5 rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-sm text-ff-muted shadow-ff-sm">
          Неуспешно зареждане на здравето. Опитай да презаредиш.
        </div>
      ) : data ? (
        <div className="mt-5 flex flex-col gap-6">
          {/* Услуги */}
          <section>
            <h2 className="mb-2.5 flex items-center gap-2 text-[16px] font-extrabold">
              <Server size={17} className="text-ff-green-600" /> Услуги
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              <ServiceTile icon={<Database size={20} />} label="База данни" status={data.services.db} />
              <ServiceTile icon={<Server size={20} />} label="Redis" status={data.services.redis} />
            </div>
          </section>

          {/* Опашки */}
          <section>
            <h2 className="mb-2.5 flex items-center gap-2 text-[16px] font-extrabold">
              <ListChecks size={17} className="text-ff-green-600" /> Опашки
            </h2>
            {data.queues.length === 0 ? (
              <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-8 text-center text-sm text-ff-muted shadow-ff-sm">
                Няма активни опашки.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
                {/* desktop table */}
                <table className="w-full border-collapse max-[640px]:hidden">
                  <thead>
                    <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                      {['Опашка', 'Чакащи', 'Активни', 'Отложени', 'Неуспешни', 'Статус'].map((h) => (
                        <th
                          key={h}
                          className="px-5 py-2.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.queues.map((q) => (
                      <tr
                        key={q.name}
                        className={cn('border-b border-ff-border-2 last:border-0', QUEUE_STATUS[q.status].row)}
                      >
                        <td className="px-5 py-2.5 text-[13.5px] font-bold text-ff-ink">{q.name}</td>
                        <td className="ff-fig px-5 py-2.5 text-[13.5px] text-ff-ink-2">{q.waiting}</td>
                        <td className="ff-fig px-5 py-2.5 text-[13.5px] text-ff-ink-2">{q.active}</td>
                        <td className="ff-fig px-5 py-2.5 text-[13.5px] text-ff-ink-2">{q.delayed}</td>
                        <td
                          className={cn(
                            'ff-fig px-5 py-2.5 text-[13.5px]',
                            q.failed > 0 ? 'font-bold text-ff-red' : 'text-ff-ink-2',
                          )}
                        >
                          {q.failed}
                        </td>
                        <td className="px-5 py-2.5">
                          <QueueBadge status={q.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* mobile cards */}
                <div className="hidden flex-col max-[640px]:flex">
                  {data.queues.map((q) => (
                    <div
                      key={q.name}
                      className={cn(
                        'flex flex-col gap-2 border-b border-ff-border-2 px-4 py-3.5 last:border-0',
                        QUEUE_STATUS[q.status].row,
                      )}
                    >
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="text-[14.5px] font-extrabold text-ff-ink">{q.name}</div>
                        <QueueBadge status={q.status} />
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ff-ink-2">
                        <span>
                          Чакащи: <span className="ff-fig font-bold">{q.waiting}</span>
                        </span>
                        <span>
                          Активни: <span className="ff-fig font-bold">{q.active}</span>
                        </span>
                        <span>
                          Отложени: <span className="ff-fig font-bold">{q.delayed}</span>
                        </span>
                        <span className={q.failed > 0 ? 'font-bold text-ff-red' : undefined}>
                          Неуспешни: <span className="ff-fig font-bold">{q.failed}</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Грешки (24ч) */}
          <section>
            <h2 className="mb-2.5 flex items-center gap-2 text-[16px] font-extrabold">
              <OctagonAlert size={17} className="text-ff-green-600" /> Грешки (24ч)
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div
                className={cn(
                  'rounded-xl border p-4 shadow-ff-sm sm:col-span-1',
                  data.errors.last24h > 0 ? 'border-ff-red bg-ff-red-soft' : 'border-ff-green-100 bg-ff-green-50',
                )}
              >
                <div className="text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">Общо грешки</div>
                <div
                  className={cn(
                    'ff-fig mt-1.5 text-[28px] font-extrabold tracking-[-0.02em]',
                    data.errors.last24h > 0 ? 'text-ff-red' : 'text-ff-green-800',
                  )}
                >
                  {data.errors.last24h}
                </div>
              </div>

              <div className="rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm sm:col-span-1">
                <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">
                  Топ пътища
                </div>
                {data.errors.topPaths.length === 0 ? (
                  <div className="text-[13px] text-ff-muted-2">Няма грешки.</div>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {data.errors.topPaths.map((p, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="truncate text-ff-ink-2" title={p.path}>
                          {p.path}
                        </span>
                        <span className="ff-fig shrink-0 rounded-full bg-ff-surface-2 px-2 py-0.5 text-[11.5px] font-bold text-ff-ink-2">
                          {p.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm sm:col-span-1">
                <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">
                  Топ ферми
                </div>
                {data.errors.topTenants.length === 0 ? (
                  <div className="text-[13px] text-ff-muted-2">Няма грешки.</div>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {data.errors.topTenants.map((t, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="truncate text-ff-ink-2">{t.tenantName ?? '(без ферма)'}</span>
                        <span className="ff-fig shrink-0 rounded-full bg-ff-surface-2 px-2 py-0.5 text-[11.5px] font-bold text-ff-ink-2">
                          {t.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Последни грешки — verbatim messages, newest first */}
            {data.errors.recent.length > 0 && (
              <div className="mt-3">
                <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">
                  Последни грешки
                </div>
                <ul className="flex flex-col gap-2.5">
                  {data.errors.recent.map((err, i) => (
                    <RecentErrorCard key={i} err={err} />
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {data?.notes && data.notes.length > 0 && (
        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-ff-border-2 bg-ff-surface-2 px-4 py-3.5">
          <Info size={16} className="mt-0.5 shrink-0 text-ff-muted" />
          <div>
            <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Забележки</div>
            <ul className="mt-1 flex flex-col gap-1">
              {data.notes.map((n, i) => (
                <li key={i} className="text-[12.5px] leading-[1.4] text-ff-muted">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
