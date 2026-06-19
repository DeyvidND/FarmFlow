'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Mail, Eye, Check, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { moneyFromStotinki } from '@/lib/utils';
import {
  updateCampaign, previewCampaign, sendCampaign, getNewsletterQuote,
  type NewsletterCampaign, type NewsletterBlock, type NewsletterQuote,
} from '@/lib/api-client';
import { QuillBlock } from './quill-block';

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[15px] font-bold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';

// New campaigns store the whole email as a single rich-text body. Older drafts
// (made with the previous block builder) are collapsed to one HTML string on
// open so no content is lost — the result is re-sanitized server-side on save.
function blocksToHtml(blocks: NewsletterBlock[] | undefined): string {
  if (!blocks?.length) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].html; // common case
  const img = (src: string, alt = '') => (src ? `<p><img src="${src}" alt="${alt}"></p>` : '');
  return blocks
    .map((b): string => {
      switch (b.type) {
        case 'text': return b.html;
        case 'heading': { const h = b.level === 2 ? 3 : 2; return `<h${h}>${b.text}</h${h}>`; }
        case 'hero':
        case 'image': return img(b.image, b.alt);
        case 'button': return b.href ? `<p><a href="${b.href}">${b.label}</a></p>` : `<p>${b.label}</p>`;
        case 'columns': return [b.left, b.right].map((c) => (c.kind === 'text' ? c.html : img(c.image, c.alt))).join('');
        case 'divider': return '<hr>';
        case 'spacer': return '';
      }
    })
    .filter(Boolean)
    .join('');
}

export function CampaignEditor({ initial }: { initial: NewsletterCampaign }) {
  const router = useRouter();
  const sent = initial.status === 'sent';
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState<string>(() => blocksToHtml(initial.blocks));
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [previewHtml, setPreviewHtml] = useState('');
  const [quote, setQuote] = useState<NewsletterQuote | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const dirty = useRef(false);

  // The whole email is one rich-text block.
  const payloadBlocks = (html: string): NewsletterBlock[] => [{ type: 'text', html }];

  // Cost preview (active count + this-send cost).
  useEffect(() => {
    getNewsletterQuote().then(setQuote).catch(() => undefined);
  }, []);

  const refreshPreview = useCallback(async () => {
    try {
      const { html } = await previewCampaign(initial.id);
      setPreviewHtml(html);
    } catch {
      /* ignore preview errors */
    }
  }, [initial.id]);

  useEffect(() => {
    void refreshPreview();
  }, [refreshPreview]);

  // Debounced autosave whenever subject/body change (drafts only).
  useEffect(() => {
    if (sent || !dirty.current) return;
    setSaving('saving');
    const t = setTimeout(async () => {
      try {
        await updateCampaign(initial.id, { subject, blocks: payloadBlocks(body) });
        setSaving('saved');
        void refreshPreview();
      } catch {
        setSaving('idle');
        toast.error('Грешка при запис');
      }
    }, 800);
    return () => clearTimeout(t);
  }, [subject, body, sent, initial.id, refreshPreview]);

  const onSubject = (v: string) => { dirty.current = true; setSubject(v); };
  const onBody = (html: string) => { dirty.current = true; setBody(html); };

  async function confirmSend() {
    if (!subject.trim()) {
      toast.error('Добави тема на имейла.');
      return;
    }
    if (quote && quote.activeCount === 0) {
      toast.error('Нямаш активни абонати още — няма на кого да изпратиш.');
      return;
    }
    setSending(true);
    try {
      // Make sure the latest edits are persisted before sending.
      await updateCampaign(initial.id, { subject, blocks: payloadBlocks(body) });
      const res = await sendCampaign(initial.id);
      toast.success(`Изпратено до ${res.sent} ${res.sent === 1 ? 'клиент' : 'клиента'}`);
      router.push('/newsletters');
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Неуспешно изпращане');
      setSending(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      {/* top bar */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <button
          onClick={() => router.push('/newsletters')}
          className="inline-flex items-center gap-1.5 text-[14px] font-bold text-ff-ink-2 hover:text-ff-ink"
        >
          <ArrowLeft size={17} /> Имейл клиенти
        </button>
        <div className="flex items-center gap-3">
          {!sent && (
            <span className="text-[12.5px] text-ff-muted">
              {saving === 'saving' ? 'Запазване…' : saving === 'saved' ? 'Запазено ✓' : ''}
            </span>
          )}
          {sent ? (
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-ff-green-100 px-3 py-1.5 text-[13px] font-bold text-ff-green-800">
              <Check size={15} /> Изпратен
            </span>
          ) : (
            <Button variant="primary" onClick={() => setConfirmOpen(true)} className="rounded-sm">
              <Mail size={16} /> Изпрати
            </Button>
          )}
        </div>
      </div>

      {/* cost bar — one clear price */}
      {quote && !sent && (
        <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-ff-green-100 bg-ff-green-50 px-4 py-3 text-[13.5px] text-ff-green-800">
          <Users size={16} className="shrink-0" />
          {quote.premium ? (
            <span>Имаш <b>{quote.activeCount}</b> активни абоната. Изпращането е <b>безплатно</b>.</span>
          ) : (
            <span>
              Имаш <b>{quote.activeCount}</b> активни абоната. Това изпращане струва{' '}
              <b>{moneyFromStotinki(quote.sendCostStotinki)}</b>.
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_minmax(320px,420px)]">
        {/* editor */}
        <div className="flex flex-col gap-4">
          <input
            className={field}
            placeholder="Тема на имейла"
            value={subject}
            onChange={(e) => onSubject(e.target.value)}
            disabled={sent}
          />
          {sent ? (
            <p className="rounded-xl border border-ff-border bg-ff-surface-2 p-4 text-[13.5px] text-ff-muted">
              Този бюлетин е изпратен и не може да се променя. Направи копие, ако искаш да го пратиш пак.
            </p>
          ) : (
            <QuillBlock
              campaignId={initial.id}
              value={body}
              onChange={onBody}
              placeholder="Напиши съобщението си тук. Можеш да добавяш снимки, заглавия и връзки от лентата отгоре."
            />
          )}
        </div>

        {/* preview */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-extrabold text-ff-ink-2">
            <Eye size={15} className="text-ff-green-700" /> Преглед
          </div>
          <iframe
            title="preview"
            srcDoc={previewHtml}
            className="h-[600px] w-full rounded-xl border border-ff-border bg-white shadow-ff-sm"
          />
        </div>
      </div>

      {/* confirm dialog */}
      {confirmOpen && (
        <div
          className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
          onClick={() => !sending && setConfirmOpen(false)}
        >
          <div
            className="animate-ff-pop w-[420px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-2 text-[18px] font-extrabold">Изпрати бюлетин</h2>
            <p className="mb-5 text-[14.5px] text-ff-ink-2">
              {quote ? (
                quote.premium ? (
                  <>Изпрати до <b>{quote.activeCount}</b> абоната — <b>безплатно</b>.</>
                ) : (
                  <>Изпрати до <b>{quote.activeCount}</b> абоната — ще ти струва{' '}
                    <b>{moneyFromStotinki(quote.sendCostStotinki)}</b>.</>
                )
              ) : (
                'Изпрати до всички активни абонати?'
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setConfirmOpen(false)} disabled={sending} className="rounded-sm">
                Откажи
              </Button>
              <Button variant="primary" type="button" onClick={confirmSend} disabled={sending} className="rounded-sm">
                {sending ? 'Изпращане…' : 'Изпрати'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
