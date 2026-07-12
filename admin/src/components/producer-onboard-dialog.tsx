'use client';

import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, onboardProducer, type OnboardProducerResult } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
    >
      {copied ? <Check size={13} className="text-ff-green-600" /> : <Copy size={13} />}
      {copied ? 'Копирано' : 'Копирай'}
    </button>
  );
}

/**
 * Super-admin one-shot producer onboarding: create the farmer + (optionally)
 * AI-import their price list + mint an invite link, in a single submit.
 */
export function ProducerOnboardDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [pricelistText, setPricelistText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OnboardProducerResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await onboardProducer(tenantId, {
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        pricelistText: pricelistText.trim() || undefined,
        file: file ?? undefined,
      });
      setResult(res);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="animate-ff-fade fixed inset-0 z-40 bg-ff-overlay" onClick={onClose} />
      <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg">
        {!result ? (
          <>
            <h2 className="mb-4 text-[17px] font-extrabold">Onboard производител</h2>
            <form onSubmit={submit} className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Име *</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Иван Иванов"
                  required
                  className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Телефон</span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+359 88 …"
                  className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Имейл</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="fermer@example.com"
                  className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
                />
                <span className="text-[12px] text-ff-muted">с имейл ще получи и покана по пощата</span>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Ценоразпис</span>
                <textarea
                  value={pricelistText}
                  onChange={(e) => setPricelistText(e.target.value)}
                  rows={5}
                  placeholder={'Домати 2,50 лв/кг\nКраставици 1,80 лв/кг\nМед 12 лв/буркан…'}
                  className="w-full resize-y rounded-xl border border-ff-border bg-ff-bg px-3 py-2 text-[14px] outline-none focus:border-ff-green-500"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] text-ff-muted">или снимка</span>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border px-2.5 py-1 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
                  >
                    {file ? file.name : 'Избери снимка'}
                  </button>
                  {file && (
                    <button type="button" onClick={() => setFile(null)} className="text-[12.5px] text-ff-muted hover:underline">
                      Премахни
                    </button>
                  )}
                </div>
              </label>
              <div className="mt-1 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-ff-border bg-ff-surface px-4 py-2.5 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
                >
                  Откажи
                </button>
                <button
                  type="submit"
                  disabled={busy || !name.trim()}
                  className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60"
                >
                  {busy ? 'Създаване…' : 'Създай производителя'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="mb-3 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-ff-green-50 text-ff-green-700">
                <Check size={20} />
              </span>
              <div>
                <h2 className="text-[17px] font-extrabold">Производителят е създаден</h2>
                <p className="mt-0.5 text-[13.5px] text-ff-ink-2">{result.productsCreated} продукта добавени</p>
              </div>
            </div>
            {result.inviteLink && (
              <div className="mt-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Линк за покана</p>
                <div className="flex items-center gap-2.5">
                  <code className="flex-1 break-all font-mono text-[13px]">{result.inviteLink}</code>
                  <CopyButton text={result.inviteLink} />
                </div>
                <p className="mt-2 text-[12.5px] text-ff-muted">
                  Прати линка по Viber — важи 7 дни, еднократно.
                </p>
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button
                onClick={onClose}
                className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95"
              >
                Затвори
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
