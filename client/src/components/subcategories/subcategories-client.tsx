'use client';

import { useMemo, useState } from 'react';
import { Plus, Pencil, Link2, Tags, ArrowUpDown, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, reorderSubcategories, updateTenant } from '@/lib/api-client';
import { ReorderableList } from '@/components/reorderable-list';
import type { Subcategory, ProductOption } from '@/lib/types';
import { SectionPhoto } from './section-photo';
import { SubcategoryPanel } from './subcategory-panel';

export function SubcategoriesClient({
  initialSubcats,
  products,
  initialMultiSubcat,
}: {
  initialSubcats: Subcategory[];
  products: ProductOption[];
  initialMultiSubcat: boolean;
}) {
  const [subcats, setSubcats] = useState(initialSubcats);
  const [multi, setMulti] = useState(initialMultiSubcat);
  const [edit, setEdit] = useState<Partial<Subcategory> | null>(null);
  const [reorderMode, setReorderMode] = useState(false);
  // Local copy so bulk product (re)links from the drawer update the chips live.
  const [productList, setProductList] = useState(products);

  const productsOf = (sid: string) => productList.filter((p) => p.subcategoryId === sid);

  // Sections render + reorder in storefront order (position, then age).
  const ordered = useMemo(
    () => [...subcats].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)),
    [subcats],
  );

  async function onReorder(orderedIds: string[]) {
    const posById = new Map(orderedIds.map((id, i) => [id, i]));
    const prev = subcats;
    setSubcats((list) => list.map((s) => (posById.has(s.id) ? { ...s, position: posById.get(s.id)! } : s))); // optimistic
    try {
      await reorderSubcategories(orderedIds.map((id, i) => ({ id, position: i })));
    } catch (e) {
      setSubcats(prev); // rollback
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    }
  }

  function onProductsChanged(updates: { id: string; subcategoryId: string | null }[]) {
    const map = new Map(updates.map((u) => [u.id, u.subcategoryId]));
    setProductList((prev) =>
      prev.map((p) => (map.has(p.id) ? { ...p, subcategoryId: map.get(p.id)! } : p)),
    );
  }

  async function onToggle(v: boolean) {
    setMulti(v); // optimistic
    try {
      await updateTenant({ multiSubcat: v });
      toast.success(v ? 'Подкатегориите са включени' : 'Подкатегориите са изключени');
    } catch (e) {
      setMulti(!v); // rollback
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    }
  }

  function onSaved(s: Subcategory) {
    setSubcats((prev) => (prev.some((x) => x.id === s.id) ? prev.map((x) => (x.id === s.id ? s : x)) : [...prev, s]));
  }

  return (
    <div className="animate-ff-fade-up">
      {/* mode toggle banner */}
      <div
        className="mb-[18px] flex flex-wrap items-center gap-4 rounded-[14px] border p-5 shadow-ff-sm"
        style={{
          background: multi ? 'var(--ff-green-50)' : 'var(--ff-surface)',
          borderColor: multi ? 'var(--ff-green-100)' : 'var(--ff-border)',
        }}
      >
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
          style={{ background: multi ? 'var(--ff-green-100)' : 'var(--ff-surface-2)', color: multi ? 'var(--ff-green-700)' : 'var(--ff-muted)' }}
        >
          <Tags size={23} />
        </span>
        <div className="min-w-[220px] flex-1">
          <div className="text-[15.5px] font-extrabold">Подкатегории в магазина</div>
          <div className="mt-0.5 max-w-[580px] text-[13px] leading-snug text-ff-ink-2">
            Включи това, ако искаш да групираш продуктите си в собствени секции — всяка със снимка, заглавие и кратко описание.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-[13px] font-bold" style={{ color: multi ? 'var(--ff-green-700)' : 'var(--ff-muted)' }}>
            {multi ? 'Включено' : 'Изключено'}
          </span>
          <ToggleSwitch checked={multi} onChange={onToggle} />
        </div>
      </div>

      {!multi ? (
        <div className="mx-auto max-w-[560px] rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface px-6 py-14 text-center shadow-ff-sm">
          <div className="mx-auto mb-4 grid h-[60px] w-[60px] place-items-center rounded-2xl bg-ff-surface-2 text-ff-muted-2">
            <Tags size={30} />
          </div>
          <h2 className="mb-2 text-[19px] font-extrabold">Без подкатегории</h2>
          <p className="mx-auto max-w-[430px] text-sm leading-relaxed text-ff-ink-2">
            В момента продуктите се показват без допълнително групиране. Включи опцията горе, за да подредиш магазина в секции.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ff-muted">{subcats.length} подкатегории · показват се като секции в магазина</p>
            <div className="flex items-center gap-2">
              {subcats.length > 1 && (
                <Button
                  variant={reorderMode ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setReorderMode((v) => !v)}
                  title="Подреди реда на секциите в сайта"
                >
                  {reorderMode ? <Check size={16} /> : <ArrowUpDown size={16} />}
                  {reorderMode ? 'Готово' : 'Подреди'}
                </Button>
              )}
              {!reorderMode && (
                <Button variant="primary" onClick={() => setEdit({})} className="rounded-sm">
                  <Plus size={18} /> Добави подкатегория
                </Button>
              )}
            </div>
          </div>
          {reorderMode ? (
            <ReorderableList
              items={ordered}
              getId={(s) => s.id}
              onReorder={onReorder}
              renderItem={(s) => (
                <div className="flex items-center gap-2.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.tint ?? '#4C8A54' }} />
                  <div className="min-w-0">
                    <div className="truncate text-[14.5px] font-bold">{s.name}</div>
                    {s.description && <div className="truncate text-[12px] text-ff-muted">{s.description}</div>}
                  </div>
                </div>
              )}
            />
          ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">
            {ordered.map((s) => {
              const prods = productsOf(s.id);
              return (
                <div key={s.id} className="flex flex-col overflow-hidden rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface shadow-ff-sm">
                  <SectionPhoto tint={s.tint} imageUrl={s.imageUrl} height={108} radius={0} label={false} />
                  <div className="flex items-start gap-2.5 border-b border-ff-border-2 px-[18px] pb-3 pt-3.5">
                    <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.tint ?? '#4C8A54' }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[17px] font-extrabold tracking-[-0.01em]">{s.name}</div>
                      {s.description && <p className="mt-[3px] text-[13px] leading-snug text-ff-ink-2">{s.description}</p>}
                    </div>
                    <button
                      onClick={() => setEdit(s)}
                      aria-label="Редактирай"
                      className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"
                    >
                      <Pencil size={16} />
                    </button>
                  </div>
                  <div className="flex-1 bg-ff-surface-2 px-[18px] pb-4 pt-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
                        <Link2 size={14} /> Свързани продукти
                      </span>
                      <span className="text-[12.5px] font-extrabold text-ff-green-700">{prods.length}</span>
                    </div>
                    {prods.length ? (
                      <div className="flex flex-wrap gap-[7px]">
                        {prods.map((p) => (
                          <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-ff-border bg-ff-surface py-[5px] pl-2 pr-2.5 text-[12.5px] font-bold text-ff-ink-2">
                            <span className="h-2 w-2 rounded-full" style={{ background: p.tint ?? '#4C8A54' }} />
                            {p.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[12.5px] text-ff-muted">Още няма продукти. Свържи от „Продукти“.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          )}
        </>
      )}

      {edit && (
        <SubcategoryPanel
          subcat={edit}
          products={productList}
          onClose={() => setEdit(null)}
          onSaved={onSaved}
          onProductsChanged={onProductsChanged}
        />
      )}
    </div>
  );
}
