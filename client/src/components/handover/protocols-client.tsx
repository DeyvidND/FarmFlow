'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Printer, FileDown, Check, CheckCheck, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DateNavBar } from '@/components/production/date-nav-bar';
import { relDayLabel, todayIso } from '@/lib/utils';
import {
  ApiError,
  createProtocol,
  createProtocolBatch,
  ensureProtocolDraft,
  getFarmerSignature,
  getOperatorSignature,
  getProtocolDraft,
  listDayProtocols,
  markProtocolSigned,
  protocolBatchPdfHref,
  protocolPdfHref,
  signAllProtocols,
  signProtocolPaper,
} from '@/lib/api-client';
import type { DayProtocolRow } from '@/lib/types';
import { ProtocolDialog } from './protocol-dialog';
import { FarmerReadinessBoard } from './farmer-readiness-board';

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
const partyName = (row: DayProtocolRow) =>
  (row.kind === 'farmer_to_operator' ? row.fromSnapshot?.name : row.toSnapshot?.name) ?? '—';

/** Stable key for a row — its id, or a target key for a virtual (unsaved) row. */
const rowKey = (r: DayProtocolRow) => r.id ?? `${r.kind}:${r.farmerId ?? r.orderId}:${r.slotId ?? ''}`;

const targetOf = (r: DayProtocolRow) => ({
  kind: r.kind,
  farmerId: r.farmerId ?? undefined,
  orderId: r.orderId ?? undefined,
  slotId: r.slotId ?? undefined,
});

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
 * Data source: `listDayProtocols({ date })` returns a LIVE view — every
 * handover-ready farmer pickup and customer delivery for the day, whether or not
 * a protocol row has been created yet. Virtual (not-yet-created) rows come back
 * with `id: null`; a row + its number are created only when printed or signed. So
 * the screen is populated without «Печат за деня» first.
 */
