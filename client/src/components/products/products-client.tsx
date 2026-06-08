'use client';

import { useMemo, useState } from 'react';
import { Plus, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HelpModal } from '@/components/delivery/ui';
import { PRODUCTS_HELP } from '@/lib/help-content';
import { ProductCard } from './product-card';
import { ProductDialog } from './product-dialog';
import {
  ApiError,
  addMedia,
  createProduct,
  deleteProduct,
  listProducts,
  updateProduct,
} from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';
import type { Farmer, Paginated, Product, Subcategory } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function ProductsClient({
  initial,
  farmers = [],
  subcats = [],
  multiFarmer = false,
  multiSubcat = false,
}: {
  initial: Paginated<Product>;
  farmers?: Farmer[];
  subcats?: Subcategory[];
  multiFarmer?: boolean;
  multiSubcat?: boolean;
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

  const activeCount = products.filter((p) => p.isActive).length;
  // `total` (full count) comes from the first page; fall back to the loaded count.
  const totalCount = initial.total ?? products.length;
  const farmerName = useMemo(() => new Map(farmers.map((f) => [f.id, f.name])), [farmers]);
  const subcatName = useMemo(() => new Map(subcats.map((s) => [s.id, s.name])), [subcats]);

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
      <div className="mb-[18px] flex items-center justify-between">
        <p className="text-sm text-ff-muted">
          {activeCount} активни · {totalCount} общо
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
            <Info size={16} /> Обяснения
          </Button>
          <Button variant="primary" onClick={() => setCreateOpen(true)} className="rounded-sm">
            <Plus size={18} /> Добави продукт
          </Button>
        </div>
      </div>

      {products.length === 0 ? (
        <p className="mt-16 text-center text-sm text-ff-muted">Все още няма продукти. Добави първия си продукт.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
          {products.map((p, i) => (
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
            />
          ))}
        </div>
      )}

      {hasMore && (
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
