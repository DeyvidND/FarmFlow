'use client';

import { useRef, useState } from 'react';
import { Sparkles, Upload, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, extractProducts, importTenantProducts, type ExtractedProduct } from '@/lib/api-client';

/**
 * Super-admin onboarding helper. Operator pastes the farm's price list or uploads a
 * .txt/.csv/.xlsx file → AI extracts products → operator reviews/edits an editable
 * table → „Създай" creates them in the farm's catalog, attached to this producer.
 * No product images are set here; the farmer adds those later in their own panel.
 */
export function ProductImportDialog({
  tenantId,
  farmerId,
  farmerName,
}: {
  tenantId: string;
  farmerId: string;
  farmerName: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ExtractedProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function reset() {
    setStep('input');
    setText('');
    setFile(null);
    setRows([]);
    setBusy(false);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function runExtract() {
    if (!text.trim() && !file) {
      toast.error('Поставете текст или изберете файл');
      return;
    }
    setBusy(true);
    try {
      const { products } = await extractProducts(tenantId, { text: text.trim() || undefined, file: file ?? undefined });
      if (!products.length) {
        toast.error('Не открих продукти в текста');
        return;
      }
      setRows(products);
      setStep('preview');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно извличане');
    } finally {
      setBusy(false);
    }
  }

  function patch(i: number, key: keyof ExtractedProduct, value: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }

  function patchPrice(i: number, euros: string) {
    const n = Math.max(0, Math.round((parseFloat(euros.replace(',', '.')) || 0) * 100));
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, priceStotinki: n } : r)));
  }

  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function commit() {
    const clean = rows.filter((r) => r.name.trim());
    if (!clean.length) {
      toast.error('Няма валидни продукти');
      return;
    }
    setBusy(true);
    try {
      const res = await importTenantProducts(
        tenantId,
        clean.map((r) => ({ ...r, farmerId, isActive: true })),
      );
      toast.success(`Създадени ${res.products} продукта`);
      close();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно създаване');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-ff-green-600 bg-ff-green-50 px-3 py-1.5 text-[13px] font-bold text-ff-green-700 hover:brightness-95"
      >
        <Sparkles size={14} /> Импорт на продукти (AI)
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/55 p-4">
          <div className="flex max-h-[92vh] w-[760px] max-w-full flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
            <div className="flex items-center justify-between border-b border-ff-border-2 px-6 py-4">
              <h2 className="font-display text-[18px] font-extrabold">
                Импорт на продукти · {farmerName}
              </h2>
              <button onClick={close} aria-label="Затвори" className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2">
                <X size={18} />
              </button>
            </div>

            {step === 'input' ? (
              <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
                <p className="text-[13.5px] text-ff-ink-2">
                  Поставете ценоразписа на фермата или качете файл (.txt, .csv, .xlsx). AI ще извлече продуктите за преглед — без снимки.
                </p>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  placeholder={'Домати 2,50 лв/кг\nКраставици 1,80 лв/кг\nМед 12 лв/буркан…'}
                  className="w-full resize-y rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2 text-[14px] outline-none focus:border-ff-green-600"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".txt,.csv,.xlsx"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border px-3 py-1.5 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
                  >
                    <Upload size={14} /> {file ? file.name : 'Избери файл'}
                  </button>
                  {file && (
                    <button type="button" onClick={() => setFile(null)} className="text-[13px] text-ff-muted hover:underline">
                      Премахни файла
                    </button>
                  )}
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={runExtract}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-600 px-4 py-2 text-[14px] font-bold text-white hover:brightness-95 disabled:opacity-60"
                  >
                    <Sparkles size={15} /> {busy ? 'Извличане…' : 'Извлечи'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="overflow-auto px-6 py-4">
                  <p className="mb-3 text-[13px] text-ff-muted">
                    {rows.length} продукта. Прегледайте и редактирайте преди създаване.
                  </p>
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="border-b border-ff-border text-left text-ff-muted">
                        <th className="py-2 pr-2 font-bold">Име</th>
                        <th className="py-2 pr-2 font-bold">Цена €</th>
                        <th className="py-2 pr-2 font-bold">Ед.</th>
                        <th className="py-2 pr-2 font-bold">Разфасовка</th>
                        <th className="py-2 pr-2 font-bold">Категория</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-b border-ff-border-2">
                          <td className="py-1.5 pr-2">
                            <input value={r.name} onChange={(e) => patch(i, 'name', e.target.value)} className="w-full rounded border border-transparent bg-transparent px-1 py-1 hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input value={(r.priceStotinki / 100).toFixed(2)} onChange={(e) => patchPrice(i, e.target.value)} inputMode="decimal" className="w-20 rounded border border-transparent bg-transparent px-1 py-1 text-right hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input value={r.unit} onChange={(e) => patch(i, 'unit', e.target.value)} className="w-16 rounded border border-transparent bg-transparent px-1 py-1 hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input value={r.weight ?? ''} onChange={(e) => patch(i, 'weight', e.target.value)} className="w-24 rounded border border-transparent bg-transparent px-1 py-1 hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input value={r.category ?? ''} onChange={(e) => patch(i, 'category', e.target.value)} className="w-28 rounded border border-transparent bg-transparent px-1 py-1 hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 text-right">
                            <button type="button" onClick={() => removeRow(i)} aria-label="Премахни" className="text-ff-muted hover:text-ff-red">
                              <Trash2 size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t border-ff-border-2 px-6 py-4">
                  <button type="button" onClick={() => setStep('input')} className="text-[13.5px] font-semibold text-ff-ink-2 hover:underline">
                    ← Назад
                  </button>
                  <button
                    type="button"
                    onClick={commit}
                    disabled={busy || rows.length === 0}
                    className="rounded-lg bg-ff-green-600 px-4 py-2 text-[14px] font-bold text-white hover:brightness-95 disabled:opacity-60"
                  >
                    {busy ? 'Създаване…' : `Създай ${rows.length} продукта`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
