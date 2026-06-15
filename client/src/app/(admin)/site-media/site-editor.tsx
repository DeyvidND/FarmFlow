'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, RotateCcw, Upload, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  getSiteCopy, updateSiteCopy, getEditableManifest, uploadSiteMedia, deleteSiteMedia,
  type EditableManifest, type ManifestSlot, type SiteFaqItem,
} from '@/lib/api-client';
import { PreviewPane, type PreviewHandle } from './preview-pane';

const ACCEPT = 'image/jpeg,image/png,image/webp';

export function SiteEditor() {
  const [manifest, setManifest] = useState<EditableManifest | null>(null);
  const [manifestErr, setManifestErr] = useState(false);
  const [copy, setCopy] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<Record<string, { url: string }>>({});
  const [faq, setFaq] = useState<SiteFaqItem[]>([]);
  const [siteUrl, setSiteUrl] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busyMedia, setBusyMedia] = useState<Record<string, boolean>>({});
  const [showPreview, setShowPreview] = useState(false); // mobile toggle
  const preview = useRef<PreviewHandle>(null);

  // Load overrides, then the manifest from the storefront.
  useEffect(() => {
    getSiteCopy().then((d) => {
      setCopy(d.copy); setMedia(d.media); setFaq(d.faq); setSiteUrl(d.siteUrl); setUrlDraft(d.siteUrl);
      if (d.siteUrl) {
        getEditableManifest(d.siteUrl)
          .then((m) => { setManifest(m); try { localStorage.setItem('ff-manifest:' + d.siteUrl, JSON.stringify(m)); } catch {} })
          .catch(() => {
            const cached = (() => { try { return JSON.parse(localStorage.getItem('ff-manifest:' + d.siteUrl) || 'null'); } catch { return null; } })();
            if (cached) setManifest(cached); else setManifestErr(true);
          });
      }
    }).catch(() => toast.error('Неуспешно зареждане')).finally(() => setLoading(false));
  }, []);

  function setField(key: string, value: string) { setCopy((c) => ({ ...c, [key]: value })); setDirty(true); }
  function resetField(key: string) { setCopy((c) => { const n = { ...c }; delete n[key]; return n; }); setDirty(true); }
  function setFaqItem(i: number, patch: Partial<SiteFaqItem>) { setFaq((f) => f.map((it, idx) => idx === i ? { ...it, ...patch } : it)); setDirty(true); }
  function addFaq() { setFaq((f) => [...f, { q: '', a: '' }]); setDirty(true); }
  function removeFaq(i: number) { setFaq((f) => f.filter((_, idx) => idx !== i)); setDirty(true); }
  function moveFaq(i: number, dir: -1 | 1) {
    setFaq((f) => { const j = i + dir; if (j < 0 || j >= f.length) return f; const n = [...f]; [n[i], n[j]] = [n[j], n[i]]; return n; });
    setDirty(true);
  }

  // route per page comes straight from the manifest; section is the slot's section id.
  const routeOfSection = useMemo(() => {
    const m: Record<string, string> = {};
    manifest?.pages.forEach((p) => p.sections.forEach((s) => { m[s.id] = p.route; }));
    return m;
  }, [manifest]);
  function focusSlot(sectionId: string) {
    preview.current?.focusSection(routeOfSection[sectionId] ?? '/', sectionId);
    setShowPreview(true);
  }

  async function uploadPhoto(slotKey: string, file: File) {
    setBusyMedia((b) => ({ ...b, [slotKey]: true }));
    try {
      const { url } = await uploadSiteMedia(slotKey, file);
      setMedia((m) => ({ ...m, [slotKey]: { url } }));
      toast.success('Снимката е качена');
      preview.current?.reload();
    } catch { toast.error('Неуспешно качване'); }
    finally { setBusyMedia((b) => ({ ...b, [slotKey]: false })); }
  }
  async function removePhoto(slotKey: string) {
    setBusyMedia((b) => ({ ...b, [slotKey]: true }));
    try {
      await deleteSiteMedia(slotKey);
      setMedia((m) => { const n = { ...m }; delete n[slotKey]; return n; });
      toast.success('Снимката е премахната');
      preview.current?.reload();
    } catch { toast.error('Неуспешно изтриване'); }
    finally { setBusyMedia((b) => ({ ...b, [slotKey]: false })); }
  }

  async function save() {
    setSaving(true);
    try {
      const cleanCopy: Record<string, string> = {};
      for (const [k, v] of Object.entries(copy)) if (v.trim()) cleanCopy[k] = v.trim();
      const cleanFaq = faq.map((f) => ({ q: f.q.trim(), a: f.a.trim() })).filter((f) => f.q || f.a);
      const res = await updateSiteCopy({ copy: cleanCopy, faq: cleanFaq, siteUrl: urlDraft.trim() });
      setCopy(res.copy); setFaq(res.faq); setSiteUrl(res.siteUrl); setUrlDraft(res.siteUrl);
      setDirty(false);
      toast.success('Промените са запазени');
      preview.current?.reload();
    } catch { toast.error('Неуспешно записване'); }
    finally { setSaving(false); }
  }

  if (loading) return <p className="text-[14px] text-ff-muted">Зареждане…</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* LEFT: editor */}
      <div className="flex min-w-0 flex-col gap-6">
        {/* Site URL */}
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
          <label htmlFor="ff-site-url" className="text-[13px] font-semibold text-ff-ink">Адрес на сайта</label>
          <p className="mb-2 mt-0.5 text-[12px] text-ff-muted">За преглед на живо до полетата. Напр. https://moqta-ferma.bg</p>
          <input id="ff-site-url" type="url" inputMode="url" placeholder="https://…" value={urlDraft}
            onChange={(e) => { setUrlDraft(e.target.value); setDirty(true); }}
            className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink" />
        </div>

        {manifestErr && (
          <div className="rounded-2xl border border-ff-border bg-ff-surface p-4 text-[13.5px] text-ff-muted shadow-ff-sm">
            Структурата на сайта не можа да се зареди. Провери адреса и опитай пак.
          </div>
        )}

        {manifest?.pages.map((page) => (
          <section key={page.route}>
            <h2 className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2">{page.label}</h2>
            <div className="flex flex-col gap-5">
              {page.sections.map((sec) => (
                <div key={sec.id} className="flex flex-col gap-3 rounded-2xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
                  <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted-2">{sec.label}</div>
                  {sec.slots.map((slot) => <SlotField key={slot.key} slot={slot} sectionId={sec.id}
                    value={copy[slot.key] ?? ''} mediaUrl={media[slot.key]?.url} busy={!!busyMedia[slot.key]}
                    onText={setField} onReset={resetField} onFocus={focusSlot}
                    onUpload={uploadPhoto} onRemove={removePhoto} />)}
                </div>
              ))}
              {page.faq && (
                <FaqEditor faq={faq} onItem={setFaqItem} onAdd={addFaq} onRemove={removeFaq} onMove={moveFaq} />
              )}
            </div>
          </section>
        ))}

        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-ff-border bg-ff-surface py-3 shadow-[0_-6px_16px_-12px_rgba(0,0,0,0.3)]">
          <button type="button" onClick={() => setShowPreview((v) => !v)}
            className="flex items-center gap-1.5 rounded-sm px-3 py-2 text-[13.5px] text-ff-muted hover:text-ff-ink lg:hidden">
            <Eye size={15} /> {showPreview ? 'Скрий преглед' : 'Преглед'}
          </button>
          <span className="hidden lg:block" />
          <Button type="button" disabled={!dirty || saving} onClick={save} className="rounded-sm px-6 py-2.5 text-[14px]">
            {saving ? 'Записване…' : 'Запази промените'}
          </Button>
        </div>
      </div>

      {/* RIGHT: preview (sticky on desktop; toggle on mobile) */}
      <div className={`${showPreview ? 'block' : 'hidden'} lg:block`}>
        <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-7rem)]">
          <PreviewPane ref={preview} siteUrl={siteUrl} />
        </div>
      </div>
    </div>
  );
}

