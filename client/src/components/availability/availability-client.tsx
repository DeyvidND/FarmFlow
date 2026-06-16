'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import {
  ApiError,
  listAvailabilityWindows,
  deleteAvailabilityWindow,
} from '@/lib/api-client';
import type { AvailabilityWindow } from '@/lib/types';
import type { PickerProduct } from '@/app/(admin)/availability/page';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HelpModal } from '@/components/delivery/ui';
import { Button } from '@/components/ui/button';
import { AVAILABILITY_HELP } from '@/lib/help-content';
import { WindowEditor } from './window-editor';
import { BulkWindowEditor } from './bulk-window-editor';
import { Layers } from 'lucide-react';

const errMsg = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Възникна грешка';

export function AvailabilityClient({
  products,
  role = 'admin',
  farmers = [],
  multiFarmer = false,
}: {
  products: PickerProduct[];
  role?: 'admin' | 'farmer';
  /** Owner-only: list of producers for the farmer-filter dropdown. */
  farmers?: { id: string; name: string }[];
  multiFarmer?: boolean;
}) {
  const [windows, setWindows] = React.useState<AvailabilityWindow[]>([]);
  const [editing, setEditing] = React.useState<{
    productId: string;
    existingWindow?: AvailabilityWindow;
  } | null>(null);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [help, setHelp] = React.useState(false);

  // Owner + multiFarmer: client-side farmer filter (products already carry farmerId).
  const [selectedFarmerId, setSelectedFarmerId] = React.useState<string>('');
  const showFarmerPicker = role === 'admin' && multiFarmer && farmers.length > 0;

  const reload = React.useCallback(async () => {
    try {
      setWindows(await listAvailabilityWindows());
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  // Filter products client-side when the owner has a farmer selected.
  const visibleProducts =
    showFarmerPicker && selectedFarmerId
      ? products.filter((p) => p.farmerId === selectedFarmerId)
      : products;

  const byProduct = (id: string) => windows.filter((w) => w.productId === id);

  const remove = async (id: string) => {
    setConfirming(null);
    try {
      await deleteAvailabilityWindow(id);
      await reload();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const isProducer = role === 'farmer';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">
              Задай наличност
            </h1>
            <p className="mt-1 text-[14px] text-ff-ink-2">
              {isProducer
                ? 'Задавай наличност за своите продукти. Количеството е реалната наличност в магазина — клиентът поръчва и то намалява. Изтрий я, когато продуктът свърши.'
                : 'Задай каква наличност имаш. Количеството е реалната наличност в магазина — клиентът поръчва и то намалява. Изтрий я, когато продуктът свърши.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {visibleProducts.length > 0 && (
              <Button variant="primary" size="sm" onClick={() => setBulkOpen(true)}>
                <Layers size={16} /> Задай за всички
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
              <Info size={16} /> Обяснения
            </Button>
          </div>
        </div>

        {/* Owner + multiFarmer: farmer filter dropdown */}
        {showFarmerPicker && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="inline-flex items-center gap-2 text-[13px] font-bold text-ff-ink-2">
              Фермер:
              <select
                value={selectedFarmerId}
                onChange={(e) => setSelectedFarmerId(e.target.value)}
                className="h-11 rounded-xl border border-ff-border bg-ff-surface px-2.5 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm outline-none focus:border-ff-green-500"
              >
                <option value="">Всички</option>
                {farmers.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

      </div>

      {visibleProducts.length === 0 && (
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 text-sm text-ff-muted-2">
          {isProducer ? (
            'Все още нямаш добавени активни продукти. Добави продукти и се върни тук.'
          ) : (
            <>
              Все още нямаш добавени продукти. Добави продукти от{' '}
              <a
                href="/products"
                className="font-semibold text-ff-green-700 hover:underline"
              >
                Продукти
              </a>{' '}
              и се върни тук.
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {visibleProducts.map((p) => (
          <div
            key={p.id}
            className="rounded-2xl border border-ff-border bg-ff-surface p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-ff-ink">
                {[p.name, p.weight].filter(Boolean).join(' ')}
              </div>
              {byProduct(p.id).length === 0 && (
                <button
                  onClick={() => setEditing({ productId: p.id })}
                  className="shrink-0 rounded-lg bg-ff-green-50 px-3 py-1.5 text-sm font-bold text-ff-green-700 hover:bg-ff-green-100"
                >
                  + Задай наличност
                </button>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-1.5">
              {byProduct(p.id).length === 0 && (
                <div className="text-sm text-ff-muted-2">
                  Няма зададена наличност.
                </div>
              )}
              {byProduct(p.id).map((w) => (
                <div
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg bg-ff-surface-2 px-3 py-2 text-sm"
                >
                  <span className="font-semibold text-ff-ink">
                    остават {w.remaining}/{w.quantity} бр.
                  </span>
                  <span className="flex items-center gap-3">
                    <button
                      onClick={() =>
                        setEditing({ productId: p.id, existingWindow: w })
                      }
                      className="text-ff-ink-2 hover:underline"
                    >
                      Промени
                    </button>
                    <button
                      onClick={() => setConfirming(w.id)}
                      className="text-red-600 hover:underline"
                    >
                      Изтрий
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <WindowEditor
          productId={editing.productId}
          existingWindow={editing.existingWindow}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}

      {bulkOpen && (
        <BulkWindowEditor
          products={visibleProducts}
          onClose={() => setBulkOpen(false)}
          onSaved={reload}
        />
      )}

      {confirming && (
        <ConfirmDialog
          tone="danger"
          title="Изтриване на наличност"
          message="Сигурен ли си? Зададената наличност за този продукт ще бъде премахната."
          confirmLabel="Изтрий"
          onCancel={() => setConfirming(null)}
          onConfirm={() => remove(confirming)}
        />
      )}

      {help && <HelpModal {...AVAILABILITY_HELP} onClose={() => setHelp(false)} />}
    </div>
  );
}
