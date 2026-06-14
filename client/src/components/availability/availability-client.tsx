'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import {
  ApiError,
  listAvailabilityWindows,
  deleteAvailabilityWindow,
  updateTenant,
} from '@/lib/api-client';
import type { AvailabilityWindow, Product } from '@/lib/types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HelpModal } from '@/components/delivery/ui';
import { Button } from '@/components/ui/button';
import { AVAILABILITY_HELP } from '@/lib/help-content';
import { WindowEditor } from './window-editor';

const errMsg = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Възникна грешка';

const todaySofia = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(
    new Date(),
  );

const isActive = (w: AvailabilityWindow) => {
  const t = todaySofia();
  return w.startsAt <= t && t <= w.endsAt;
};

export function AvailabilityClient({
  products,
  title,
}: {
  products: Product[];
  title: string | null;
}) {
  const [windows, setWindows] = React.useState<AvailabilityWindow[]>([]);
  const [editing, setEditing] = React.useState<{
    productId: string;
    existingWindow?: AvailabilityWindow;
  } | null>(null);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [help, setHelp] = React.useState(false);
  const [sectionTitle, setSectionTitle] = React.useState(title ?? '');
  const [savingTitle, setSavingTitle] = React.useState(false);

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

  const byProduct = (id: string) =>
    windows
      .filter((w) => w.productId === id)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const remove = async (id: string) => {
    setConfirming(null);
    try {
      await deleteAvailabilityWindow(id);
      await reload();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const saveTitle = async () => {
    setSavingTitle(true);
    try {
      await updateTenant({ availabilityTitle: sectionTitle.trim() || '' });
      toast.success('Запазено');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSavingTitle(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">
              Задай наличност
            </h1>
            <p className="mt-1 text-[14px] text-ff-ink-2">
              Обяви каква наличност имаш за определен период. Докато периодът е
              активен, количеството е реалната наличност в магазина — клиентът
              поръчва и то намалява.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
            <Info size={16} /> Обяснения
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12.5px] font-bold text-ff-ink-2">
            Заглавие на секцията в онлайн магазина
            <input
              type="text"
              value={sectionTitle}
              onChange={(e) => setSectionTitle(e.target.value)}
              placeholder="Налично сега"
              className="rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2 text-[14px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500 w-72 max-w-full font-normal"
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            disabled={savingTitle}
            onClick={saveTitle}
            className="mb-0.5"
          >
            {savingTitle ? 'Запазвам…' : 'Запази заглавието'}
          </Button>
        </div>
      </div>

      {products.length === 0 && (
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 text-sm text-ff-muted-2">
          Все още нямаш добавени продукти. Добави продукти от{' '}
          <a href="/products" className="font-semibold text-ff-green-700 hover:underline">
            Продукти
          </a>{' '}
          и се върни тук.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {products.map((p) => (
          <div
            key={p.id}
            className="rounded-2xl border border-ff-border bg-ff-surface p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-ff-ink">
                {[p.name, p.weight].filter(Boolean).join(' ')}
              </div>
              <button
                onClick={() => setEditing({ productId: p.id })}
                className="shrink-0 rounded-lg bg-ff-green-50 px-3 py-1.5 text-sm font-bold text-ff-green-700 hover:bg-ff-green-100"
              >
                + Период
              </button>
            </div>

            <div className="mt-3 flex flex-col gap-1.5">
              {byProduct(p.id).length === 0 && (
                <div className="text-sm text-ff-muted-2">
                  Няма зададени периоди.
                </div>
              )}
              {byProduct(p.id).map((w) => (
                <div
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg bg-ff-surface-2 px-3 py-2 text-sm"
                >
                  <span className="text-ff-ink-2">
                    {w.startsAt} → {w.endsAt}
                    {isActive(w) && (
                      <span className="ml-2 rounded bg-ff-green-100 px-1.5 py-0.5 text-[11px] font-bold text-ff-green-700">
                        активен
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-semibold text-ff-ink">
                      остават {w.remaining}/{w.quantity}
                    </span>
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

      {confirming && (
        <ConfirmDialog
          tone="danger"
          title="Изтриване на период"
          message="Сигурен ли си? Този период с наличност ще бъде премахнат."
          confirmLabel="Изтрий"
          onCancel={() => setConfirming(null)}
          onConfirm={() => remove(confirming)}
        />
      )}

      {help && <HelpModal {...AVAILABILITY_HELP} onClose={() => setHelp(false)} />}
    </div>
  );
}
