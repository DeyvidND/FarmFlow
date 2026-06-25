'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  ApiError, uploadBatch, patchRow, deleteRow, commitBatch, downloadLabels, templateUrl,
  type ImportRow,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

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

  return (
    <div className="animate-ff-fade-up">
      <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Масов внос на пратки</h1>

      {/* settings bar */}
      <div className="mt-4 flex flex-wrap items-center gap-2.5 rounded-xl border border-ff-border bg-ff-surface p-3 shadow-ff-sm">
        <select className={inp + ' w-auto'} value={settings.carrier} onChange={(e) => setSettings({ ...settings, carrier: e.target.value })}>
          <option value="econt">Econt</option><option value="speedy">Speedy</option>
        </select>
        <select className={inp + ' w-auto'} value={settings.currency} onChange={(e) => setSettings({ ...settings, currency: e.target.value })}>
          <option value="EUR">EUR</option><option value="BGN">BGN</option>
        </select>
        <input className={inp + ' w-[140px]'} type="number" placeholder="Тегло (г)" value={settings.weightGrams} onChange={(e) => setSettings({ ...settings, weightGrams: e.target.value })} />
        <input className={inp + ' w-[150px]'} type="number" placeholder="Speedy serviceId" value={settings.speedyServiceId} onChange={(e) => setSettings({ ...settings, speedyServiceId: e.target.value })} />
        <input className="text-[13px]" type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button onClick={upload} disabled={!file || busy} className="rounded-xl bg-ff-green-700 px-4 py-2 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60">Качи и провери</button>
        <a href={templateUrl} className="text-[13.5px] font-bold text-ff-green-700 hover:underline">Свали шаблон</a>
      </div>
      {ai && <p className="mt-2 text-[12.5px] text-ff-muted">{ai}</p>}

      {rows.length > 0 && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-50 px-2.5 py-1 text-[12.5px] font-bold text-ff-green-700">Зелени: {count('ok')}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-ff-amber-softer px-2.5 py-1 text-[12.5px] font-bold text-ff-amber-600">Жълти: {count('warn')}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-[#FBE9E7] px-2.5 py-1 text-[12.5px] font-bold text-ff-red">Червени: {count('error')}</span>
            <button onClick={commit} disabled={busy} className="ml-auto rounded-xl bg-ff-green-700 px-4 py-2 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60">{busy ? 'Създавам…' : 'Създай пратки'}</button>
            {labelIds('econt').length > 0 && <button onClick={() => void labels('econt')} className="rounded-xl border border-ff-border bg-ff-surface px-3 py-2 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">⬇ Етикети (Econt)</button>}
            {labelIds('speedy').length > 0 && <button onClick={() => void labels('speedy')} className="rounded-xl border border-ff-border bg-ff-surface px-3 py-2 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">⬇ Етикети (Speedy)</button>}
          </div>

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
