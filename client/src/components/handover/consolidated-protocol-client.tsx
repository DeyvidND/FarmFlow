'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DateNavBar } from '@/components/production/date-nav-bar';
import { relDayLabel, todayIso } from '@/lib/utils';
import { ApiError, ensureConsolidatedProtocol, listConsolidatedProtocols } from '@/lib/api-client';
import type { ConsolidatedProtocolSummary } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** "Целия ден" for the day-scope row, "Лег N" (1-based) for a leg row. Pure —
 *  unit-tested directly (no component render needed for this piece). */
export function legLabel(row: Pick<ConsolidatedProtocolSummary, 'scope' | 'legIndex'>): string {
  return row.scope === 'day' ? 'Целия ден' : `Лег ${(row.legIndex ?? 0) + 1}`;
}

const STATUS_LABEL: Record<string, string> = { draft: 'Чернова', signed: 'Подписан' };

/**
 * «Обобщени протоколи» — the day/leg consolidated-protocol list screen. One
 * card per `ConsolidatedProtocolSummary` (day row first, then legs sorted by
 * `legIndex` — the order the API already returns them in). "Отвори"
 * navigates directly for a materialized row; "Създай" first calls
 * `ensureConsolidatedProtocol` for a virtual (id=null) row, then navigates.
 */
export function ConsolidatedProtocolClient() {
  const router = useRouter();
  const [date, setDate] = useState(() => todayIso());
  const [rows, setRows] = useState<ConsolidatedProtocolSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    try {
      setRows(await listConsolidatedProtocols(d));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  async function open(row: ConsolidatedProtocolSummary) {
    const key = `${row.scope}:${row.legIndex ?? 'day'}`;
    setOpeningKey(key);
    try {
      const id = row.id ?? (await ensureConsolidatedProtocol({ date, scope: row.scope, legIndex: row.legIndex ?? undefined })).id;
      router.push(`/protocols/consolidated/${id}`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setOpeningKey(null);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <DateNavBar date={date} dateLabel={relDayLabel(date)} onSelect={setDate} />
      </div>

      <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="text-[15px] font-extrabold">Обобщени протоколи</h2>
        </div>
        {rows.map((row) => {
          const key = `${row.scope}:${row.legIndex ?? 'day'}`;
          return (
            <div
              key={key}
              className="flex items-center justify-between border-b border-ff-border-2 px-5 py-3.5 last:border-0"
            >
              <div>
                <div className="text-[14px] font-bold">{legLabel(row)}</div>
                <div className="text-[12px] text-ff-muted">
                  {row.docNumber != null ? `ОБ-${row.docNumber}` : 'Все още не е отворен'}
                  {row.status && ` · ${STATUS_LABEL[row.status] ?? row.status}`}
                </div>
              </div>
              <Button size="sm" disabled={openingKey === key} onClick={() => void open(row)}>
                {row.id ? 'Отвори' : 'Създай'}
              </Button>
            </div>
          );
        })}
        {!loading && rows.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-ff-muted">Няма курсове за тази дата.</p>
        )}
      </div>
    </div>
  );
}
