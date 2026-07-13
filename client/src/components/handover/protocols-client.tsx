'use client';

import { useCallback, useEffect, useState } from 'react';
import { Printer, FileDown, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DateNavBar } from '@/components/production/date-nav-bar';
import { relDayLabel, todayIso } from '@/lib/utils';
import {
  ApiError,
  createProtocolBatch,
  listProtocols,
  markProtocolSigned,
  protocolBatchPdfHref,
  protocolPdfHref,
} from '@/lib/api-client';
import type { ProtocolRow } from '@/lib/types';
import { ProtocolDialog } from './protocol-dialog';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const STATUS_LABEL: Record<string, string> = {
  draft: 'Чернова',
  signed: 'Подписан',
};
const KIND_LABEL: Record<string, string> = {
  farmer_to_operator: 'От фермер',
  operator_to_customer: 'До клиент',
};

/** Which party's name to show for a row — the counterpart in the handover
 *  (the farmer for a pickup leg, the customer for a delivery leg). */
const partyName = (row: ProtocolRow) =>
  (row.kind === 'farmer_to_operator' ? row.fromSnapshot?.name : row.toSnapshot?.name) ?? '—';

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={
        status === 'signed'
          ? 'inline-flex items-center rounded-full bg-ff-green-50 px-2.5 py-0.5 text-[12px] font-bold text-ff-green-700'
          : 'inline-flex items-center rounded-full bg-ff-surface-2 px-2.5 py-0.5 text-[12px] font-semibold text-ff-muted-2'
      }
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * «Протоколи за деня» — the daily handover-protocol screen: batch-print every
 * protocol for the day, sign a farmer pickup digitally, or mark any pending
 * protocol signed on paper.
 *
 * Data-source note: there is no dedicated endpoint for "farmers with orders
 * today, independent of any protocol" — the farmer-pickup list below is driven
 * by `listProtocols({ date, kind: 'farmer_to_operator' })`, so a farmer only
 * appears once a protocol row exists for them that day (created by «Печат за
 * деня», which batch-creates one draft per farmer/order before printing). This
 * mirrors the source data the batch-print endpoint itself uses server-side.
 */
