'use client';

import { useRef, useState } from 'react';
import { Camera, ClipboardPaste, Loader2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { extractAiProducts, commitAiProducts, type AiExtractedProduct } from '@/lib/api-client';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';

const tile = (active: boolean) =>
  `flex h-24 flex-col items-center justify-center gap-2 rounded-xl border-2 text-[14px] font-bold transition ${
    active ? 'border-ff-green-600 bg-ff-green-50 text-ff-green-800' : 'border-ff-border bg-ff-surface-2 text-ff-ink-2'
  } disabled:cursor-not-allowed disabled:opacity-60`;

/** Photo/paste → AI preview → publish. The preview table is the safety gate:
 *  vision misreads handwriting, so a human confirms every row before commit. */
export function AiImportDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful commit so the products list can refresh. */
  onDone: (created: number) => void;
}) {
  const [mode, setMode] = useState<'photo' | 'text'>('photo');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<AiExtractedProduct[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // So a second open never shows the previous run's preview/text/error.
  function reset() {
    setMode('photo');
    setText('');
    setRows(null);
    setBusy(false);
    setErr(null);
  }

  function close() {
    reset();
    onClose();
  }

  if (!open) return null;

  async function runExtract(input: { file?: File; text?: string }) {
    setBusy(true);
    setErr(null);
    try {
      const res = await extractAiProducts(input);
      if (res.products.length === 0)
        setErr('Не разчетохме продукти. Опитайте с по-ясна снимка или поставете текста.');
      else setRows(res.products);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Грешка при разчитането.');
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!rows?.length) return;
    setBusy(true);
    setErr(null);
    try {
      const { created } = await commitAiProducts(rows);
      onDone(created);
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Грешка при публикуването.');
    } finally {
      setBusy(false);
    }
  }

  const patchRow = (i: number, patch: Partial<AiExtractedProduct>) =>
    setRows((r) => r!.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const dropRow = (i: number) => setRows((r) => r!.filter((_, idx) => idx !== i));

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={close}>
      <div
        className="animate-ff-pop max-h-[92vh] w-[520px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">Добави от снимка или списък</h2>
          <button
            onClick={close}
            aria-label="Затвори"
            className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2"
          >
            <X size={18} />
          </button>
        </div>

        {rows === null ? (
          <div className="flex flex-col gap-4">
            {/* Always mounted (not just while mode='photo') so the ref is stable
                whichever tile the farmer taps last. */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void runExtract({ file: f });
              }}
            />

            {busy ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-ff-ink-2">
                <Loader2 className="h-7 w-7 animate-spin" />
                <span className="text-[14px] font-semibold">Разчитаме…</span>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('photo');
                      fileRef.current?.click();
                    }}
                    className={tile(mode === 'photo')}
                  >
                    <Camera size={26} />
                    Снимай ценоразписа
                  </button>
                  <button type="button" onClick={() => setMode('text')} className={tile(mode === 'text')}>
                    <ClipboardPaste size={26} />
                    Постави текст
                  </button>
                </div>

                {mode === 'text' && (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={6}
                      placeholder="Постави списък или ценоразпис — по един продукт на ред…"
                      className={`${field} resize-none`}
                    />
                    <Button
                      type="button"
                      variant="primary"
                      className="h-12 rounded-sm"
                      disabled={!text.trim()}
                      onClick={() => void runExtract({ text })}
                    >
                      Разчети
                    </Button>
                  </div>
                )}
              </>
            )}

            {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13.5px]">
                <thead>
                  <tr className="text-left text-[11.5px] font-bold uppercase tracking-wide text-ff-muted">
                    <th className="pb-2 pr-2">Име</th>
                    <th className="pb-2 pr-2">Цена в €</th>
                    <th className="pb-2 pr-2">Единица</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-t border-ff-border">
                      <td className="py-1.5 pr-2">
                        <input
                          value={row.name}
                          onChange={(e) => patchRow(i, { name: e.target.value })}
                          className={`${field} w-full min-w-[140px]`}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min="0"
                          value={(row.priceStotinki / 100).toFixed(2)}
                          onChange={(e) =>
                            patchRow(i, { priceStotinki: Math.round(parseFloat(e.target.value || '0') * 100) })
                          }
                          className={`${field} w-24`}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input
                          value={row.unit}
                          onChange={(e) => patchRow(i, { unit: e.target.value })}
                          className={`${field} w-20`}
                        />
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => dropRow(i)}
                          aria-label="Премахни продукт"
                          className="grid h-10 w-10 place-items-center rounded-lg text-ff-red hover:bg-ff-surface-2"
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}

            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-ff-muted">{rows.length} продукта</span>
              <div className="flex gap-2">
                <Button variant="ghost" type="button" className="h-12 rounded-sm" onClick={close} disabled={busy}>
                  Откажи
                </Button>
                <Button
                  variant="primary"
                  type="button"
                  className="h-12 rounded-sm"
                  onClick={() => void publish()}
                  disabled={busy || rows.length === 0}
                >
                  {busy ? 'Публикуване…' : 'Публикувай'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