export function ProtocolsClient() {
  const [date, setDate] = useState(() => todayIso());
  const [rows, setRows] = useState<DayProtocolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'farmers' | 'orders' | 'signall'>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [signTarget, setSignTarget] = useState<{ farmerId: string; slotId: string } | null>(null);
  // The operator's saved signature is the same for every row on this screen —
  // fetch it once and reuse instead of re-fetching per quick-sign tap.
  const operatorSigCache = useRef<{ fetched: boolean; value: string | null }>({ fetched: false, value: null });

  const load = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const res = await listDayProtocols({ date: d });
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

  // Create + print one leg's protocols for the day. Only opens the merged PDF if
  // that leg actually has rows (avoids a 400 «Няма протоколи» tab).
  async function printKind(kind: 'farmer_to_operator' | 'operator_to_customer') {
    const has = rows.some((r) => r.kind === kind);
    setBusy(kind === 'farmer_to_operator' ? 'farmers' : 'orders');
    try {
      const { skipped } = await createProtocolBatch({ date, kind });
      if (skipped.length > 0) {
        const reasons = [...new Set(skipped.map((s) => s.reason))].join(' ');
        toast.warning(`${skipped.length} протокол(а) не са генерирани — ${reasons}`);
      }
      if (has) window.open(protocolBatchPdfHref({ date, kind }), '_blank', 'noopener');
      else toast.info('Няма протоколи за печат за тази дата.');
      await load(date);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function signAll() {
    if (!window.confirm('Да отбележа ли всички протоколи за деня като подписани (на хартия)?')) return;
    setBusy('signall');
    try {
      const { signed } = await signAllProtocols({ date });
      toast.success(`${signed} протокол(а) отбелязани като подписани`);
      await load(date);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  // Paper-sign a row: a saved row flips by id; a virtual row is created + numbered
  // + signed in one call (signProtocolPaper).
  async function markSigned(row: DayProtocolRow) {
    setMarkingId(rowKey(row));
    try {
      if (row.id) await markProtocolSigned(row.id);
      else await signProtocolPaper(targetOf(row));
      toast.success('Протоколът е маркиран като подписан');
      await load(date);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setMarkingId(null);
    }
  }

  async function getOperatorSigCached() {
    if (!operatorSigCache.current.fetched) {
      const { signaturePng } = await getOperatorSignature();
      operatorSigCache.current = { fetched: true, value: signaturePng };
    }
    return operatorSigCache.current.value;
  }

  // One-tap sign a farmer leg: if BOTH the farmer's and the operator's saved
  // signatures exist, sign immediately by posting with the signature keys
  // OMITTED (the server auto-fills the saved, encrypted signatures — an
  // explicit null instead means "no signature", which is a different thing).
  // Otherwise fall back to the draw dialog and explain why.
  async function quickSign(row: DayProtocolRow) {
    if (!row.farmerId || !row.slotId) return;
    if (markingId) return; // a sign/mark action is already in flight — ignore the extra tap
    const farmerId = row.farmerId;
    const slotId = row.slotId;
    const key = rowKey(row);
    setMarkingId(key);
    try {
      const [farmerSig, operatorSignaturePng] = await Promise.all([
        getFarmerSignature(farmerId),
        getOperatorSigCached(),
      ]);
      if (!farmerSig.signaturePng || !operatorSignaturePng) {
        toast.info(
          'Няма запазени подписи за подписване с едно докосване — запишете подпис в профила на фермера и в настройките на оператора.',
        );
        setSignTarget({ farmerId, slotId });
        return;
      }
      const draft = await getProtocolDraft({ kind: 'farmer_to_operator', farmerId, slotId });
      const res = await createProtocol({
        kind: 'farmer_to_operator',
        farmerId,
        slotId,
        items: draft.items,
        meta: {},
        // fromSignaturePng / toSignaturePng intentionally OMITTED — server auto-fills saved signatures
      });
      toast.success(`Протокол № ${res.protocolNumber} подписан`);
      await load(date);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setMarkingId(null);
    }
  }

  // Open a row's PDF. A saved row streams its stored (numbered) PDF directly. A
  // virtual row is first materialized into a numbered draft (ensureProtocolDraft)
  // so the PDF prints WITH a protocol number — a blank tab is opened synchronously
  // (before the await) so the pop-up isn't blocked, then pointed at the PDF.
  async function openPdf(row: DayProtocolRow) {
    if (row.id) {
      window.open(protocolPdfHref(row.id), '_blank', 'noopener');
      return;
    }
    const tab = window.open('', '_blank');
    try {
      const { id } = await ensureProtocolDraft(targetOf(row));
      if (tab) tab.location.href = protocolPdfHref(id);
      else window.open(protocolPdfHref(id), '_blank', 'noopener');
      await load(date);
    } catch (e) {
      if (tab) tab.close();
      toast.error(errMsg(e));
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
        <div className="flex flex-wrap gap-2 max-[680px]:w-full">
          <a
            href="/protocols/check"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ff-ink px-3.5 py-2 text-[13.5px] font-bold text-white max-[680px]:w-full"
          >
            <ShieldCheck size={16} /> Проверка
          </a>
          <a
            href="/protocols/consolidated"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-ff-border px-3.5 py-2 text-[13.5px] font-bold text-ff-ink-2 max-[680px]:w-full"
          >
            Обобщен протокол
          </a>
          <Button
            variant="outline"
            onClick={() => void printKind('farmer_to_operator')}
            disabled={busy !== null}
            className="max-[680px]:flex-1"
          >
            <Printer size={16} /> {busy === 'farmers' ? 'Подготвяне…' : 'Печат фермери'}
          </Button>
          <Button
            variant="outline"
            onClick={() => void printKind('operator_to_customer')}
            disabled={busy !== null}
            className="max-[680px]:flex-1"
          >
            <Printer size={16} /> {busy === 'orders' ? 'Подготвяне…' : 'Печат поръчки'}
          </Button>
          <Button onClick={() => void signAll()} disabled={busy !== null} className="max-[680px]:w-full">
            <CheckCheck size={16} /> {busy === 'signall' ? 'Подписване…' : 'Отбележи всички подписани'}
          </Button>
        </div>
      </div>

      {/* farmer protocol readiness — advisory only, spec §5.2/§5.3 */}
      <FarmerReadinessBoard />

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
              <tr key={rowKey(row)} className="border-b border-ff-border-2 last:border-0">
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
                          disabled={markingId === rowKey(row)}
                          onClick={() => void quickSign(row)}
                        >
                          Подпиши дигитално
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={markingId === rowKey(row)}
                          onClick={() => void markSigned(row)}
                        >
                          <Check size={15} /> Хартия
                        </Button>
                      </>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void openPdf(row)}>
                      <FileDown size={15} /> PDF
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
            <div key={rowKey(row)} className="flex flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 last:border-0">
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
                      disabled={markingId === rowKey(row)}
                      onClick={() => void quickSign(row)}
                    >
                      Подпиши дигитално
                    </Button>
                    <Button variant="ghost" size="sm" disabled={markingId === rowKey(row)} onClick={() => void markSigned(row)}>
                      <Check size={15} /> Хартия
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={() => void openPdf(row)}>
                      <FileDown size={15} /> PDF
                    </Button>
              </div>
            </div>
          ))}
        </div>

        {!loading && farmerRows.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-ff-muted">
            Няма прибирания от фермери за тази дата.
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
              {['№', 'Вид', 'Страна', 'Поръчки', 'Статус'].map((h) => (
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
              <tr key={rowKey(row)} className="border-b border-ff-border-2 last:border-0">
                <td className="px-5 py-3.5 align-top text-[13.5px] font-semibold text-ff-ink-2">
                  {row.protocolNumber ?? '—'}
                </td>
                <td className="px-5 py-3.5 align-top text-[13.5px] font-semibold text-ff-ink-2">
                  {KIND_LABEL[row.kind] ?? row.kind}
                </td>
                <td className="px-5 py-3.5 align-top text-[14px] font-bold">{partyName(row)}</td>
                <td className="px-5 py-3.5 align-top text-[13.5px] text-ff-ink-2">{row.orderCount}</td>
                <td className="px-5 py-3.5 align-top">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-5 py-3.5 text-right align-top">
                  <div className="flex justify-end gap-2">
                    {row.status !== 'signed' && (
                      <Button variant="ghost" size="sm" disabled={markingId === rowKey(row)} onClick={() => void markSigned(row)}>
                        <Check size={15} /> Маркирай подписан (хартия)
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void openPdf(row)}>
                      <FileDown size={15} /> Свали PDF
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
            <div key={rowKey(row)} className="flex flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 last:border-0">
              <div className="flex items-center justify-between gap-2.5">
                <div>
                  <div className="text-[14.5px] font-extrabold">{partyName(row)}</div>
                  <div className="text-[12px] text-ff-muted">
                    {KIND_LABEL[row.kind] ?? row.kind} · № {row.protocolNumber ?? '—'} · {row.orderCount} поръчки
                  </div>
                </div>
                <StatusPill status={row.status} />
              </div>
              <div className="flex flex-wrap gap-2">
                {row.status !== 'signed' && (
                  <Button variant="ghost" size="sm" disabled={markingId === rowKey(row)} onClick={() => void markSigned(row)}>
                    <Check size={15} /> Хартия
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => void openPdf(row)}>
                      <FileDown size={15} /> PDF
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
