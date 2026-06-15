'use client';

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { createEditSession } from '@/lib/api-client';

export default function SiteEditorPage() {
  const [busy, setBusy] = useState(false);

  async function openEditor() {
    setBusy(true);
    try {
      const { token, siteUrl } = await createEditSession();
      const url = `${siteUrl.replace(/\/$/, '')}/?edit=${encodeURIComponent(token)}`;
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Адресът на сайта още не е зададен — свържи се с поддръжката.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[760px]">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Промени сайта</h1>
        <p className="text-[13.5px] text-ff-muted">Редактирай текстовете и снимките направо върху сайта си.</p>
      </div>
      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <p className="mb-4 text-[14px] text-ff-ink">
          {'Натисни бутона — сайтът ти ще се отвори в режим на редактиране. Кликни върху всеки текст или снимка, за да го смениш, после „Запази".'}
        </p>
        <Button type="button" disabled={busy} onClick={openEditor} className="gap-2 rounded-sm px-6 py-2.5 text-[14px]">
          <ExternalLink size={16} /> {busy ? 'Отваряне…' : 'Редактирай сайта'}
        </Button>
      </div>
    </div>
  );
}
