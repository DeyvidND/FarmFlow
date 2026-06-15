'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  getSiteCopy,
  updateSiteCopy,
  type SiteCopySlotDef,
  type SiteFaqItem,
} from '@/lib/api-client';

export function CopyTab() {
  const [catalog, setCatalog] = useState<SiteCopySlotDef[]>([]);
  const [copy, setCopy] = useState<Record<string, string>>({});
  const [faq, setFaq] = useState<SiteFaqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    getSiteCopy()
      .then((res) => {
        setCatalog(res.catalog);
        setCopy(res.copy);
        setFaq(res.faq);
      })
      .catch(() => toast.error('Неуспешно зареждане'))
      .finally(() => setLoading(false));
  }, []);

  // Group catalog by page, preserving order.
  const groups = useMemo(() => {
    const g: { page: string; slots: SiteCopySlotDef[] }[] = [];
    for (const slot of catalog) {
      let row = g.find((x) => x.page === slot.page);
      if (!row) { row = { page: slot.page, slots: [] }; g.push(row); }
      row.slots.push(slot);
    }
    return g;
  }, [catalog]);

  function setField(key: string, value: string) {
    setCopy((c) => ({ ...c, [key]: value }));
    setDirty(true);
  }
  function resetField(key: string) {
    setCopy((c) => { const n = { ...c }; delete n[key]; return n; });
    setDirty(true);
  }
  function setFaqItem(i: number, patch: Partial<SiteFaqItem>) {
    setFaq((f) => f.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
    setDirty(true);
  }
  function addFaq() { setFaq((f) => [...f, { q: '', a: '' }]); setDirty(true); }
  function removeFaq(i: number) { setFaq((f) => f.filter((_, idx) => idx !== i)); setDirty(true); }
  function moveFaq(i: number, dir: -1 | 1) {
    setFaq((f) => {
      const j = i + dir;
      if (j < 0 || j >= f.length) return f;
      const n = [...f];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      // Drop blank overrides (= use default) and fully-empty FAQ rows before sending.
      const cleanCopy: Record<string, string> = {};
      for (const [k, v] of Object.entries(copy)) if (v.trim()) cleanCopy[k] = v.trim();
      const cleanFaq = faq
        .map((f) => ({ q: f.q.trim(), a: f.a.trim() }))
        .filter((f) => f.q || f.a);
      const res = await updateSiteCopy({ copy: cleanCopy, faq: cleanFaq });
      setCopy(res.copy);
      setFaq(res.faq);
      setDirty(false);
      toast.success('Промените са запазени');
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-[14px] text-ff-muted">Зареждане…</p>;

  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.page}>
          <h2 className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2">
            {group.page}
          </h2>
          <div className="flex flex-col gap-4 rounded-2xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
            {group.slots.map((slot) => {
              const value = copy[slot.key] ?? '';
              const overridden = value.trim().length > 0;
              return (
                <div key={slot.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[13px] font-semibold text-ff-ink">{slot.label}</label>
                    {overridden && (
                      <button
                        type="button"
                        onClick={() => resetField(slot.key)}
                        className="flex items-center gap-1 text-[12px] text-ff-muted hover:text-ff-ink"
                        title="Върни оригиналния текст"
                      >
                        <RotateCcw size={12} /> Върни оригинала
                      </button>
                    )}
                  </div>
                  {slot.multiline ? (
                    <textarea
                      rows={3}
                      value={value}
                      placeholder={slot.default}
                      onChange={(e) => setField(slot.key, e.target.value)}
                      className="w-full resize-y rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2"
                    />
                  ) : (
                    <input
                      type="text"
                      value={value}
                      placeholder={slot.default}
                      onChange={(e) => setField(slot.key, e.target.value)}
                      className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2"
                    />
                  )}
                </div>
              );
            })}

            {/* FAQ page-group gets a list editor below its heading fields. */}
            {group.page === 'FAQ' && (
              <div className="mt-2 flex flex-col gap-3 border-t border-ff-border pt-4">
                <div className="text-[13px] font-semibold text-ff-ink">Въпроси и отговори</div>
                {faq.length === 0 && (
                  <p className="text-[13px] text-ff-muted">Няма въпроси. Добави първия.</p>
                )}
                {faq.map((item, i) => (
                  <div key={i} className="flex flex-col gap-2 rounded-sm border border-ff-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-ff-muted-2">Въпрос {i + 1}</span>
                      <div className="flex gap-1">
                        <button type="button" onClick={() => moveFaq(i, -1)} disabled={i === 0} title="Нагоре" className="p-1 text-ff-muted hover:text-ff-ink disabled:opacity-30"><ArrowUp size={14} /></button>
                        <button type="button" onClick={() => moveFaq(i, 1)} disabled={i === faq.length - 1} title="Надолу" className="p-1 text-ff-muted hover:text-ff-ink disabled:opacity-30"><ArrowDown size={14} /></button>
                        <button type="button" onClick={() => removeFaq(i)} title="Изтрий" className="p-1 text-ff-red hover:bg-ff-red/10 rounded-sm"><Trash2 size={14} /></button>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={item.q}
                      placeholder="Въпрос"
                      onChange={(e) => setFaqItem(i, { q: e.target.value })}
                      className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2"
                    />
                    <textarea
                      rows={2}
                      value={item.a}
                      placeholder="Отговор"
                      onChange={(e) => setFaqItem(i, { a: e.target.value })}
                      className="w-full resize-y rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2"
                    />
                  </div>
                ))}
                <Button variant="soft" type="button" onClick={addFaq} className="self-start gap-1.5 rounded-sm py-2 text-[13.5px]">
                  <Plus size={15} /> Добави въпрос
                </Button>
              </div>
            )}
          </div>
        </section>
      ))}

      <div className="sticky bottom-0 flex justify-end border-t border-ff-border bg-ff-bg/80 py-3 backdrop-blur">
        <Button type="button" disabled={!dirty || saving} onClick={save} className="rounded-sm px-6 py-2.5 text-[14px]">
          {saving ? 'Записване…' : 'Запази промените'}
        </Button>
      </div>
    </div>
  );
}
