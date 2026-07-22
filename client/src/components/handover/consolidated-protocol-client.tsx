'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DateNavBar } from '@/components/production/date-nav-bar';
import { relDayLabel, todayIso } from '@/lib/utils';
import {
  ApiError,
  ensureConsolidatedProtocol,
  getConsolidatedCourierRecipients,
  listConsolidatedProtocols,
  sendConsolidatedToCouriers,
} from '@/lib/api-client';
import type { ConsolidatedCourierRecipient, ConsolidatedProtocolSummary } from '@/lib/types';
import { courierRecipientLine, sendableCourierCount, sendResultSummary } from './consolidated-protocol-couriers';

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

  // §4.4 "Прати на куриерите" — button-triggered, NEVER automatic (the route
  // reorders until the last minute). `recipients: null` = dialog closed;
  // fetched fresh every time the button opens it so a same-page assignment
  // change is reflected before anything sends.
  const [recipients, setRecipients] = useState<ConsolidatedCourierRecipient[] | null>(null);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [sending, setSending] = useState(false);

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

  async function openSendDialog() {
    setLoadingRecipients(true);
    try {
      setRecipients(await getConsolidatedCourierRecipients(date));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoadingRecipients(false);
    }
  }

  async function confirmSend() {
    setSending(true);
    try {
      const report = await sendConsolidatedToCouriers(date);
      toast.success(sendResultSummary(report));
      setRecipients(null);
      void load(date); // ensureDraft may have just materialized fresh rows
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <DateNavBar date={date} dateLabel={relDayLabel(date)} onSelect={setDate} />
        <Button
          variant="ghost"
          size="sm"
          disabled={loadingRecipients}
          onClick={() => void openSendDialog()}
          className="gap-1.5"
        >
          <Send size={14} /> Прати на куриерите
        </Button>
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

      {recipients && (
        <ConfirmDialog
          title="Прати обобщения протокол на куриерите"
          confirmLabel={sending ? 'Изпращане…' : `Прати (${sendableCourierCount(recipients)})`}
          busy={sending}
          onConfirm={() => void confirmSend()}
          onCancel={() => setRecipients(null)}
          message={
            recipients.length === 0 ? (
              <p>Няма зачислени куриери за тази дата.</p>
            ) : (
              <>
                <p className="mb-2">
                  Всеки куриер получава ПО ИМЕЙЛ само своя собствен курс — никога целия ден или чужд курс.
                </p>
                <ul className="flex flex-col gap-1">
                  {recipients.map((r) => (
                    <li key={r.legIndex} className={r.email ? undefined : 'text-ff-red'}>
                      {courierRecipientLine(r)}
                    </li>
                  ))}
                </ul>
              </>
            )
          }
        />
      )}
    </div>
  );
}
