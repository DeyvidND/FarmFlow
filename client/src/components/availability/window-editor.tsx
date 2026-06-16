'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  ApiError,
  createAvailabilityWindow,
  updateAvailabilityWindow,
} from '@/lib/api-client';
import type { AvailabilityWindow } from '@/lib/types';

const errMsg = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Възникна грешка';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500 mt-1 w-full';

const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

interface Props {
  productId: string;
  existingWindow?: AvailabilityWindow; // present = edit
  onClose: () => void;
  onSaved: () => void;
}

export function WindowEditor({ productId, existingWindow, onClose, onSaved }: Props) {
  const isEdit = !!existingWindow;
  const [quantity, setQuantity] = React.useState(
    existingWindow ? String(existingWindow.quantity) : '',
  );
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) {
      toast.error('Въведи количество (поне 1)');
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        await updateAvailabilityWindow(existingWindow!.id, { quantity: qty });
      } else {
        await createAvailabilityWindow({ productId, quantity: qty });
      }
      toast.success('Запазено');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-ff-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 font-display text-lg font-bold text-ff-ink">
          {isEdit ? 'Промени наличност' : 'Задай наличност'}
        </h2>
        <div className="flex flex-col gap-4">
          <label className={labelCls}>
            Количество (бр.)
            <input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputMode="numeric"
              placeholder="напр. 20"
              className={field}
              autoFocus
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-semibold text-ff-ink-2 hover:bg-ff-surface-2"
          >
            Отказ
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-ff-green-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
          >
            {saving ? 'Запазвам…' : 'Запази'}
          </button>
        </div>
      </div>
    </div>
  );
}
