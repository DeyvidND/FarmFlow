'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ProductCard } from './product-card';
import { CreateProductDialog } from './create-product-dialog';
import {
  ApiError,
  createProduct,
  deleteProduct,
  updateProduct,
  uploadProductImage,
} from '@/lib/api-client';
import type { Product } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function ProductsClient({ initial }: { initial: Product[] }) {
  const [products, setProducts] = useState<Product[]>(initial);
  const [editId, setEditId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const activeCount = products.filter((p) => p.isActive).length;

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
      const updated = await uploadProductImage(p.id, file);
      patchLocal(p.id, { imageUrl: updated.imageUrl });
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
            />
          ))}
        </div>
      )}

      <CreateProductDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreate={onCreate} />
    </div>
  );
}
