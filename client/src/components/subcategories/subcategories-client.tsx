'use client';

import { useMemo, useRef, useState } from 'react';
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
  const [prodModalSubcatId, setProdModalSubcatId] = useState<string | null>(null);
  const reorderDirty = useRef(false);
  // Local copy so bulk product (re)links from the drawer update the chips live.
  const [productList, setProductList] = useState(products);

  const productsOf = (sid: string) => productList.filter((p) => p.subcategoryId === sid);

  // Sections render + reorder in storefront order (position, then age).
  const ordered = useMemo(
    () => [...subcats].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)),
    [subcats],
  );

  // Local-only per move; persist once on leaving reorder mode (see persistReorder)
  // instead of a full-list PATCH per arrow click.
  function onReorder(orderedIds: string[]) {
    const posById = new Map(orderedIds.map((id, i) => [id, i]));
    setSubcats((list) => list.map((s) => (posById.has(s.id) ? { ...s, position: posById.get(s.id)! } : s)));
    reorderDirty.current = true;
  }

  async function persistReorder() {
    if (!reorderDirty.current) return;
    reorderDirty.current = false;
    try {
      await reorderSubcategories(ordered.map((s, i) => ({ id: s.id, position: i })));
    } catch (e) {
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
      toast.success(v ? 'Категориите са включени' : 'Категориите са изключени');
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
          <div className="text-[15.5px] font-extrabold">Категории в магазина</div>
          <div className="mt-0.5 max-w-[580px] text-[13px] leading-snug text-ff-ink-2">
            Включи това, ако искаш да групираш продуктите си в собствени категории — всяка със снимка, заглавие и кратко описание.
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
          <h2 className="mb-2 text-[19px] font-extrabold">Без категории</h2>
          <p className="mx-auto max-w-[430px] text-sm leading-relaxed text-ff-ink-2">
            В момента продуктите се показват без допълнително групиране. Включи опцията горе, за да групираш магазина в категории.
            Не е задължително — повечето малки магазини работят добре и без категории.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ff-muted">{subcats.length} категории · показват се в магазина</p>
            <div className="flex items-center gap-2">
              {subcats.length > 1 && (
                <Button
                  variant={reorderMode ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => {
                    if (reorderMode) void persistReorder(); // leaving → save once
                    setReorderMode((v) => !v);
                  }}
                  title="Подреди реда на категориите в сайта"
                >
                  {reorderMode ? <Check size={16} /> : <ArrowUpDown size={16} />}
                  {reorderMode ? 'Готово' : 'Подреди'}
                </Button>
              )}
              {!reorderMode && (
                <Button variant="primary" onClick={() => setEdit({})} className="rounded-sm">
                  <Plus size={18} /> Добави категория
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {ordered.map((s) => {
              const prods = productsOf(s.id);
              return (
                <div key={s.id} className="flex flex-col overflow-hidden rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface shadow-ff-sm">
                  <SectionPhoto tint={s.tint} imageUrl={s.imageUrl} coverCrop={s.coverCrop} aspect="4 / 3" radius={0} label={false} />
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
                        <Link2 size={14} /> Продукти в тази категория
                      </span>
                      <span className="text-[12.5px] font-extrabold text-ff-green-700">{prods.length}</span>
                    </div>
                    {prods.length ? (
                      <div className="flex flex-wrap gap-[7px]">
                        {prods.slice(0, 6).map((p) => (
                          <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-ff-border bg-ff-surface py-[5px] pl-2 pr-2.5 text-[12.5px] font-bold text-ff-ink-2">
                            <span className="h-2 w-2 rounded-full" style={{ background: p.tint ?? '#4C8A54' }} />
                            {p.name}
                          </span>
                        ))}
                        {prods.length > 6 && (
                          <button
                            type="button"
                            onClick={() => setProdModalSubcatId(s.id)}
                            className="inline-flex items-center rounded-full border border-ff-green-300 bg-ff-green-50 py-[5px] pl-2.5 pr-2.5 text-[12.5px] font-bold text-ff-green-700 hover:bg-ff-green-100"
                          >
                            + {prods.length - 6} още
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="text-[12.5px] text-ff-muted">Още няма продукти. Добави категорията към продукт от формата за продукт.</div>
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

      <SubcatProductsModal
        subcatId={prodModalSubcatId}
        subcats={subcats}
        products={productList}
        onClose={() => setProdModalSubcatId(null)}
      />
    </div>
  );
}

function SubcatProductsModal({
  subcatId,
  subcats,
  products,
  onClose,
}: {
  subcatId: string | null;
  subcats: Subcategory[];
  products: ProductOption[];
  onClose: () => void;
}) {
  if (!subcatId) return null;
  const subcat = subcats.find((s) => s.id === subcatId);
  const prods = products.filter((p) => p.subcategoryId === subcatId);
  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md overflow-hidden rounded-[var(--ff-radius)] bg-ff-surface shadow-ff-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ff-border px-6 py-4">
          <div>
            <div className="text-[15px] font-extrabold">{subcat?.name}</div>
            <div className="mt-0.5 text-[12.5px] text-ff-muted">{prods.length} продукта</div>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted-2 hover:bg-ff-surface-2 text-[18px]">
            &times;
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
          <div className="flex flex-wrap gap-[7px]">
            {prods.map((p) => (
              <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-ff-border bg-ff-surface py-[5px] pl-2 pr-2.5 text-[12.5px] font-bold text-ff-ink-2">
                <span className="h-2 w-2 rounded-full" style={{ background: p.tint ?? '#4C8A54' }} />
                {p.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
