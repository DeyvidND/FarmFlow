'use client';

import { useMemo, useState } from 'react';
import { Plus, Info, ArrowUpDown, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HelpModal } from '@/components/delivery/ui';
import { PRODUCTS_HELP } from '@/lib/help-content';
import { ProductCard } from './product-card';
import { ProductDialog } from './product-dialog';
import { ReorderableList } from '@/components/reorderable-list';
import {
  ApiError,
  addMedia,
  createProduct,
  deleteProduct,
  listProducts,
  reorderProducts,
  updateProduct,
  updateTenant,
} from '@/lib/api-client';
import { moneyFromStotinki } from '@/lib/utils';
import { usePaginatedList } from '@/hooks/use-paginated-list';
import type { Farmer, Paginated, Product, Subcategory } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** Sentinel for the "no category" group in the reorder filter. */
const NO_CAT = '__none__';
const catKey = (p: Product) => p.category ?? NO_CAT;

export function ProductsClient({
  initial,
  farmers = [],
  subcats = [],
  multiFarmer = false,
  multiSubcat = false,
  potwEnabled = false,
  potwMode = 'manual',
  featuredId = null,
}: {
  initial: Paginated<Product>;
  farmers?: Farmer[];
  subcats?: Subcategory[];
  multiFarmer?: boolean;
  multiSubcat?: boolean;
  potwEnabled?: boolean;
  potwMode?: 'manual' | 'auto';
  featuredId?: string | null;
}) {
  const { items: products, setItems: setProducts, loadMore, hasMore, loading } = usePaginatedList<Product>(
    initial,
    listProducts,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [fullEdit, setFullEdit] = useState<Product | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Product | null>(null);
  const [help, setHelp] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [catFilter, setCatFilter] = useState<string>('all');
  const [featured, setFeatured] = useState<string | null>(featuredId);

  const activeCount = products.filter((p) => p.isActive).length;
  // `total` (full count) comes from the first page; fall back to the loaded count.
  const totalCount = initial.total ?? products.length;
  const farmerName = useMemo(() => new Map(farmers.map((f) => [f.id, f.name])), [farmers]);
  const subcatName = useMemo(() => new Map(subcats.map((s) => [s.id, s.name])), [subcats]);

  // Display + reorder always follow storefront order (position, then age).
  const ordered = useMemo(
    () => [...products].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)),
    [products],
  );
  // Distinct categories present, for the per-category reorder filter.
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of ordered) seen.set(catKey(p), p.category ?? 'Без категория');
    return [...seen.entries()]; // [key, label]
  }, [ordered]);
  // The slice being reordered: everything (global) or one category.
  const reorderScope = useMemo(
    () => (catFilter === 'all' ? ordered : ordered.filter((p) => catKey(p) === catFilter)),
    [ordered, catFilter],
  );
  // The star shows only while the highlight is on and manually controlled.
  const showStar = potwEnabled && potwMode === 'manual';

  const patchLocal = (id: string, patch: Partial<Product>) =>
    setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  async function onToggle(p: Product, on: boolean) {
    patchLocal(p.id, { isActive: on }); // optimistic
    try {
      await updateProduct(p.id, { isActive: on });
      toast.success(on ? 'Продуктът е активен' : 'Продуктът е скрит');
    } catch (e) {
      patchLocal(p.id, { isActive: !on }); // rollback
      toast.error(errMsg(e));
    }
  }

  async function onToggleFeatured(p: Product) {
    const prev = featured;
    const next = featured === p.id ? null : p.id;
    setFeatured(next); // optimistic
    try {
      await updateTenant({ productOfWeekId: next });
      toast.success(next ? 'Зададен като продукт на седмицата' : 'Премахнат от продукт на седмицата');
    } catch (e) {
      setFeatured(prev); // rollback
      toast.error(errMsg(e));
    }
  }

  /** Apply a new visual order and persist normalized positions (0..N-1) for the
   *  whole catalog. A global reorder uses the dragged order directly; a
   *  per-category reorder slots the reordered category items back into the
   *  positions (indices) they held in the full list, leaving other categories
   *  untouched. We always renumber the full catalog so the order is well-defined
   *  even when stored positions were never normalized (e.g. all default 0 from the
   *  seed or freshly-created products). */
  async function onReorder(orderedIds: string[]) {
    let fullOrder: string[];
    if (catFilter === 'all') {
      fullOrder = orderedIds;
    } else {
      const scopeIds = new Set(reorderScope.map((p) => p.id));
      const nextInScope = orderedIds[Symbol.iterator]();
      // Walk the full ordered list; replace each scope slot with the next item
      // from the reordered category, keep everything else in place.
      fullOrder = ordered.map((p) => (scopeIds.has(p.id) ? (nextInScope.next().value as string) : p.id));
    }
    const posById = new Map(fullOrder.map((id, i) => [id, i] as const));

    const prev = products;
    const next = products.map((p) => ({ ...p, position: posById.get(p.id) ?? p.position }));
    setProducts(next); // optimistic
    try {
      await reorderProducts(fullOrder.map((id, i) => ({ id, position: i })));
    } catch (e) {
      setProducts(prev); // rollback
      toast.error(errMsg(e));
    }
  }

  async function onUpload(p: Product, file: File) {
    setBusyId(p.id);
    try {
      // Quick-add from the card routes through the gallery; the cover only changes
      // when the product had none (the server keeps imageUrl synced to photo 0).
      const item = await addMedia('products', p.id, file);
      patchLocal(p.id, { imageUrl: p.imageUrl ?? item.url });
      toast.success('Снимката е качена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  async function doDelete(p: Product) {
    setConfirmDelete(null);
    setBusyId(p.id);
    try {
      await deleteProduct(p.id);
      setProducts((prev) => prev.filter((x) => x.id !== p.id));
      toast.success('Продуктът е скрит');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onCreate(data: Partial<Product>) {
    const created = await createProduct(data);
    setProducts((prev) => [created, ...prev]);
    // Reopen the just-created product in the edit dialog so its photo gallery is
    // available immediately — adding images is part of the creation flow.
    setCreateOpen(false);
    setFullEdit(created);
    toast.success('Продуктът е създаден — добави снимки');
  }

  async function onFullUpdate(data: Partial<Product>) {
    if (!fullEdit) return;
    const updated = await updateProduct(fullEdit.id, data);
    patchLocal(fullEdit.id, updated);
    toast.success('Продуктът е обновен');
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-[18px] flex items-center justify-between gap-2">
        <p className="text-sm text-ff-muted">
          {activeCount} активни · {totalCount} общо
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
            <Info size={16} /> Обяснения
          </Button>
          <Button
            variant={reorderMode ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setReorderMode((v) => !v)}
            title="Подреди реда на продуктите в сайта"
          >
            {reorderMode ? <Check size={16} /> : <ArrowUpDown size={16} />}
            {reorderMode ? 'Готово' : 'Подреди'}
          </Button>
          {!reorderMode && (
            <Button variant="primary" onClick={() => setCreateOpen(true)} className="rounded-sm">
              <Plus size={18} /> Добави продукт
            </Button>
          )}
        </div>
      </div>

      {reorderMode ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ff-muted">Подреждане:</span>
            <select
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
              className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-bold text-ff-ink-2"
            >
              <option value="all">Всички (глобален ред)</option>
              {categories.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <span className="text-ff-muted">— влачи или ползвай стрелките</span>
          </div>
          {reorderScope.length === 0 ? (
            <p className="text-sm text-ff-muted">Няма продукти в тази категория.</p>
          ) : (
            <ReorderableList
              items={reorderScope}
              getId={(p) => p.id}
              onReorder={onReorder}
              renderItem={(p) => (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[14.5px] font-bold">{p.name}</div>
                    <div className="text-[12px] text-ff-muted">
                      {[p.weight, p.category].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <span className="ff-fig shrink-0 text-[15px] font-extrabold">
                    {moneyFromStotinki(p.priceStotinki)}
                  </span>
                </div>
              )}
            />
          )}
        </div>
      ) : products.length === 0 ? (
        <p className="mt-16 text-center text-sm text-ff-muted">Все още няма продукти. Добави първия си продукт.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
          {ordered.map((p, i) => (
            <ProductCard
              key={p.id}
              product={p}
              index={i}
              busy={busyId === p.id}
              onToggle={(on) => onToggle(p, on)}
              onUpload={(f) => onUpload(p, f)}
              onDelete={() => setConfirmDelete(p)}
              onEdit={() => setFullEdit(p)}
              farmerLabel={multiFarmer ? (p.farmerId ? farmerName.get(p.farmerId) ?? null : null) : undefined}
              subcatLabel={multiSubcat ? (p.subcategoryId ? subcatName.get(p.subcategoryId) ?? null : null) : undefined}
              showStar={showStar}
              featured={featured === p.id}
              onToggleFeatured={() => onToggleFeatured(p)}
            />
          ))}
        </div>
      )}

      {!reorderMode && hasMore && (
        <div className="mt-5 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
          >
            {loading ? 'Зареждане…' : 'Зареди още'}
          </button>
        </div>
      )}

      {/* Mount only while open so the dialog's state initializers read fresh props.
          The edit dialog is keyed by product id so switching products re-seeds it. */}
      {createOpen && (
        <ProductDialog
          open
          farmers={farmers}
          subcats={subcats}
          multiFarmer={multiFarmer}
          multiSubcat={multiSubcat}
          onClose={() => setCreateOpen(false)}
          onSubmit={onCreate}
        />
      )}

      {fullEdit && (
        <ProductDialog
          key={fullEdit.id}
          open
          product={fullEdit}
          farmers={farmers}
          subcats={subcats}
          multiFarmer={multiFarmer}
          multiSubcat={multiSubcat}
          onClose={() => setFullEdit(null)}
          onSubmit={onFullUpdate}
          onCoverChange={(url) => patchLocal(fullEdit.id, { imageUrl: url })}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          tone="danger"
          title={`Изтриване на „${confirmDelete.name}“?`}
          message="Продуктът ще се скрие от магазина, но името му остава запазено. Можеш да го върнеш по-късно, като го активираш отново — не създавай дубликат."
          confirmLabel="Изтрий"
          busy={busyId === confirmDelete.id}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => doDelete(confirmDelete)}
        />
      )}

      {help && <HelpModal {...PRODUCTS_HELP} onClose={() => setHelp(false)} />}
    </div>
  );
}
