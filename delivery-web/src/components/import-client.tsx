'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { UploadCloud, FileDown, Download, FileSpreadsheet, ListChecks, Scale } from 'lucide-react';
import {
  ApiError, uploadBatch, patchRow, deleteRow, commitBatch, downloadLabels, templateUrl, compareShipment,
  type ImportRow, type QuoteResult,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const priceEur = (st: number | null | undefined) => (st == null ? '—' : `${(st / 100).toFixed(2)} €`);

const STEPS = [
  { icon: Download, title: 'Свали шаблона', desc: 'Готов Excel/CSV с правилните колони.' },
  { icon: UploadCloud, title: 'Качи файла', desc: 'Само файлът — без настройки. Системата чете редовете.' },
  { icon: ListChecks, title: 'Поправи редовете', desc: 'Маркираните в жълто/червено се редактират на място.' },
  { icon: Scale, title: 'Сравни и създай', desc: 'Избери най-евтиния куриер за всеки ред и създай пратките.' },
] as const;

export function ImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [ai, setAi] = useState('');
  const [busy, setBusy] = useState(false);
  // Per-row cheapest-quote results (carrier prices), keyed by row id.
  const [quotes, setQuotes] = useState<Record<string, QuoteResult>>({});
  const [comparing, setComparing] = useState(false);

  const count = (s: string) => rows.filter((r) => r.validationStatus === s).length;

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      // Carrier/currency/weight are no longer chosen up front — upload just the file.
      const data = await uploadBatch(file);
      setBatchId(data.batch.id);
      setRows(data.rows);
      setQuotes({});
      setAi(data.batch.aiReport?.aiAvailable ? '' : 'AI проверка недостъпна — само базова проверка.');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  async function save(r: ImportRow) {
    if (!batchId) return;
    try {
      const updated = await patchRow(batchId, r.id, {
        receiverName: r.receiverName, receiverPhone: r.receiverPhone, deliveryMode: r.deliveryMode,
        city: r.city, office: r.office, address: r.address, weightGrams: r.weightGrams,
        codAmountStotinki: r.codAmountStotinki, carrier: r.carrier,
      });
      // Merge only server-authoritative fields onto the LATEST local row so an
      // in-flight edit to another field (made while this save was pending) is kept.
      setRows((p) => p.map((x) => (x.id === r.id
        ? { ...x, validationStatus: updated.validationStatus, validation: updated.validation, shipmentId: updated.shipmentId }
        : x)));
    } catch (e) { toast.error(errMsg(e)); }
  }

  async function del(r: ImportRow) {
    if (!batchId) return;
    try { await deleteRow(batchId, r.id); setRows((p) => p.filter((x) => x.id !== r.id)); }
    catch (e) { toast.error(errMsg(e)); }
  }

  // Price both carriers for every committable row, then auto-pick the cheaper one.
  // Runs with a tiny concurrency pool to stay under the compare throttle (30/min).
  async function compareAll() {
    const targets = rows.filter((r) => r.validationStatus !== 'error' && r.city && r.deliveryMode && !r.shipmentId);
    if (!targets.length) { toast.error('Няма редове за сравнение — провери град и режим.'); return; }
    setComparing(true);
    const found: Record<string, QuoteResult> = {};
    const picks: Array<{ row: ImportRow; carrier: 'econt' | 'speedy' }> = [];
    let failed = 0;
    const queue = [...targets];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          const q = await compareShipment({
            destinationCity: r.city!, deliveryMode: r.deliveryMode!,
            weightGrams: r.weightGrams ?? undefined,
          });
          found[r.id] = q;
          if (q.cheapest && q.cheapest !== r.carrier) picks.push({ row: r, carrier: q.cheapest });
        } catch { failed++; }
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
      setQuotes((p) => ({ ...p, ...found }));
      // Optimistically reflect the cheaper carrier locally, then persist each pick.
      if (picks.length) {
        setRows((prev) => prev.map((x) => {
          const pick = picks.find((p) => p.row.id === x.id);
          return pick ? { ...x, carrier: pick.carrier } : x;
        }));
        for (const { row, carrier } of picks) await save({ ...row, carrier });
      }
      const done = Object.keys(found).length;
      toast.success(`Сравнени ${done} ${done === 1 ? 'ред' : 'реда'}${picks.length ? ` · ${picks.length} сменени на по-евтин` : ''}`);
      if (failed) toast.error(`${failed} реда не успяха да се сравнят.`);
    } finally { setComparing(false); }
  }

  async function commit() {
    if (!batchId) return;
    setBusy(true);
    try {
      const res = await commitBatch(batchId);
      const created = res.results.filter((x) => x.status === 'created').length;
      toast.success(`Създадени ${created} пратки`);
      if (res.failed) toast.error(`${res.failed} реда не успяха — виж „Проблеми".`);
      const { getBatch } = await import('@/lib/api-client');
      setRows((await getBatch(batchId)).rows);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  const labelIds = (carrier: 'econt' | 'speedy') => rows.filter((r) => r.shipmentId && r.carrier === carrier).map((r) => r.shipmentId!) as string[];

  async function labels(carrier: 'econt' | 'speedy') {
    try { await downloadLabels(carrier, labelIds(carrier)); }
    catch (e) { toast.error(errMsg(e)); }
  }

  function patch(r: ImportRow, k: keyof ImportRow, v: unknown) {
    setRows((p) => p.map((x) => (x.id === r.id ? { ...x, [k]: v } : x)));
  }

  // Price a single carrier from a row's quote result (null = unavailable / not priced).
  const carrierPrice = (q: QuoteResult | undefined, c: 'econt' | 'speedy') => {
    const entry = q?.quotes.find((x) => x.carrier === c);
    return entry && entry.available ? entry.priceStotinki : null;
  };

  const inp = 'w-full rounded-lg border border-ff-border bg-ff-surface px-2 py-1.5 text-[13.5px] outline-none focus:border-ff-green-500';
  const rowBg = (s: string) => (s === 'ok' ? 'bg-ff-green-50' : s === 'warn' ? 'bg-ff-amber-softer' : 'bg-[#FBE9E7]');
  const primaryBtn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60';
  const outlineBtn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-4 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2';

  // Per-row carrier price comparison, shown once "Сравни куриери" has run.
  const PriceCell = ({ r }: { r: ImportRow }) => {
    const q = quotes[r.id];
    if (!q) return <span className="text-ff-muted">—</span>;
    return (
      <div className="flex flex-col gap-0.5 text-[11.5px] leading-tight ff-fig">
        <span className={r.carrier === 'econt' ? 'font-extrabold text-ff-green-700' : 'text-ff-muted'}>Еконт {priceEur(carrierPrice(q, 'econt'))}</span>
        <span className={r.carrier === 'speedy' ? 'font-extrabold text-ff-green-700' : 'text-ff-muted'}>Спиди {priceEur(carrierPrice(q, 'speedy'))}</span>
      </div>
    );
  };

  return (
    <div className="animate-ff-fade-up">
      <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Масов внос на пратки</h1>
      <p className="mt-1 text-[13.5px] text-ff-muted">Качи Excel или CSV с поръчки. Куриерът се избира накрая — по най-добра цена.</p>

      {/* guide — hidden once a file is loaded into the editor */}
      {rows.length === 0 && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex items-start gap-3 rounded-xl border border-ff-border bg-ff-surface p-3.5 shadow-ff-sm">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[14px] font-extrabold text-white">{i + 1}</div>
              <div>
                <div className="flex items-center gap-1.5 text-[13.5px] font-bold text-ff-ink">
                  <s.icon size={15} className="text-ff-green-600" /> {s.title}
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-ff-muted">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* upload card — file only */}
      {rows.length === 0 && (
        <div className="mt-5 rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-4 shadow-ff-sm">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ff-border bg-ff-surface-2 px-4 py-8 text-center transition-colors hover:border-ff-green-500 hover:bg-ff-green-50">
            <UploadCloud size={28} className="text-ff-muted-2" />
            <div className="text-[14px] font-bold text-ff-ink-2">{file ? file.name : 'Избери Excel или CSV файл'}</div>
            <div className="text-[12px] text-ff-muted">{file ? 'Натисни „Качи и провери", за да продължиш' : 'Поддържани формати: .xlsx, .csv'}</div>
            <input className="hidden" type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <button onClick={upload} disabled={!file || busy} className={primaryBtn}>
              <UploadCloud size={16} /> {busy ? 'Качвам…' : 'Качи и провери'}
            </button>
            <a href={templateUrl} className={outlineBtn}>
              <FileDown size={16} /> Свали шаблон
            </a>
          </div>
        </div>
      )}
      {ai && rows.length === 0 && <p className="mt-2 text-[12.5px] text-ff-amber-600">{ai}</p>}

      {rows.length > 0 && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-ff-border bg-ff-surface p-3 shadow-ff-sm">
            <span className="mr-1 ff-fig text-[12.5px] font-bold text-ff-ink-2">{rows.length} реда</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-green-50 px-2.5 py-1 text-[12.5px] font-bold text-ff-green-700"><span className="h-2 w-2 rounded-full bg-ff-green-500" /> Готови {count('ok')}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-amber-softer px-2.5 py-1 text-[12.5px] font-bold text-ff-amber-600"><span className="h-2 w-2 rounded-full bg-ff-amber" /> Внимание {count('warn')}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FBE9E7] px-2.5 py-1 text-[12.5px] font-bold text-ff-red"><span className="h-2 w-2 rounded-full bg-ff-red" /> Грешка {count('error')}</span>
            <button onClick={() => void compareAll()} disabled={comparing || busy} className="ml-auto inline-flex h-10 items-center gap-2 rounded-xl border border-ff-green-600 bg-ff-green-50 px-3.5 text-[13px] font-bold text-ff-green-700 hover:bg-ff-green-100 disabled:opacity-60">
              <Scale size={15} /> {comparing ? 'Сравнявам…' : 'Сравни куриери'}
            </button>
            <button onClick={commit} disabled={busy || comparing} className="inline-flex h-10 items-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60">{busy ? 'Създавам…' : 'Създай пратки'}</button>
            {labelIds('econt').length > 0 && <button onClick={() => void labels('econt')} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"><FileDown size={15} /> Етикети (Econt)</button>}
            {labelIds('speedy').length > 0 && <button onClick={() => void labels('speedy')} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"><FileDown size={15} /> Етикети (Speedy)</button>}
          </div>
          <p className="mt-2 text-[12px] text-ff-muted">„Сравни куриери" пита Еконт и Спиди за цена на всеки ред и слага по-евтиния — после може ръчно да смениш куриера в колоната.</p>

          {/* desktop table */}
          <div className="mt-3 overflow-x-auto rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:hidden">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {['#', 'Получател', 'Телефон', 'Реж.', 'Град', 'Офис/Адрес', 'Тегло(г)', 'НП(ст.)', 'Цена', 'Куриер', 'Проблеми', ''].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-ff-border-2 last:border-0 ${rowBg(r.validationStatus)}`}>
                    <td className="px-3 py-2">{r.rowIndex}</td>
                    <td className="px-3 py-2"><input className={inp} value={r.receiverName ?? ''} onChange={(e) => patch(r, 'receiverName', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><input className={inp} value={r.receiverPhone ?? ''} onChange={(e) => patch(r, 'receiverPhone', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><select className={inp} value={r.deliveryMode ?? 'office'} onChange={(e) => { patch(r, 'deliveryMode', e.target.value); }} onBlur={() => save(r)}><option value="office">офис</option><option value="address">адрес</option></select></td>
                    <td className="px-3 py-2"><input className={inp} value={r.city ?? ''} onChange={(e) => patch(r, 'city', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2">
                      {r.deliveryMode === 'office'
                        ? <input className={inp} placeholder="Офис" value={r.office ?? ''} onChange={(e) => patch(r, 'office', e.target.value)} onBlur={() => save(r)} />
                        : <input className={inp} placeholder="Адрес" value={r.address ?? ''} onChange={(e) => patch(r, 'address', e.target.value)} onBlur={() => save(r)} />}
                    </td>
                    <td className="px-3 py-2"><input className={inp} type="number" value={r.weightGrams ?? ''} onChange={(e) => patch(r, 'weightGrams', e.target.value === '' ? null : Number(e.target.value))} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><input className={inp} type="number" value={r.codAmountStotinki ?? ''} onChange={(e) => patch(r, 'codAmountStotinki', e.target.value === '' ? null : Number(e.target.value))} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><PriceCell r={r} /></td>
                    <td className="px-3 py-2"><select className={inp} value={r.carrier} onChange={(e) => { patch(r, 'carrier', e.target.value); }} onBlur={() => save(r)}><option value="econt">Econt</option><option value="speedy">Speedy</option></select></td>
                    <td className="px-3 py-2 text-[12px] text-ff-muted">{(r.validation?.issues ?? []).map((i) => i.message).join('; ')}</td>
                    <td className="px-3 py-2"><button onClick={() => del(r)} className="rounded-lg border border-[#e0a0a0] px-2 py-1 text-[12px] font-bold text-ff-red hover:bg-[#FBE9E7]">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* mobile cards */}
          <div className="mt-3 hidden flex-col gap-3 max-[900px]:flex">
            {rows.map((r) => (
              <div key={r.id} className={`rounded-xl border-2 p-3 ${rowBg(r.validationStatus)} ${r.validationStatus === 'ok' ? 'border-[#a5d6a7]' : r.validationStatus === 'warn' ? 'border-[#ffe082]' : 'border-[#ef9a9a]'}`}>
                {([
                  ['Получател', 'receiverName', 'text'], ['Телефон', 'receiverPhone', 'tel'], ['Град', 'city', 'text'],
                  [r.deliveryMode === 'office' ? 'Офис' : 'Адрес', r.deliveryMode === 'office' ? 'office' : 'address', 'text'],
                  ['Тегло (г)', 'weightGrams', 'number'], ['НП (ст.)', 'codAmountStotinki', 'number'],
                ] as const).map(([label, key, type]) => (
                  <label key={key} className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                    <span className="text-[12px] font-bold text-ff-muted">{label}</span>
                    <input className={inp} type={type} value={(r[key as keyof ImportRow] as string | number | null) ?? ''}
                      onChange={(e) => patch(r, key as keyof ImportRow, type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
                      onBlur={() => save(r)} />
                  </label>
                ))}
                <label className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                  <span className="text-[12px] font-bold text-ff-muted">Режим</span>
                  <select className={inp} value={r.deliveryMode ?? 'office'} onChange={(e) => patch(r, 'deliveryMode', e.target.value)} onBlur={() => save(r)}><option value="office">офис</option><option value="address">адрес</option></select>
                </label>
                <label className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                  <span className="text-[12px] font-bold text-ff-muted">Куриер</span>
                  <select className={inp} value={r.carrier} onChange={(e) => patch(r, 'carrier', e.target.value)} onBlur={() => save(r)}><option value="econt">Econt</option><option value="speedy">Speedy</option></select>
                </label>
                {quotes[r.id] && (
                  <div className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                    <span className="text-[12px] font-bold text-ff-muted">Цена</span>
                    <PriceCell r={r} />
                  </div>
                )}
                {(r.validation?.issues ?? []).length > 0 && <p className="text-[12px] text-ff-red">{(r.validation?.issues ?? []).map((i) => i.message).join('; ')}</p>}
                <button onClick={() => del(r)} className="mt-1 w-full rounded-lg border border-[#e0a0a0] py-2 text-[12.5px] font-bold text-ff-red hover:bg-[#FBE9E7]">✕ Изтрий</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