export function ProtocolsClient() {
  const [date, setDate] = useState(() => todayIso());
  const [rows, setRows] = useState<ProtocolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [signTarget, setSignTarget] = useState<{ farmerId: string; slotId: string } | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const res = await listProtocols({ date: d });
      setRows(res);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  async function printDay() {
    setPrinting(true);
    try {
      const { ids, skipped } = await createProtocolBatch({ date });
      if (skipped.length > 0) {
        const reasons = [...new Set(skipped.map((s) => s.reason))].join(' ');
        toast.warning(`${skipped.length} протокол(а) не са генерирани — ${reasons}`);
      }
      if (ids.length > 0 || rows.length > 0) {
        window.open(protocolBatchPdfHref({ date }), '_blank', 'noopener');
      }
      await load(date);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setPrinting(false);
    }
  }

  async function markSigned(id: string) {
    setMarkingId(id);
    try {
      await markProtocolSigned(id);
      toast.success('Протоколът е маркиран като подписан');
      await load(date);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setMarkingId(null);
    }
  }

  const farmerRows = rows.filter((r) => r.kind === 'farmer_to_operator');

  return (
    <div className="animate-ff-fade-up">
      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="max-[680px]:w-full">
          <DateNavBar date={date} dateLabel={relDayLabel(date)} onSelect={setDate} />
        </div>
        <Button onClick={() => void printDay()} disabled={printing} className="max-[680px]:w-full">
          <Printer size={17} /> {printing ? 'Подготвяне…' : 'Печат за деня'}
        </Button>
      </div>

      {/* farmer pickups */}
      <div className="mb-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="text-[15px] font-extrabold">Прибиране от фермери</h2>
        </div>

        {/* table (desktop) */}
        <table className="w-full border-collapse max-[680px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Фермер', 'Статус'].map((h) => (
                <th key={h} className="px-5 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                  {h}
                </th>
              ))}
              <th className="px-5 py-3 text-right text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                Действия
              </th>
            </tr>
          </thead>
          <tbody>
            {farmerRows.map((row) => (
              <tr key={row.id} className="border-b border-ff-border-2 last:border-0">
                <td className="px-5 py-3.5 align-top text-[14px] font-bold">{partyName(row)}</td>
                <td className="px-5 py-3.5 align-top">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-5 py-3.5 text-right align-top">
                  <div className="flex justify-end gap-2">
                    {row.status !== 'signed' && row.farmerId && row.slotId && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSignTarget({ farmerId: row.farmerId!, slotId: row.slotId! })}
                        >
                          Подпиши дигитално
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={markingId === row.id}
                          onClick={() => void markSigned(row.id)}
                        >
                          <Check size={15} /> Хартия
                        </Button>
                      </>
                    )}
                    <Button variant="ghost" size="sm" asChild>
                      <a href={protocolPdfHref(row.id)} target="_blank" rel="noopener noreferrer">
                        <FileDown size={15} /> PDF
                      </a>
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* cards (mobile) */}
        <div className="hidden flex-col max-[680px]:flex">
          {farmerRows.map((row) => (
            <div key={row.id} className="flex flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 last:border-0">
              <div className="flex items-center justify-between gap-2.5">
                <span className="text-[14.5px] font-extrabold">{partyName(row)}</span>
                <StatusPill status={row.status} />
              </div>
              <div className="flex flex-wrap gap-2">
                {row.status !== 'signed' && row.farmerId && row.slotId && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSignTarget({ farmerId: row.farmerId!, slotId: row.slotId! })}
                    >
                      Подпиши дигитално
                    </Button>
                    <Button variant="ghost" size="sm" disabled={markingId === row.id} onClick={() => void markSigned(row.id)}>
                      <Check size={15} /> Хартия
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" asChild>
                  <a href={protocolPdfHref(row.id)} target="_blank" rel="noopener noreferrer">
                    <FileDown size={15} /> PDF
                  </a>
                </Button>
              </div>
            </div>
          ))}
        </div>

        {!loading && farmerRows.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-ff-muted">
            Все още няма протоколи за фермери за тази дата. Натисни „Печат за деня“, за да ги генерираш.
          </p>
        )}
      </div>

      {/* all protocols for the day */}
      <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="text-[15px] font-extrabold">Всички протоколи за деня</h2>
        </div>

        {/* table (desktop) */}
        <table className="w-full border-collapse max-[680px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Вид', 'Страна', 'Статус'].map((h) => (
                <th key={h} className="px-5 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                  {h}
                </th>
              ))}
              <th className="px-5 py-3 text-right text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                Действия
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-ff-border-2 last:border-0">
                <td className="px-5 py-3.5 align-top text-[13.5px] font-semibold text-ff-ink-2">
                  {KIND_LABEL[row.kind] ?? row.kind}
                </td>
                <td className="px-5 py-3.5 align-top text-[14px] font-bold">{partyName(row)}</td>
                <td className="px-5 py-3.5 align-top">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-5 py-3.5 text-right align-top">
                  <div className="flex justify-end gap-2">
                    {row.status !== 'signed' && (
                      <Button variant="ghost" size="sm" disabled={markingId === row.id} onClick={() => void markSigned(row.id)}>
                        <Check size={15} /> Маркирай подписан (хартия)
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" asChild>
                      <a href={protocolPdfHref(row.id)} target="_blank" rel="noopener noreferrer">
                        <FileDown size={15} /> Свали PDF
                      </a>
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* cards (mobile) */}
        <div className="hidden flex-col max-[680px]:flex">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 last:border-0">
              <div className="flex items-center justify-between gap-2.5">
                <div>
                  <div className="text-[14.5px] font-extrabold">{partyName(row)}</div>
                  <div className="text-[12px] text-ff-muted">{KIND_LABEL[row.kind] ?? row.kind}</div>
                </div>
                <StatusPill status={row.status} />
              </div>
              <div className="flex flex-wrap gap-2">
                {row.status !== 'signed' && (
                  <Button variant="ghost" size="sm" disabled={markingId === row.id} onClick={() => void markSigned(row.id)}>
                    <Check size={15} /> Хартия
                  </Button>
                )}
                <Button variant="ghost" size="sm" asChild>
                  <a href={protocolPdfHref(row.id)} target="_blank" rel="noopener noreferrer">
                    <FileDown size={15} /> PDF
                  </a>
                </Button>
              </div>
            </div>
          ))}
        </div>

        {!loading && rows.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-ff-muted">Няма протоколи за тази дата.</p>
        )}
      </div>

      {signTarget && (
        <ProtocolDialog
          kind="farmer_to_operator"
          farmerId={signTarget.farmerId}
          slotId={signTarget.slotId}
          onClose={() => {
            setSignTarget(null);
            void load(date);
          }}
        />
      )}
    </div>
  );
}
