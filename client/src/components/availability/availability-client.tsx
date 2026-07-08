'use client';

import * as React from 'react';
import { Info, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  ApiError,
  listAvailabilityWindows,
  deleteAvailabilityWindow,
  createAvailabilityWindow,
  updateAvailabilityWindow,
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
  initialWindows = [],
  role = 'admin',
  farmers = [],
  multiFarmer = false,
}: {
  products: PickerProduct[];
  /** Windows server-rendered by the page; avoids a client fetch + loading flash on load. */
  initialWindows?: AvailabilityWindow[];
  role?: 'admin' | 'farmer';
  /** Owner-only: list of producers for the farmer-filter dropdown. */
  farmers?: { id: string; name: string }[];
  multiFarmer?: boolean;
}) {
  const [windows, setWindows] = React.useState<AvailabilityWindow[]>(initialWindows);
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
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<'all' | 'out' | 'unset'>('all');
  const [markingId, setMarkingId] = React.useState<string | null>(null);

  // Windows are server-rendered (initialWindows); reload() only re-pulls after an edit.
  const reload = React.useCallback(async () => {
    try {
      setWindows(await listAvailabilityWindows());
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);

  const windowOf = (id: string) => windows.find((w) => w.productId === id);

  // A product's stock state — drives the row badge and the status-filter chips.
  //  variants → managed per-variant elsewhere; in → has stock; out → sold out
  //  (window at 0); unset → no window yet (unlimited / not tracked).
  type Status = 'variants' | 'in' | 'out' | 'unset';
  const statusOf = (p: PickerProduct): Status => {
    if (p.hasVariants) return 'variants';
    const w = windowOf(p.id);
    if (!w) return 'unset';
    return w.remaining > 0 ? 'in' : 'out';
  };

  // Farmer scope first (owner + multiFarmer only); chip counts read off this set
  // so they stay stable while typing in the search box.
  const farmerFiltered = products.filter(
    (p) => !(showFarmerPicker && selectedFarmerId) || p.farmerId === selectedFarmerId,
  );
  const counts = {
    all: farmerFiltered.length,
    out: farmerFiltered.filter((p) => statusOf(p) === 'out').length,
    unset: farmerFiltered.filter((p) => statusOf(p) === 'unset').length,
  };

  // Then free-text search + the active status chip → the rendered list.
  const q = search.trim().toLowerCase();
  const visibleProducts = farmerFiltered
    .filter((p) => !q || [p.name, p.weight].filter(Boolean).join(' ').toLowerCase().includes(q))
    .filter((p) => statusFilter === 'all' || statusOf(p) === statusFilter);

  const remove = async (id: string) => {
    setConfirming(null);
    try {
      await deleteAvailabilityWindow(id);
      await reload();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  // One-click «Изчерпано»: sets stock straight to 0 — no modal, no typing. Works
  // both when the product has no window yet (creates one at 0) and when it
  // already has stock (zeroes the existing window, preserving nothing since the
  // product is being marked fully sold out).
  const markSoldOut = async (productId: string, existingWindowId?: string) => {
    setMarkingId(productId);
    try {
      if (existingWindowId) {
        await updateAvailabilityWindow(existingWindowId, { quantity: 0 });
      } else {
        await createAvailabilityWindow({ productId, quantity: 0 });
      }
      toast.success('Отбелязано като изчерпано');
      await reload();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setMarkingId(null);
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

        <div className="mt-4 flex flex-wrap items-end gap-3">
          {showFarmerPicker && (
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
          )}
          <label className="relative flex-1 min-w-[220px]">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ff-muted-2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Търси продукт…"
              className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-9 pr-3 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm outline-none placeholder:font-normal placeholder:text-ff-muted-2 focus:border-ff-green-500"
            />
          </label>
        </div>

        {/* Status chips — jump straight to what needs attention. «Изчерпани» and
            «Незададени» are the actionable buckets a farmer cares about. */}
        {products.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {([
              ['all', `Всички (${counts.all})`],
              ['out', `Изчерпани (${counts.out})`],
              ['unset', `Незададени (${counts.unset})`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={
                  statusFilter === key
                    ? 'rounded-full bg-ff-green-700 px-3 py-1.5 text-[12.5px] font-bold text-white'
                    : 'rounded-full border border-ff-border bg-ff-surface px-3 py-1.5 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2'
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}

      </div>

      {products.length === 0 && (
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 text-sm text-ff-muted-2">
          <>
            Все още нямаш добавени активни продукти. Добави продукти от{' '}
            <a
              href="/products"
              className="font-semibold text-ff-green-700 hover:underline"
            >
              Продукти
            </a>{' '}
            и се върни тук.
          </>
          {/* Same guidance + link for producers and owner — both manage products at /products. */}
        </div>
      )}

      {products.length > 0 && visibleProducts.length === 0 && (
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 text-sm text-ff-muted-2">
          Няма продукти в този изглед.
        </div>
      )}

      {/* Dense one-row-per-product list. Each row: name · stock badge · actions.
          Far more scannable than stacked cards when a farm has dozens of products. */}
      {visibleProducts.length > 0 && (
        <div className="divide-y divide-ff-border overflow-hidden rounded-2xl border border-ff-border bg-ff-surface">
          {visibleProducts.map((p) => {
            const w = windowOf(p.id);
            const busy = markingId === p.id;
            return (
              <div
                key={p.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              >
                <div className="min-w-0 flex-1 font-semibold text-ff-ink">
                  <span className="truncate">{[p.name, p.weight].filter(Boolean).join(' ')}</span>
                </div>

                {/* Stock badge */}
                {p.hasVariants ? (
                  <span className="rounded-full bg-ff-surface-2 px-2.5 py-1 text-[12px] font-bold text-ff-ink-2">
                    Варианти
                  </span>
                ) : !w ? (
                  <span className="text-[13px] font-semibold text-ff-muted-2">Не е зададена</span>
                ) : w.remaining > 0 ? (
                  <span className="text-[13px] font-semibold text-ff-ink">
                    остават {w.remaining}/{w.quantity} бр.
                  </span>
                ) : (
                  <span className="rounded-full bg-red-50 px-2.5 py-1 text-[12px] font-bold text-red-700">
                    Изчерпано
                  </span>
                )}

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-3 text-[13px] font-bold">
                  {p.hasVariants ? (
                    <a href="/products" className="text-ff-green-700 hover:underline">
                      Отвори →
                    </a>
                  ) : !w ? (
                    <>
                      <button
                        onClick={() => markSoldOut(p.id)}
                        disabled={busy}
                        className="text-red-700 hover:underline disabled:opacity-60"
                      >
                        Изчерпано
                      </button>
                      <button
                        onClick={() => setEditing({ productId: p.id })}
                        className="rounded-lg bg-ff-green-50 px-3 py-1.5 text-ff-green-700 hover:bg-ff-green-100"
                      >
                        Задай
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => setEditing({ productId: p.id, existingWindow: w })}
                        className="text-ff-ink-2 hover:underline"
                      >
                        Промени
                      </button>
                      {w.remaining > 0 && (
                        <button
                          onClick={() => markSoldOut(p.id, w.id)}
                          disabled={busy}
                          className="text-red-700 hover:underline disabled:opacity-60"
                        >
                          Изчерпано
                        </button>
                      )}
                      <button
                        onClick={() => setConfirming(w.id)}
                        className="text-red-600 hover:underline"
                      >
                        Изтрий
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

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
          products={visibleProducts.filter((p) => !p.hasVariants)}
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
