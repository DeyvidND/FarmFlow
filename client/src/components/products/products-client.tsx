'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ProductCard } from './product-card';
import { ProductDialog } from './product-dialog';
import {
  ApiError,
  addMedia,
  createProduct,
  deleteProduct,
  updateProduct,
} from '@/lib/api-client';
import type { Farmer, Product, Subcategory } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function ProductsClient({
  initial,
  farmers = [],
  subcats = [],
  multiFarmer = false,
  multiSubcat = false,
}: {
  initial: Product[];
  farmers?: Farmer[];
  subcats?: Subcategory[];
  multiFarmer?: boolean;
  multiSubcat?: boolean;
}) {
  const [products, setProducts] = useState<Product[]>(initial);
  const [editId, setEditId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [fullEdit, setFullEdit] = useState<Product | null>(null);

  const activeCount = products.filter((p) => p.isActive).length;
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

  async function onSave(p: Product, priceStotinki: number, stockQuantity: number) {
    const prev = { priceStotinki: p.priceStotinki, stockQuantity: p.stockQuantity };
    patchLocal(p.id, { priceStotinki, stockQuantity }); // optimistic
    setEditId(null);
    setBusyId(p.id);
    try {
      const updated = await updateProduct(p.id, { priceStotinki, stockQuantity });
      patchLocal(p.id, updated);
      toast.success('Продуктът е обновен');
    } catch (e) {
      patchLocal(p.id, prev); // rollback
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
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

  async function onDelete(p: Product) {
    if (!window.confirm(`Изтриване на „${p.name}“?`)) return;
    setBusyId(p.id);
    try {
      await deleteProduct(p.id);
      setProducts((prev) => prev.filter((x) => x.id !== p.id));
      setEditId(null);
      toast.success('Продуктът е изтрит');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onCreate(data: Partial<Product>) {
    const created = await createProduct(data);
    setProducts((prev) => [created, ...prev]);
    toast.success('Продуктът е създаден');
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
          {activeCount} активни · {products.length} общо
        </p>
        <Button variant="primary" onClick={() => setCreateOpen(true)} className="rounded-sm">
          <Plus size={18} /> Добави продукт
        </Button>
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
              editing={editId === p.id}
              busy={busyId === p.id}
              onStartEdit={() => setEditId(p.id)}
              onCancel={() => setEditId(null)}
              onSave={(price, stock) => onSave(p, price, stock)}
              onToggle={(on) => onToggle(p, on)}
              onUpload={(f) => onUpload(p, f)}
              onDelete={() => onDelete(p)}
              farmerLabel={multiFarmer ? (p.farmerId ? farmerName.get(p.farmerId) ?? null : null) : undefined}
              subcatLabel={multiSubcat ? (p.subcategoryId ? subcatName.get(p.subcategoryId) ?? null : null) : undefined}
              onEditFull={() => setFullEdit(p)}
            />
          ))}
        </div>
      )}

      <ProductDialog
        open={createOpen}
        farmers={farmers}
        subcats={subcats}
        multiFarmer={multiFarmer}
        multiSubcat={multiSubcat}
        onClose={() => setCreateOpen(false)}
        onSubmit={onCreate}
      />

      <ProductDialog
        open={!!fullEdit}
        product={fullEdit}
        farmers={farmers}
        subcats={subcats}
        multiFarmer={multiFarmer}
        multiSubcat={multiSubcat}
        onClose={() => setFullEdit(null)}
        onSubmit={onFullUpdate}
        onCoverChange={(url) => fullEdit && patchLocal(fullEdit.id, { imageUrl: url })}
      />
    </div>
  );
}