function SlotField({ slot, sectionId, value, mediaUrl, busy, onText, onReset, onFocus, onUpload, onRemove }: {
  slot: ManifestSlot; sectionId: string; value: string; mediaUrl?: string; busy: boolean;
  onText: (k: string, v: string) => void; onReset: (k: string) => void; onFocus: (sectionId: string) => void;
  onUpload: (k: string, f: File) => void; onRemove: (k: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (slot.kind === 'image') {
    return (
      <div className="flex items-center gap-3">
        <div className="grid h-14 w-20 shrink-0 place-items-center overflow-hidden rounded-sm border border-ff-border bg-[#E4EADF]" style={{ aspectRatio: slot.ratio }}>
          {mediaUrl ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={mediaUrl} alt={slot.label} className="h-full w-full object-cover" /> : <span className="px-1 text-center text-[9px] uppercase text-[#76836E]">{slot.label}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ff-ink">{slot.label}</div>
          <div className="text-[12px] text-ff-muted">Снимка {slot.ratio.replace('/', ':')}{slot.note ? ` · ${slot.note}` : ''}</div>
        </div>
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(slot.key, f); e.target.value = ''; }} />
        <Button variant="soft" type="button" disabled={busy} onClick={() => { onFocus(sectionId); inputRef.current?.click(); }}
          className="gap-1.5 rounded-sm px-3 py-2 text-[13px]"><Upload size={14} /> {mediaUrl ? 'Смени' : 'Качи'}</Button>
        {mediaUrl && <button type="button" disabled={busy} onClick={() => onRemove(slot.key)} title="Премахни" className="p-1 text-ff-red hover:bg-ff-red/10 rounded-sm"><Trash2 size={14} /></button>}
      </div>
    );
  }
  const overridden = value.trim().length > 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={slot.key} className="text-[13px] font-semibold text-ff-ink">{slot.label}</label>
        {overridden && <button type="button" onClick={() => onReset(slot.key)} className="flex items-center gap-1 text-[12px] text-ff-muted hover:text-ff-ink" title="Върни оригинала"><RotateCcw size={12} /> Върни оригинала</button>}
      </div>
      {slot.multiline
        ? <textarea id={slot.key} rows={3} value={value} placeholder={slot.default} onFocus={() => onFocus(sectionId)} onChange={(e) => onText(slot.key, e.target.value)} className="w-full resize-y rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2" />
        : <input id={slot.key} type="text" value={value} placeholder={slot.default} onFocus={() => onFocus(sectionId)} onChange={(e) => onText(slot.key, e.target.value)} className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2" />}
    </div>
  );
}

function FaqEditor({ faq, onItem, onAdd, onRemove, onMove }: {
  faq: SiteFaqItem[]; onItem: (i: number, p: Partial<SiteFaqItem>) => void; onAdd: () => void; onRemove: (i: number) => void; onMove: (i: number, d: -1 | 1) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted-2">Въпроси и отговори</div>
      {faq.length === 0 && <p className="text-[13px] text-ff-muted">Няма въпроси. Добави първия.</p>}
      {faq.map((item, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-sm border border-ff-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-ff-muted-2">Въпрос {i + 1}</span>
            <div className="flex gap-1">
              <button type="button" onClick={() => onMove(i, -1)} disabled={i === 0} title="Нагоре" className="p-1 text-ff-muted hover:text-ff-ink disabled:opacity-30"><ArrowUp size={14} /></button>
              <button type="button" onClick={() => onMove(i, 1)} disabled={i === faq.length - 1} title="Надолу" className="p-1 text-ff-muted hover:text-ff-ink disabled:opacity-30"><ArrowDown size={14} /></button>
              <button type="button" onClick={() => onRemove(i)} title="Изтрий" className="p-1 text-ff-red hover:bg-ff-red/10 rounded-sm"><Trash2 size={14} /></button>
            </div>
          </div>
          <input type="text" value={item.q} placeholder="Въпрос" onChange={(e) => onItem(i, { q: e.target.value })} className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2" />
          <textarea rows={2} value={item.a} placeholder="Отговор" onChange={(e) => onItem(i, { a: e.target.value })} className="w-full resize-y rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2" />
        </div>
      ))}
      <Button variant="soft" type="button" onClick={onAdd} className="self-start gap-1.5 rounded-sm py-2 text-[13.5px]"><Plus size={15} /> Добави въпрос</Button>
    </div>
  );
}
