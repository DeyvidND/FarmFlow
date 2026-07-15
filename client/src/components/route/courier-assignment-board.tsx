'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Truck, UserRound, X } from 'lucide-react';
import { getRouteAssignments, listRouteCouriers, setRouteAssignments } from '@/lib/api-client';
import type { RouteAssignment, RouteCourier } from '@/lib/types';
import { assignmentErrorMessage } from './courier-assignment';

const UNASSIGNED = '__unassigned__';

/**
 * Per-day leg board (Task C2, spec §4). Lists the tenant's courier roster
 * (drivers + the farmer's own account, via `listRouteCouriers` — Task C1/A2)
 * for the currently selected route date and lets the farmer pick which
 * accounts work today and which leg each one takes. Each row change persists
 * immediately as a whole-day replace (`PUT orders/route/assignments`,
 * `CourierAssignmentService.setAssignmentsForDay`) — there is no separate
 * "Save" step.
 *
 * Precedence with the couriers-count dropdown (spec §4.2) is decided by the
 * PARENT (`route-client.tsx`) via `deriveLegCount`/`isBoardActive` from
 * `./courier-assignment` — this component only reads/writes the board itself
 * and reports every successful save upward via `onChanged` so the parent can
 * react (hide the dropdown, refetch the split) without waiting for a full
 * page reload.
 */
export function CourierAssignmentBoard({
  date,
  onClose,
  onChanged,
}: {
  date: string;
  onClose: () => void;
  /** Fires after every successful save with the freshly persisted board. */
  onChanged: (assignments: RouteAssignment[]) => void;
}) {
  const [couriers, setCouriers] = useState<RouteCourier[]>([]);
  const [assignments, setAssignments] = useState<RouteAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([listRouteCouriers(), getRouteAssignments(date)])
      .then(([c, a]) => {
        if (cancelled) return;
        setCouriers(c);
        setAssignments(a);
      })
      .catch(() => {
        /* roster/board failed to load — the row list just stays empty; the
         * farmer can retry by reopening the modal. */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const legByAccount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments) m.set(a.accountId, a.legIndex);
    return m;
  }, [assignments]);

  // As many leg slots as there are roster entries — an account can't be
  // assigned to a leg with no possible driver.
  const legOptions = Math.max(couriers.length, 1);

  const setLeg = async (accountId: string, rawValue: string) => {
    const prevAssignments = assignments;
    const nextAssignments =
      rawValue === UNASSIGNED
        ? assignments.filter((a) => a.accountId !== accountId)
        : [
            ...assignments.filter((a) => a.accountId !== accountId),
            { accountId, legIndex: parseInt(rawValue, 10) },
          ];
    setRowErrors((cur) => {
      if (!(accountId in cur)) return cur;
      const next = { ...cur };
      delete next[accountId];
      return next;
    });
    setSavingId(accountId);
    try {
      const saved = await setRouteAssignments(date, nextAssignments);
      setAssignments(saved);
      onChanged(saved);
    } catch (err) {
      // Revert to the last known-good board — a 409 double-book (or any
      // other failure) must not leave the UI showing a value that wasn't
      // actually persisted.
      setAssignments(prevAssignments);
      setRowErrors((cur) => ({ ...cur, [accountId]: assignmentErrorMessage(err) }));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Куриери за деня"
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <Truck size={17} /> Куриери за деня
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <p className="border-b border-ff-border-2 bg-ff-surface-2 px-5 py-2.5 text-[12.5px] leading-relaxed text-ff-muted">
          Избери кой доставя днес и кой курс кара — включително себе си, за ден в който караш сам. Щом
          зададеш поне един куриер тук, броят „Куриери“ горе спира да важи — таблото решава колко курса
          има днес.
        </p>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="py-6 text-center text-[13px] text-ff-muted">Зареждане…</p>
          ) : couriers.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ff-muted">
              Все още няма създадени акаунти за куриери. Свържи се с платформата, за да поканиш куриер.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {couriers.map((c) => {
                const leg = legByAccount.get(c.accountId);
                const value = leg == null ? UNASSIGNED : String(leg);
                const rowError = rowErrors[c.accountId];
                const busy = savingId === c.accountId;
                return (
                  <li key={c.accountId} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[13px] font-bold text-ff-ink-2">
                        <UserRound size={14} className="shrink-0 text-ff-muted" />
                        {c.email}
                        {c.isSelf && (
                          <span className="font-normal text-ff-muted">(Аз — собствена доставка)</span>
                        )}
                      </span>
                      <div className="flex items-center gap-2">
                        {busy && <Loader2 size={14} className="animate-spin text-ff-muted" />}
                        <select
                          value={value}
                          disabled={busy}
                          onChange={(e) => void setLeg(c.accountId, e.target.value)}
                          aria-label={`Курс за ${c.email}`}
                          className="rounded-md border border-ff-border bg-ff-surface-2 px-2 py-1 text-[13px] font-bold text-ff-ink outline-none disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <option value={UNASSIGNED}>не участва днес</option>
                          {Array.from({ length: legOptions }, (_, i) => i).map((i) => (
                            <option key={i} value={i}>
                              Курс {i + 1}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {rowError && <p className="text-[12px] font-bold text-red-600">{rowError}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
