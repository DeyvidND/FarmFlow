'use client';

import { useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Link2, Users, ArrowUpDown, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, reorderFarmers, updateTenant } from '@/lib/api-client';
import { ReorderableList } from '@/components/reorderable-list';
import type { Farmer, ProductOption, FarmerAccess } from '@/lib/types';
import { Avatar } from './avatar';
import { SectionPhoto } from '@/components/subcategories/section-photo';
import { FarmerPanel } from './farmer-panel';
import { AccessControl } from './access-control';

export function FarmersClient({
  initialFarmers,
  products,
  initialMultiFarmer,
  initialAccess = {},
}: {
  initialFarmers: Farmer[];
  products: ProductOption[];
  initialMultiFarmer: boolean;
  initialAccess?: Record<string, FarmerAccess>;
}) {
  const [farmers, setFarmers] = useState(initialFarmers);
  const [multi, setMulti] = useState(initialMultiFarmer);
  const [edit, setEdit] = useState<Partial<Farmer> | null>(null);
  const [reorderMode, setReorderMode] = useState(false);
  const [prodModalFarmerId, setProdModalFarmerId] = useState<string | null>(null);
  const reorderDirty = useRef(false);
  // Local copy so bulk product (re)links from the drawer update the chips live.
  const [productList, setProductList] = useState(products);

  const productsOf = (fid: string) => productList.filter((p) => p.farmerId === fid);

  // Cards render + reorder in storefront order (position, then age).
  const ordered = useMemo(
    () => [...farmers].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)),
    [farmers],
  );

  // Local-only per move; persist once on leaving reorder mode (see persistReorder)
  // instead of a full-list PATCH per arrow click.
  function onReorder(orderedIds: string[]) {
    const posById = new Map(orderedIds.map((id, i) => [id, i]));
    setFarmers((list) => list.map((f) => (posById.has(f.id) ? { ...f, position: posById.get(f.id)! } : f)));
    reorderDirty.current = true;
  }

  async function persistReorder() {
    if (!reorderDirty.current) return;
    reorderDirty.current = false;
    try {
      await reorderFarmers(ordered.map((f, i) => ({ id: f.id, position: i })));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    }
  }

  function onProductsChanged(updates: { id: string; farmerId: string | null }[]) {
    const map = new Map(updates.map((u) => [u.id, u.farmerId]));
    setProductList((prev) => prev.map((p) => (map.has(p.id) ? { ...p, farmerId: map.get(p.id)! } : p)));
  }

  async function onToggle(v: boolean) {
    setMulti(v); // optimistic
    try {
      await updateTenant({ multiFarmer: v });
      toast.success(v ? 'Режим с няколко фермери — включен' : 'Единичен производител');
    } catch (e) {
      setMulti(!v); // rollback
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    }
  }

  function onSaved(f: Farmer) {
    setFarmers((prev) => (prev.some((x) => x.id === f.id) ? prev.map((x) => (x.id === f.id ? f : x)) : [...prev, f]));
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
          <Users size={23} />
        </span>
        <div className="min-w-[220px] flex-1">
          <div className="text-[15.5px] font-extrabold">Няколко фермери в това стопанство</div>
          <div className="mt-0.5 max-w-[580px] text-[13px] leading-snug text-ff-ink-2">
            Включи това само ако зад един уебсайт стоят повече от един производител — тогава всеки продукт се свързва с конкретен фермер.
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
            <Users size={30} />
          </div>
          <h2 className="mb-2 text-[19px] font-extrabold">Един производител</h2>
          <p className="mx-auto max-w-[430px] text-sm leading-relaxed text-ff-ink-2">
            В момента всички продукти са на едно стопанство. Ако започнете да продавате продукти от няколко фермери под един магазин, включете опцията горе.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ff-muted">{farmers.length} фермери · продуктите им се показват в общия магазин</p>
            <div className="flex items-center gap-2">
              {farmers.length > 1 && (
                <Button
                  variant={reorderMode ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => {
                    if (reorderMode) void persistReorder(); // leaving → save once
                    setReorderMode((v) => !v);
                  }}
                  title="Подреди реда на фермерите в сайта"
                >
                  {reorderMode ? <Check size={16} /> : <ArrowUpDown size={16} />}
                  {reorderMode ? 'Готово' : 'Подреди'}
                </Button>
              )}
              {!reorderMode && (
                <Button variant="primary" onClick={() => setEdit({})} className="rounded-sm">
                  <Plus size={18} /> Добави фермер
                </Button>
              )}
            </div>
          </div>
          {reorderMode ? (
            <ReorderableList
              items={ordered}
              getId={(f) => f.id}
              onReorder={onReorder}
              renderItem={(f) => (
                <div className="flex items-center gap-2.5">
                  <Avatar name={f.name} tint={f.tint} imageUrl={f.imageUrl} coverCrop={f.coverCrop} size={34} />
                  <div className="min-w-0">
                    <div className="truncate text-[14.5px] font-bold">{f.name}</div>
                    {f.role && <div className="truncate text-[12px] text-ff-muted">{f.role}</div>}
                  </div>
                </div>
              )}
            />
          ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ordered.map((f) => {
              const prods = productsOf(f.id);
              return (
                <div key={f.id} className="flex flex-col overflow-hidden rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface shadow-ff-sm">
                  <SectionPhoto tint={f.tint} imageUrl={f.imageUrl} coverCrop={f.coverCrop} aspect="3 / 2" radius={0} label={false} />
                  <div className="flex items-start gap-3.5 border-b border-ff-border-2 px-[18px] pb-3.5 pt-[18px]">
                    <div className="min-w-0 flex-1">
                      <div className="text-[17px] font-extrabold tracking-[-0.01em]">{f.name}</div>
                      <div className="mt-px text-[13px] font-bold" style={{ color: f.tint ?? 'var(--ff-green-700)' }}>{f.role}</div>
                      <div className="mt-[3px] text-xs text-ff-muted">
                        {f.since && `от ${f.since} г. · `}
                        {f.phone}
                      </div>
                    </div>
                    <button
                      onClick={() => setEdit(f)}
                      aria-label="Редактирай"
                      className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"
                    >
                      <Pencil size={16} />
                    </button>
                  </div>
                  {f.bio && <div className="flex-1 px-[18px] py-3.5 text-[13.5px] leading-normal text-ff-ink-2">{f.bio}</div>}
                  <div className="border-t border-ff-border-2 bg-ff-surface-2 px-[18px] pb-4 pt-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
                        <Link2 size={14} /> Свързани продукти
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
                            onClick={() => setProdModalFarmerId(f.id)}
                            className="inline-flex items-center rounded-full border border-ff-green-300 bg-ff-green-50 py-[5px] pl-2.5 pr-2.5 text-[12.5px] font-bold text-ff-green-700 hover:bg-ff-green-100"
                          >
                            + {prods.length - 6} още
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="text-[12.5px] text-ff-muted">Още няма продукти. Свържи от „Продукти&rdquo;.</div>
                    )}
                  </div>
                  <AccessControl farmerId={f.id} initial={initialAccess[f.id]} />
                </div>
              );
            })}
          </div>
          )}
        </>
      )}

      {edit && (
        <FarmerPanel
          farmer={edit}
          products={productList}
          onClose={() => setEdit(null)}
          onSaved={onSaved}
          onProductsChanged={onProductsChanged}
        />
      )}

      <ProductsModal
        farmerId={prodModalFarmerId}
        farmers={farmers}
        products={productList}
        onClose={() => setProdModalFarmerId(null)}
      />
    </div>
  );
}

function ProductsModal({
  farmerId,
  farmers,
  products,
  onClose,
}: {
  farmerId: string | null;
  farmers: Farmer[];
  products: ProductOption[];
  onClose: () => void;
}) {
  if (!farmerId) return null;
  const farmer = farmers.find((f) => f.id === farmerId);
  const prods = products.filter((p) => p.farmerId === farmerId);
  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md overflow-hidden rounded-[var(--ff-radius)] bg-ff-surface shadow-ff-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ff-border px-6 py-4">
          <div>
            <div className="text-[15px] font-extrabold">{farmer?.name}</div>
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
