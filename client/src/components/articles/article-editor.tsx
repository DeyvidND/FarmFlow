'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, ImagePlus, Trash2, Eye, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ArticleRenderer } from './article-renderer';
import { ArticleStatusBadge } from './articles-client';
import { ArticleBodyEditor } from './article-body-editor';
import { ArticleInlineEditor } from './article-inline-editor';
import { cn } from '@/lib/utils';
import { ApiError, updateArticle, deleteArticle, uploadArticleCover } from '@/lib/api-client';
import type { Article } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function ArticleEditor({ initial }: { initial: Article }) {
  const router = useRouter();
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  const [title, setTitle] = useState(initial.title);
  const [excerpt, setExcerpt] = useState(initial.excerpt ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [coverImageUrl, setCoverImageUrl] = useState(initial.coverImageUrl);
  const [status, setStatus] = useState<Article['status']>(initial.status);
  const [publishedAt, setPublishedAt] = useState(initial.publishedAt);

  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const coverRef = useRef<HTMLInputElement>(null);

  // The live object the preview renders from.
  const preview: Article = {
    ...initial,
    title,
    excerpt: excerpt || null,
    body: body || null,
    coverImageUrl,
    status,
    publishedAt,
    media: initial.media, // legacy media still previews
  };

  async function onSave() {
    setSaving(true);
    try {
      const updated = await updateArticle(initial.id, {
        title: title.trim() || 'Без заглавие',
        excerpt,
        body,
      });
      setTitle(updated.title); // reflect server-sanitized inline HTML
      setExcerpt(updated.excerpt ?? '');
      setBody(updated.body ?? '');
      toast.success('Статията е запазена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function onTogglePublish(on: boolean) {
    const prev = status;
    setStatus(on ? 'published' : 'draft'); // optimistic
    try {
      const updated = await updateArticle(initial.id, { status: on ? 'published' : 'draft' });
      setStatus(updated.status);
      setPublishedAt(updated.publishedAt);
      toast.success(on ? 'Статията е публикувана' : 'Статията е върната в чернова');
    } catch (e) {
      setStatus(prev); // rollback
      toast.error(errMsg(e));
    }
  }

  async function onCover(file: File) {
    setBusy(true);
    try {
      const updated = await uploadArticleCover(initial.id, file);
      setCoverImageUrl(updated.coverImageUrl);
      toast.success('Корицата е качена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteArticle() {
    if (!window.confirm('Изтриване на статията?')) return;
    setBusy(true);
    try {
      await deleteArticle(initial.id);
      toast.success('Статията е изтрита');
      router.push('/articles');
    } catch (e) {
      toast.error(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      {/* toolbar */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={() => router.push('/articles')}
          className="inline-flex items-center gap-1.5 text-[13.5px] font-bold text-ff-muted hover:text-ff-ink"
        >
          <ArrowLeft size={16} /> Статии
        </button>

        <div className="flex items-center gap-3">
          <ArticleStatusBadge status={status} />
          <div className="flex items-center gap-2 text-[13px] font-bold text-ff-ink-2">
            Публикувана
            <ToggleSwitch checked={status === 'published'} onChange={onTogglePublish} />
          </div>
          <Button variant="primary" onClick={onSave} disabled={saving} className="rounded-sm">
            <Save size={16} /> {saving ? 'Запазване…' : 'Запази'}
          </Button>
        </div>
      </div>

      {/* tabs */}
      <div className="mb-5 inline-flex rounded-[10px] border border-ff-border bg-ff-surface-2 p-1">
        <TabBtn on={tab === 'edit'} onClick={() => setTab('edit')} Icon={Pencil} label="Редактор" />
        <TabBtn on={tab === 'preview'} onClick={() => setTab('preview')} Icon={Eye} label="Преглед" />
      </div>

      {tab === 'preview' ? (
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm max-sm:p-4">
          <ArticleRenderer article={preview} />
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_340px] gap-5 max-lg:grid-cols-1">
          {/* main column */}
          <div className="flex flex-col gap-4">
            <div className={labelCls}>
              Заглавие
              <ArticleInlineEditor value={title} onChange={setTitle} className="article-inline-quill--title" placeholder="Заглавие на статията" />
            </div>
            <div className={labelCls}>
              Кратко описание
              <ArticleInlineEditor value={excerpt} onChange={setExcerpt} placeholder="Едно-две изречения за изданието/новината" />
            </div>
            <div className={labelCls}>
              Съдържание
              <ArticleBodyEditor articleId={initial.id} value={body} onChange={setBody} />
            </div>
          </div>

          {/* side column: cover + delete */}
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
              <h3 className="text-[12.5px] font-bold text-ff-ink-2">Корица</h3>
              <input ref={coverRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onCover(f); e.target.value = ''; }} />
              <button onClick={() => coverRef.current?.click()}
                className="relative grid h-[150px] w-full place-items-center overflow-hidden rounded-xl border border-ff-border-2 bg-ff-surface-2 text-ff-muted transition hover:border-ff-green-500">
                {coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={coverImageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="inline-flex flex-col items-center gap-1 text-[12.5px] font-semibold">
                    <ImagePlus size={22} /> {busy ? 'качване…' : 'Качи корица'}
                  </span>
                )}
              </button>
            </section>

            <button onClick={onDeleteArticle} disabled={busy}
              className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-sm border border-ff-border px-3 py-2 text-[13px] font-bold text-ff-red transition hover:bg-ff-red/10 disabled:opacity-50">
              <Trash2 size={15} /> Изтрий статията
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TabBtn({ on, onClick, Icon, label }: { on: boolean; onClick: () => void; Icon: typeof Eye; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[7px] px-3.5 py-1.5 text-[13.5px] font-bold transition',
        on ? 'bg-ff-surface text-ff-ink shadow-ff-sm' : 'text-ff-muted hover:text-ff-ink',
      )}
    >
      <Icon size={15} /> {label}
    </button>
  );
}
