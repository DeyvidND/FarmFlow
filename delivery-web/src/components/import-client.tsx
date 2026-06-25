'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { UploadCloud, FileDown, SlidersHorizontal, Download, FileSpreadsheet, ListChecks } from 'lucide-react';
import {
  ApiError, uploadBatch, patchRow, deleteRow, commitBatch, downloadLabels, templateUrl,
  type ImportRow,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const STEPS = [
  { icon: Download, title: 'Свали шаблона', desc: 'Готов Excel/CSV с правилните колони.' },
  { icon: FileSpreadsheet, title: 'Попълни и качи', desc: 'Получател, телефон, град, наложен платеж.' },
  { icon: ListChecks, title: 'Провери и създай', desc: 'Поправи маркираните редове и създай пратките.' },
] as const;

export function ImportClient() {
  const [settings, setSettings] = useState({ carrier: 'econt', currency: 'EUR', weightGrams: '1000', speedyServiceId: '' });
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [ai, setAi] = useState('');
  const [busy, setBusy] = useState(false);

  const count = (s: string) => rows.filter((r) => r.validationStatus === s).length;

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const data = await uploadBatch(file, settings);
      setBatchId(data.batch.id);
      setRows(data.rows);
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

  const inp = 'w-full rounded-lg border border-ff-border bg-ff-surface px-2 py-1.5 text-[13.5px] outline-none focus:border-ff-green-500';
  const rowBg = (s: string) => (s === 'ok' ? 'bg-ff-green-50' : s === 'warn' ? 'bg-ff-amber-softer' : 'bg-[#FBE9E7]');
  // Labeled settings-card field vs. the denser table input above.
  const fieldInp = 'h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14px] outline-none focus:border-ff-green-500';
  const fieldLbl = 'mb-1 block text-[12px] font-bold text-ff-muted';
  const primaryBtn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60';
  const outlineBtn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-4 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2';

  return (
    <div className="animate-ff-fade-up">
      <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Масов внос на пратки</h1>
      <p className="mt-1 text-[13.5px] text-ff-muted">Качи Excel или CSV с поръчки и създай всички пратки наведнъж.</p>

      {/* 3-step guide — hidden once a file is loaded into the editor */}
      {rows.length === 0 && (
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
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

      {/* default settings card */}
      <div className="mt-5 rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-4 shadow-ff-sm">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={16} className="text-ff-green-700" />
          <h2 className="font-display text-[15.5px] font-extrabold">Настройки по подразбиране</h2>
        </div>
        <p className="mt-0.5 text-[12.5px] text-ff-muted">Важат за всеки ред, освен ако във файла не е зададено друго.</p>

        <div className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className={fieldLbl} htmlFor="imp-carrier">Куриер</label>
            <select id="imp-carrier" className={fieldInp} value={settings.carrier} onChange={(e) => setSettings({ ...settings, carrier: e.target.value })}>
              <option value="econt">Econt</option><option value="speedy">Speedy</option>
            </select>
          </div>
          <div>
            <label className={fieldLbl} htmlFor="imp-currency">Валута</label>
            <select id="imp-currency" className={fieldInp} value={settings.currency} onChange={(e) => setSettings({ ...settings, currency: e.target.value })}>
              <option value="EUR">EUR</option><option value="BGN">BGN</option>
            </select>
          </div>
          <div>
            <label className={fieldLbl} htmlFor="imp-weight">Тегло (г)</label>
            <input id="imp-weight" className={fieldInp} type="number" inputMode="numeric" value={settings.weightGrams} onChange={(e) => setSettings({ ...settings, weightGrams: e.target.value })} />
          </div>
          {settings.carrier === 'speedy' && (
            <div>
              <label className={fieldLbl} htmlFor="imp-svc">Speedy услуга (serviceId)</label>
              <input id="imp-svc" className={fieldInp} type="number" inputMode="numeric" placeholder="по избор" value={settings.speedyServiceId} onChange={(e) => setSettings({ ...settings, speedyServiceId: e.target.value })} />
            </div>
          )}
        </div>

        {/* upload dropzone */}
        <label className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ff-border bg-ff-surface-2 px-4 py-7 text-center transition-colors hover:border-ff-green-500 hover:bg-ff-green-50">
          <UploadCloud size={26} className="text-ff-muted-2" />
          <div className="text-[13.5px] font-bold text-ff-ink-2">{file ? file.name : 'Избери Excel или CSV файл'}</div>
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
      {ai && <p className="mt-2 text-[12.5px] text-ff-amber-600">{ai}</p>}

      {rows.length > 0 && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-ff-border bg-ff-surface p-3 shadow-ff-sm">
            <span className="mr-1 text-[12.5px] font-bold text-ff-ink-2 ff-fig">{rows.length} реда</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-green-50 px-2.5 py-1 text-[12.5px] font-bold text-ff-green-700"><span className="h-2 w-2 rounded-full bg-ff-green-500" /> Готови {count('ok')}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-amber-softer px-2.5 py-1 text-[12.5px] font-bold text-ff-amber-600"><span className="h-2 w-2 rounded-full bg-ff-amber" /> Внимание {count('warn')}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FBE9E7] px-2.5 py-1 text-[12.5px] font-bold text-ff-red"><span className="h-2 w-2 rounded-full bg-ff-red" /> Грешка {count('error')}</span>
            <button onClick={commit} disabled={busy} className="ml-auto inline-flex h-10 items-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60">{busy ? 'Създавам…' : 'Създай пратки'}</button>
            {labelIds('econt').length > 0 && <button onClick={() => void labels('econt')} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"><FileDown size={15} /> Етикети (Econt)</button>}
            {labelIds('speedy').length > 0 && <button onClick={() => void labels('speedy')} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"><FileDown size={15} /> Етикети (Speedy)</button>}
          </div>
          <p className="mt-2 text-[12px] text-ff-muted">Редовете в зелено са готови за изпращане, жълтите имат предупреждения, а червените трябва да се поправят преди да създадеш пратките.</p>

          {/* desktop table */}
          <div className="mt-3 overflow-x-auto rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:hidden">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {['#', 'Получател', 'Телефон', 'Реж.', 'Град', 'Офис/Адрес', 'Тегло(г)', 'НП(ст.)', 'Куриер', 'Проблеми', ''].map((h) => (
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
