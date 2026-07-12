'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, CircleCheck, Info, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EnterPanelButton } from '@/components/enter-panel-button';
import {
  ApiError,
  getProblems,
  resolveProblem,
  type PlatformProblem,
  type ProblemSeverity,
  type ProblemsResponse,
} from '@/lib/api-client';

const SEVERITY: Record<ProblemSeverity, { label: string; bg: string; ink: string; dot: string }> = {
  high: { label: 'Спешно', bg: 'bg-ff-red-soft', ink: 'text-ff-red', dot: 'bg-ff-red' },
  med: { label: 'Внимание', bg: 'bg-ff-amber-soft', ink: 'text-ff-amber-600', dot: 'bg-ff-amber-600' },
  low: { label: 'За сведение', bg: 'bg-ff-surface-2', ink: 'text-ff-muted', dot: 'bg-ff-muted-2' },
};

/** ISO → "9.07 14:32", or null when missing/invalid. */
function fmtWhen(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** ISO → "14:32" for the "обновено в …" strapline. */
function fmtClock(iso: string): string {
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function ProblemRow({ p, onResolved }: { p: PlatformProblem; onResolved: () => void }) {
  const s = SEVERITY[p.severity];
  const when = fmtWhen(p.lastAt);
  const [resolving, setResolving] = useState(false);
  const canResolve = p.kind === 'server_error' && !!p.path;

  async function resolve() {
    if (!p.path) return;
    setResolving(true);
    try {
      await resolveProblem(p.tenantId, p.path);
      toast.success('Маркирано като оправено');
      onResolved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно маркиране като оправено');
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', s.dot)} />
      <div className="flex flex-col gap-3 p-4 pl-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-bold',
                s.bg,
                s.ink,
              )}
            >
              <span className={cn('h-[6px] w-[6px] rounded-full', s.dot)} />
              {s.label}
            </span>
            {p.tenantName && <span className="text-[12.5px] font-bold text-ff-ink-2">{p.tenantName}</span>}
            {typeof p.count === 'number' && (
              <span className="ff-fig rounded-full bg-ff-surface-2 px-2 py-0.5 text-[11.5px] font-bold text-ff-ink-2">
                {p.count}
              </span>
            )}
          </div>
          <div className="mt-1.5 text-[14.5px] font-extrabold text-ff-ink">{p.title}</div>
          <div className="mt-0.5 text-[13px] leading-[1.4] text-ff-muted">{p.detail}</div>
          {when && <div className="mt-1.5 text-[11.5px] text-ff-muted-2">{when}</div>}
        </div>
        {(p.tenantId || canResolve) && (
          <div className="flex shrink-0 items-center gap-2">
            {canResolve && (
              <button
                type="button"
                onClick={() => void resolve()}
                disabled={resolving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ff-green-100 bg-ff-green-50 px-3 py-1.5 text-[13px] font-bold text-ff-green-700 hover:brightness-95 disabled:opacity-60"
              >
                <CircleCheck size={14} /> {resolving ? 'Маркиране…' : 'Маркирай като оправено'}
              </button>
            )}
            {p.tenantId && <EnterPanelButton tenantId={p.tenantId} />}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProblemsClient() {
  const [data, setData] = useState<ProblemsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getProblems();
      setData(res);
      setFailed(false);
    } catch (e) {
      setFailed(true);
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно зареждане на проблемите');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = data?.items ?? [];

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Проблеми</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            Обединен, приоритизиран поток — сървърни грешки, ферми за внимание, заседнали пратки.
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
        <div className="mt-5 flex flex-col gap-2.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[92px] animate-pulse rounded-xl border border-ff-border bg-ff-surface-2 shadow-ff-sm"
            />
          ))}
        </div>
      ) : failed && !data ? (
        <div className="mt-5 rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-sm text-ff-muted shadow-ff-sm">
          Неуспешно зареждане на проблемите. Опитай да презаредиш.
        </div>
      ) : items.length === 0 ? (
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-ff-green-100 bg-ff-green-50 px-5 py-5 shadow-ff-sm">
          <CheckCircle2 size={22} className="text-ff-green-700" />
          <div className="text-[14px] font-semibold text-ff-green-800">Няма активни проблеми 🎉</div>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-2.5">
          {items.map((p, i) => (
            <ProblemRow key={`${p.kind}-${p.tenantId ?? 'platform'}-${i}`} p={p} onResolved={() => void load()} />
          ))}
        </div>
      )}

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
