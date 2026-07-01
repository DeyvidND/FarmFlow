'use client';

import { useMemo, useRef, useState } from 'react';
import { Plus, Info, ArrowUpDown, Check, PackageX } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HelpModal } from '@/components/delivery/ui';
import { PRODUCTS_HELP } from '@/lib/help-content';
import { ProductCard } from './product-card';
import { ProductDialog } from './product-dialog';
import { ProductOfWeekPanel } from './product-of-week-panel';
import { CourierSettingsModal } from './courier-settings-modal';
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
  type ProductWrite,
} from '@/lib/api-client';
import { moneyFromStotinki } from '@/lib/utils';
import { usePaginatedList } from '@/hooks/use-paginated-list';
import type { Farmer, Paginated, Product, Subcategory } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const NO_CAT = '__none__';
const catKey = (p: Product) => p.subcategoryId ?? NO_CAT;

export function ProductsClient({
  initial,
  availability = {},
  farmers = [],
  subcats = [],
  multiFarmer = false,
  multiSubcat = false,
  potwEnabled = false,
  potwMode = 'manual',
  featuredId = null,
  potwNote = '',
  role = 'admin',
}: {
  initial: Paginated<Product>;
  /** productId → remaining stock from «Задай наличност» (absent = unlimited). */
  availability?: Record<string, number>;
  farmers?: Farmer[];
  subcats?: Subcategory[];
  multiFarmer?: boolean;
  multiSubcat?: boolean;
  potwEnabled?: boolean;
  potwMode?: 'manual' | 'auto';
  featuredId?: string | null;
  potwNote?: string;
  /** Producer sub-account: scoped to own products, no POTW / catalog-reorder. */
  role?: 'admin' | 'farmer';
}) {
  // «Продукт на седмицата» and the storefront catalog order are shop-wide, owner-only
  // concerns — a producer manages only the contents of their own products.
  const isFarmer = role === 'farmer';
  const { items: products, setItems: setProducts, loadMore, hasMore, loading } = usePaginatedList<Product>(
    initial,
    listProducts,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [fullEdit, setFullEdit] = useState<Product | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Product | null>(null);
  const [help, setHelp] = useState(false);
  const [courierOpen, setCourierOpen] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  // True once the order changed in reorder mode — drives a single persist on exit.
  const reorderDirty = useRef(false);
  const [catFilter, setCatFilter] = useState<string>('all');
  const [featured, setFeatured] = useState<string | null>(featuredId);
  const [q, setQ] = useState('');
  const [farmerFilter, setFarmerFilter] = useState<string>('all');
  const [subcatFilter, setSubcatFilter] = useState<string>('all');

  // Local copy of the productId → remaining-stock map so the card badge updates
  // the moment stock is set/cleared from the dialog, without a full page refetch.
  const [avail, setAvail] = useState<Record<string, number>>(availability);
  // Reflect a just-saved stock value on the card badge. `null` = cleared → unlimited
  // (drop the key); a number ≈ remaining right after a set (sold-this-session ~0).
  const patchAvail = (id: string, stock: number | null | undefined) => {
    if (stock === undefined) return; // stock wasn't touched
    setAvail((prev) => {
      const next = { ...prev };
      if (stock === null) delete next[id];
      else next[id] = stock;
      return next;
    });
  };

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
  // Subcategories that have at least one product, in storefront order, for the reorder filter.
  const categories = useMemo(() => {
    const withSubcat = new Set(ordered.filter((p) => p.subcategoryId).map((p) => p.subcategoryId as string));
    return subcats.filter((s) => withSubcat.has(s.id)).map((s) => [s.id, s.name] as [string, string]);
  }, [ordered, subcats]);
  // The slice being reordered: everything (global) or one category.
  const reorderScope = useMemo(
    () => (catFilter === 'all' ? ordered : ordered.filter((p) => catKey(p) === catFilter)),
    [ordered, catFilter],
  );
  // Client-side filter (search + farmer + subcat) — applied on top of the sorted order.
  const filtered = useMemo(
    () =>
      ordered.filter((p) => {
        if (q.trim() && !p.name.toLowerCase().includes(q.trim().toLowerCase())) return false;
        if (farmerFilter !== 'all' && p.farmerId !== farmerFilter) return false;
        if (subcatFilter !== 'all' && p.subcategoryId !== subcatFilter) return false;
        return true;
      }),
    [ordered, q, farmerFilter, subcatFilter],
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
  // Each arrow click / drag updates only LOCAL order; we persist ONCE when the
  // farmer leaves reorder mode ("Готово"). Previously every single move fired a
  // full-list PATCH (move up 10 slots = 10 requests × N items + 10 cache busts),
  // which on the mobile/keyboard arrow path is the common case.
  function onReorder(orderedIds: string[]) {
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
    setProducts((prev) => prev.map((p) => ({ ...p, position: posById.get(p.id) ?? p.position })));
    reorderDirty.current = true;
  }

  /** Persist the current local order once, on leaving reorder mode. `ordered` is
   *  sorted by position, so it already reflects every local move. */
  async function persistReorder() {
    if (!reorderDirty.current) return;
    reorderDirty.current = false;
    try {
      await reorderProducts(ordered.map((p, i) => ({ id: p.id, position: i })));
    } catch (e) {
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
      toast.success('Продуктът е изтрит');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onCreate(data: ProductWrite, files?: File[]) {
    const created = await createProduct(data);
    setProducts((prev) => [created, ...prev]);
    patchAvail(created.id, data.stock);
    setCreateOpen(false);
    if (files && files.length) {
      // Photos were picked in the create dialog — upload them now that we have an
      // id. The server keeps imageUrl synced to photo 0, so the first one is cover.
      let cover = created.imageUrl ?? null;
      for (const f of files) {
        try {
          const item = await addMedia('products', created.id, f);
          cover = cover ?? item.url;
        } catch (e) {
          toast.error(errMsg(e));
        }
      }
      patchLocal(created.id, { imageUrl: cover });
      toast.success('Продуктът е създаден');
    } else {
      // No photos picked — reopen in the edit dialog so the gallery is one tap away.
      setFullEdit(created);
      toast.success('Продуктът е създаден — добави снимки');
    }
  }

  async function onFullUpdate(data: ProductWrite) {
    if (!fullEdit) return;
    const updated = await updateProduct(fullEdit.id, data);
    patchLocal(fullEdit.id, updated);
    patchAvail(fullEdit.id, data.stock);
    toast.success('Продуктът е обновен');
  }

  return (
    <div className="animate-ff-fade-up">

      {!reorderMode && !isFarmer && (
        <div className="mb-5">
          <ProductOfWeekPanel
            initialEnabled={potwEnabled}
            initialMode={potwMode}
            initialProductId={featuredId}
            initialNote={potwNote}
          />
        </div>
      )}

      <div className="mb-[18px] flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ff-muted">
          {activeCount} активни · {totalCount} общо
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
            <Info size={16} /> Обяснения
          </Button>
          {!reorderMode && (
            <Button variant="ghost" size="sm" onClick={() => setCourierOpen(true)}>
              <PackageX size={16} /> Куриер
            </Button>
          )}
          {!isFarmer && (
            <Button
              variant={reorderMode ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => {
                if (reorderMode) void persistReorder(); // leaving → save once
                setReorderMode((v) => !v);
              }}
              title="Подреди реда на продуктите в сайта"
            >
              {reorderMode ? <Check size={16} /> : <ArrowUpDown size={16} />}
              {reorderMode ? 'Готово' : 'Подреди'}
            </Button>
          )}
          {!reorderMode && (
            <Button variant="primary" onClick={() => setCreateOpen(true)} className="rounded-sm">
              <Plus size={18} /> Добави продукт
            </Button>
          )}
        </div>
      </div>

      {!reorderMode && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Търси продукт…"
            className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] text-ff-ink placeholder:text-ff-muted focus:outline-none"
          />
          {multiFarmer && (
            <select
              value={farmerFilter}
              onChange={(e) => setFarmerFilter(e.target.value)}
              className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-bold text-ff-ink-2"
            >
              <option value="all">Всички стопани</option>
              {farmers.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
          {multiSubcat && (
            <select
              value={subcatFilter}
              onChange={(e) => setSubcatFilter(e.target.value)}
              className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-bold text-ff-ink-2"
            >
              <option value="all">Всички категории</option>
              {subcats.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

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
            <span className="text-ff-muted">— редът е уникален за всяка категория и за „Всички&quot;</span>
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
                      {[p.weight, p.subcategoryId ? subcatName.get(p.subcategoryId) : null].filter(Boolean).join(' · ') || '—'}
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
      ) : filtered.length === 0 ? (
        <p className="mt-10 text-center text-sm text-ff-muted">Няма продукти, отговарящи на филтрите.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
          {filtered.map((p, i) => (
            <ProductCard
              key={p.id}
              product={p}
              index={i}
              remaining={avail[p.id] ?? null}
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

      <CourierSettingsModal
        open={courierOpen}
        onClose={() => setCourierOpen(false)}
        farmers={farmers}
        multiFarmer={multiFarmer}
        onSaved={(patches) =>
          patches.forEach(({ id, courierDisabled }) => patchLocal(id, { courierDisabled }))
        }
      />
    </div>
  );
}
