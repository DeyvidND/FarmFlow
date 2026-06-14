'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Image as ImageIcon, Heading, Type, MousePointerClick, Columns2,
  Minus, MoveVertical, ArrowUp, ArrowDown, Trash2, Plus, Upload,
} from 'lucide-react';
import {
  uploadCampaignInlineImage,
  type NewsletterBlock,
  type NewsletterColumn,
} from '@/lib/api-client';
import { QuillBlock } from './quill-block';

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2 text-[14px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';

type BlockType = NewsletterBlock['type'];

const ADD_MENU: { type: BlockType; label: string; icon: typeof Type }[] = [
  { type: 'hero', label: 'Голяма снимка', icon: ImageIcon },
  { type: 'heading', label: 'Заглавие', icon: Heading },
  { type: 'text', label: 'Текст', icon: Type },
  { type: 'image', label: 'Снимка', icon: ImageIcon },
  { type: 'button', label: 'Бутон', icon: MousePointerClick },
  { type: 'columns', label: '2 колони', icon: Columns2 },
  { type: 'divider', label: 'Разделител', icon: Minus },
  { type: 'spacer', label: 'Отстъп', icon: MoveVertical },
];

function emptyBlock(type: BlockType): NewsletterBlock {
  switch (type) {
    case 'hero': return { type: 'hero', image: '', alt: '' };
    case 'heading': return { type: 'heading', text: '', level: 1 };
    case 'text': return { type: 'text', html: '' };
    case 'image': return { type: 'image', image: '', alt: '', caption: '', href: '' };
    case 'button': return { type: 'button', label: 'Виж още', href: '' };
    case 'columns': return { type: 'columns', left: { kind: 'text', html: '' }, right: { kind: 'text', html: '' } };
    case 'divider': return { type: 'divider' };
    case 'spacer': return { type: 'spacer', size: 'md' };
  }
}

/** Upload-or-show image control. */
function ImageField({
  campaignId, url, onUrl, label = 'Качи снимка',
}: { campaignId: string; url: string; onUrl: (u: string) => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  async function pick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setBusy(true);
      try {
        const { url: u } = await uploadCampaignInlineImage(campaignId, file);
        onUrl(u);
      } catch {
        toast.error('Неуспешно качване на снимка');
      } finally {
        setBusy(false);
      }
    };
    input.click();
  }
  return (
    <div className="flex flex-col gap-2">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="max-h-40 w-full rounded-sm border border-ff-border object-cover" />
      ) : (
        <div className="grid h-28 place-items-center rounded-sm border border-dashed border-ff-border bg-ff-surface-2 text-[13px] text-ff-muted">
          Няма снимка
        </div>
      )}
      <button
        type="button"
        onClick={pick}
        disabled={busy}
        className="inline-flex items-center gap-1.5 self-start rounded-sm border border-ff-border bg-ff-surface px-3 py-1.5 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2 disabled:opacity-60"
      >
        <Upload size={14} /> {busy ? 'Качване…' : label}
      </button>
    </div>
  );
}

function ColumnEditor({
  campaignId, col, onChange,
}: { campaignId: string; col: NewsletterColumn; onChange: (c: NewsletterColumn) => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-ff-border bg-ff-surface-2 p-2.5">
      <div className="flex gap-1 text-[12px] font-bold">
        <button
          type="button"
          onClick={() => onChange({ kind: 'text', html: col.kind === 'text' ? col.html : '' })}
          className={`rounded-sm px-2 py-1 ${col.kind === 'text' ? 'bg-ff-green-100 text-ff-green-800' : 'text-ff-muted'}`}
        >
          Текст
        </button>
        <button
          type="button"
          onClick={() => onChange({ kind: 'image', image: col.kind === 'image' ? col.image : '' })}
          className={`rounded-sm px-2 py-1 ${col.kind === 'image' ? 'bg-ff-green-100 text-ff-green-800' : 'text-ff-muted'}`}
        >
          Снимка
        </button>
      </div>
      {col.kind === 'text' ? (
        <QuillBlock campaignId={campaignId} value={col.html} onChange={(html) => onChange({ kind: 'text', html })} />
      ) : (
        <ImageField campaignId={campaignId} url={col.image} onUrl={(image) => onChange({ kind: 'image', image })} />
      )}
    </div>
  );
}

