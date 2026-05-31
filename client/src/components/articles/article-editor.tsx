'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Save, ImagePlus, Link2, Trash2, GripVertical,
  Eye, Pencil, Image as ImageIcon, Film, Youtube, Instagram,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ArticleRenderer } from './article-renderer';
import { ArticleStatusBadge } from './articles-client';
import { cn } from '@/lib/utils';
import {
  ApiError,
  updateArticle,
  deleteArticle,
  uploadArticleCover,
  uploadArticleMedia,
  addArticleEmbed,
  updateArticleMedia,
  deleteArticleMedia,
  reorderArticleMedia,
} from '@/lib/api-client';
import type { Article, ArticleMedia } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

const MEDIA_ICON = {
  image: ImageIcon,
  video: Film,
  youtube: Youtube,
  instagram: Instagram,
} as const;

export function ArticleEditor({ initial }: { initial: Article }) {
  const router = useRouter();
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  const [title, setTitle] = useState(initial.title);
  const [excerpt, setExcerpt] = useState(initial.excerpt ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [coverImageUrl, setCoverImageUrl] = useState(initial.coverImageUrl);
  const [status, setStatus] = useState<Article['status']>(initial.status);
  const [publishedAt, setPublishedAt] = useState(initial.publishedAt);
  const [media, setMedia] = useState<ArticleMedia[]>(initial.media);

  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [embedUrl, setEmbedUrl] = useState('');

  const coverRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);
  const dragIndex = useRef<number | null>(null);

  // The live object the preview (and storefront) render from.
  const preview: Article = {
    ...initial,
    title,
    excerpt: excerpt || null,
    body: body || null,
    coverImageUrl,
    status,
    publishedAt,
    media,
  };

  async function onSave() {
    setSaving(true);
    try {
      const updated = await updateArticle(initial.id, {
        title: title.trim() || 'Без заглавие',
        excerpt,
        body,
      });
      setTitle(updated.title);
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

  async function onAddMediaFile(file: File) {
    setBusy(true);
    try {
      const m = await uploadArticleMedia(initial.id, file);
      setMedia((prev) => [...prev, m]);
      toast.success('Медията е добавена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAddEmbed() {
    const url = embedUrl.trim();
    if (!url) return;
    setBusy(true);
    try {
      const m = await addArticleEmbed(initial.id, url);
      setMedia((prev) => [...prev, m]);
      setEmbedUrl('');
      toast.success('Видеото е вмъкнато');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCaptionBlur(m: ArticleMedia, caption: string) {
    if ((m.caption ?? '') === caption) return;
    try {
      const updated = await updateArticleMedia(initial.id, m.id, caption);
      setMedia((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function onDeleteMedia(m: ArticleMedia) {
    setMedia((prev) => prev.filter((x) => x.id !== m.id)); // optimistic
    try {
      await deleteArticleMedia(initial.id, m.id);
    } catch (e) {
      setMedia((prev) => [...prev, m].sort((a, b) => a.position - b.position)); // rollback
      toast.error(errMsg(e));
    }
  }

  async function persistOrder(next: ArticleMedia[]) {
    setMedia(next);
    try {
      const saved = await reorderArticleMedia(
        initial.id,
        next.map((m, i) => ({ id: m.id, position: i })),
      );
      setMedia(saved);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  function moveTo(from: number, to: number) {
    if (to < 0 || to >= media.length || from === to) return;
    const next = [...media];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    void persistOrder(next);
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
            <label className={labelCls}>
              Заглавие
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={cn(field, 'text-[17px] font-bold')} placeholder="Заглавие на статията" />
            </label>
            <label className={labelCls}>
              Кратко описание
              <textarea value={excerpt} onChange={(e) => setExcerpt(e.target.value)} rows={2} className={field} placeholder="Едно-две изречения за изданието/новината" />
            </label>
            <label className={labelCls}>
              Съдържание
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} className={cn(field, 'leading-[1.6]')} placeholder="Текст на статията. Раздели абзаците с празен ред." />
            </label>
          </div>

          {/* side column: cover + media */}
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

            <section className="flex flex-col gap-2.5">
              <h3 className="text-[12.5px] font-bold text-ff-ink-2">Медия ({media.length})</h3>

              <div className="flex flex-col gap-2">
                {media.map((m, i) => {
                  const Icon = MEDIA_ICON[m.type];
                  return (
                    <div
                      key={m.id}
                      draggable
                      onDragStart={() => { dragIndex.current = i; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { if (dragIndex.current !== null) { moveTo(dragIndex.current, i); dragIndex.current = null; } }}
                      className="flex items-start gap-2 rounded-[10px] border border-ff-border bg-ff-surface p-2"
                    >
                      <span className="mt-1 cursor-grab text-ff-muted-2" title="Влачи за подреждане">
                        <GripVertical size={15} />
                      </span>
                      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-ff-surface-2 text-ff-ink-2">
                        <Icon size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11.5px] font-semibold text-ff-muted">{m.type}{m.embedId ? ` · ${m.embedId}` : ''}</div>
                        <input
                          defaultValue={m.caption ?? ''}
                          onBlur={(e) => onCaptionBlur(m, e.target.value)}
                          placeholder="Надпис (по избор)"
                          className="mt-1 w-full rounded-sm border border-ff-border bg-ff-surface-2 px-2 py-1 text-[12.5px] outline-none focus:border-ff-green-500"
                        />
                        <div className="mt-1 flex gap-2">
                          <MiniBtn disabled={i === 0} onClick={() => moveTo(i, i - 1)}>↑</MiniBtn>
                          <MiniBtn disabled={i === media.length - 1} onClick={() => moveTo(i, i + 1)}>↓</MiniBtn>
                        </div>
                      </div>
                      <button onClick={() => onDeleteMedia(m)} aria-label="Изтрий медия"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ff-muted hover:bg-ff-red/10 hover:text-ff-red">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
                {media.length === 0 && <p className="text-[12.5px] text-ff-muted-2">Няма добавена медия.</p>}
              </div>

              <input ref={mediaRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onAddMediaFile(f); e.target.value = ''; }} />
              <Button variant="ghost" onClick={() => mediaRef.current?.click()} disabled={busy} className="rounded-sm">
                <ImagePlus size={16} /> Качи снимка / видео
              </Button>

              <div className="flex gap-2">
                <input
                  value={embedUrl}
                  onChange={(e) => setEmbedUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAddEmbed(); } }}
                  placeholder="YouTube / Instagram адрес"
                  className={cn(field, 'flex-1 py-2 text-[13px]')}
                />
                <Button variant="soft" onClick={onAddEmbed} disabled={busy || !embedUrl.trim()} className="rounded-sm px-3">
                  <Link2 size={16} />
                </Button>
              </div>
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

function MiniBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="grid h-6 w-6 place-items-center rounded border border-ff-border bg-ff-surface-2 text-[13px] font-bold text-ff-ink-2 transition hover:bg-ff-green-50 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