export function BlockCanvas({
  campaignId, blocks, onChange,
}: { campaignId: string; blocks: NewsletterBlock[]; onChange: (b: NewsletterBlock[]) => void }) {
  const [addOpen, setAddOpen] = useState(false);

  const set = (i: number, b: NewsletterBlock) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = blocks.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i: number) => onChange(blocks.filter((_, j) => j !== i));
  const add = (type: BlockType) => {
    onChange([...blocks, emptyBlock(type)]);
    setAddOpen(false);
  };

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((b, i) => (
        <div key={i} className="rounded-xl border border-ff-border bg-ff-surface p-3.5 shadow-ff-sm">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-[12px] font-extrabold uppercase tracking-wide text-ff-muted">
              {ADD_MENU.find((m) => m.type === b.type)?.label ?? b.type}
            </span>
            <div className="flex items-center gap-1">
              <IconBtn onClick={() => move(i, -1)} disabled={i === 0} title="Нагоре"><ArrowUp size={15} /></IconBtn>
              <IconBtn onClick={() => move(i, 1)} disabled={i === blocks.length - 1} title="Надолу"><ArrowDown size={15} /></IconBtn>
              <IconBtn onClick={() => remove(i)} title="Изтрий" danger><Trash2 size={15} /></IconBtn>
            </div>
          </div>
          <BlockBody campaignId={campaignId} block={b} onChange={(nb) => set(i, nb)} />
        </div>
      ))}

      <div className="relative">
        <button
          type="button"
          onClick={() => setAddOpen((o) => !o)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-ff-border bg-ff-surface-2 py-3 text-[14px] font-bold text-ff-ink-2 hover:bg-ff-surface"
        >
          <Plus size={17} /> Добави блок
        </button>
        {addOpen && (
          <div className="absolute z-20 mt-1 grid w-full grid-cols-2 gap-1 rounded-xl border border-ff-border bg-ff-surface p-2 shadow-ff-lg sm:grid-cols-4">
            {ADD_MENU.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                type="button"
                onClick={() => add(type)}
                className="flex flex-col items-center gap-1.5 rounded-sm px-2 py-3 text-[12.5px] font-semibold text-ff-ink-2 hover:bg-ff-green-50"
              >
                <Icon size={18} className="text-ff-green-700" /> {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  children, onClick, disabled, title, danger,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title: string; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`grid h-7 w-7 place-items-center rounded-sm hover:bg-ff-surface-2 disabled:opacity-30 ${danger ? 'text-ff-red' : 'text-ff-muted'}`}
    >
      {children}
    </button>
  );
}

function BlockBody({
  campaignId, block, onChange,
}: { campaignId: string; block: NewsletterBlock; onChange: (b: NewsletterBlock) => void }) {
  switch (block.type) {
    case 'hero':
      return (
        <div className="flex flex-col gap-2">
          <ImageField campaignId={campaignId} url={block.image} onUrl={(image) => onChange({ ...block, image })} />
          <input className={field} placeholder="Описание (alt)" value={block.alt ?? ''} onChange={(e) => onChange({ ...block, alt: e.target.value })} />
          <input className={field} placeholder="Линк при клик (по желание)" value={block.href ?? ''} onChange={(e) => onChange({ ...block, href: e.target.value })} />
        </div>
      );
    case 'heading':
      return (
        <div className="flex gap-2">
          <input className={field} placeholder="Заглавие" value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
          <select
            className="rounded-sm border border-ff-border bg-ff-surface-2 px-2 text-[13px]"
            value={block.level ?? 1}
            onChange={(e) => onChange({ ...block, level: Number(e.target.value) as 1 | 2 })}
          >
            <option value={1}>Голямо</option>
            <option value={2}>Средно</option>
          </select>
        </div>
      );
    case 'text':
      return <QuillBlock campaignId={campaignId} value={block.html} onChange={(html) => onChange({ ...block, html })} />;
    case 'image':
      return (
        <div className="flex flex-col gap-2">
          <ImageField campaignId={campaignId} url={block.image} onUrl={(image) => onChange({ ...block, image })} />
          <input className={field} placeholder="Описание (alt)" value={block.alt ?? ''} onChange={(e) => onChange({ ...block, alt: e.target.value })} />
          <input className={field} placeholder="Надпис под снимката (по желание)" value={block.caption ?? ''} onChange={(e) => onChange({ ...block, caption: e.target.value })} />
          <input className={field} placeholder="Линк при клик (по желание)" value={block.href ?? ''} onChange={(e) => onChange({ ...block, href: e.target.value })} />
        </div>
      );
    case 'button':
      return (
        <div className="flex flex-col gap-2">
          <input className={field} placeholder="Текст на бутона" value={block.label} onChange={(e) => onChange({ ...block, label: e.target.value })} />
          <input className={field} placeholder="https://… линк" value={block.href} onChange={(e) => onChange({ ...block, href: e.target.value })} />
        </div>
      );
    case 'columns':
      return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ColumnEditor campaignId={campaignId} col={block.left} onChange={(left) => onChange({ ...block, left })} />
          <ColumnEditor campaignId={campaignId} col={block.right} onChange={(right) => onChange({ ...block, right })} />
        </div>
      );
    case 'divider':
      return <p className="text-[13px] text-ff-muted">Тънка линия разделител.</p>;
    case 'spacer':
      return (
        <select
          className={field}
          value={block.size ?? 'md'}
          onChange={(e) => onChange({ ...block, size: e.target.value as 'sm' | 'md' | 'lg' })}
        >
          <option value="sm">Малък отстъп</option>
          <option value="md">Среден отстъп</option>
          <option value="lg">Голям отстъп</option>
        </select>
      );
  }
}
