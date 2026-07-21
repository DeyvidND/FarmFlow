'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { createExpense, updateExpense } from '@/lib/api-client';
import { errMsg } from '@/lib/stat-ui';
import type { ExpenseCategory, ExpenseRow, PnlCourier } from '@/lib/types';
import { CATEGORY_LABELS, parseAmountToStotinki } from './pnl-format';

const field =
  'w-full rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] font-semibold text-ff-ink focus:outline-none focus:ring-2 focus:ring-ff-green-500/40';
const labelCls = 'flex flex-col gap-1.5 text-[13px] font-bold text-ff-ink-2';

/** Днешната дата като 'YYYY-MM-DD' за подразбиране в полето. */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ExpenseDialog({
  expense,
  couriers,
  onClose,
  onSaved,
}: {
  /** null = нов разход; иначе редакция. */
  expense: ExpenseRow | null;
  couriers: PnlCourier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(expense?.date ?? todayStr());
  const [amount, setAmount] = useState(expense ? String(expense.amountStotinki / 100) : '');
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category ?? 'fuel');
  const [courierAccountId, setCourierAccountId] = useState(expense?.courierAccountId ?? '');
  const [note, setNote] = useState(expense?.note ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    const amountStotinki = parseAmountToStotinki(amount);
    if (!amountStotinki) {
      toast.error('Въведи сума по-голяма от нула');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast.error('Избери дата');
      return;
    }
    setSaving(true);
    try {
      if (expense) {
        await updateExpense(expense.id, {
          date,
          amountStotinki,
          category,
          courierAccountId: courierAccountId || null,
          note: note || null,
        });
      } else {
        await createExpense({
          date,
          amountStotinki,
          category,
          ...(courierAccountId ? { courierAccountId } : {}),
          ...(note ? { note } : {}),
        });
      }
      toast.success(expense ? 'Разходът е обновен' : 'Разходът е записан');
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      {/* w-full max-w-*, НЕ w-[Npx]: фиксирана ширина излиза извън 375px екран. */}
      <div
        className="w-full max-w-sm rounded-2xl bg-ff-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 font-display text-lg font-bold text-ff-ink">
          {expense ? 'Промени разход' : 'Добави разход'}
        </h2>
        <div className="flex flex-col gap-3.5">
          <label className={labelCls}>
            Дата
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <label className={labelCls}>
            Сума (лв.)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="напр. 45.50"
              className={field}
              autoFocus
            />
          </label>
          <label className={labelCls}>
            Категория
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              className={field}
            >
              {(Object.keys(CATEGORY_LABELS) as ExpenseCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Куриер (по избор)
            <select
              value={courierAccountId}
              onChange={(e) => setCourierAccountId(e.target.value)}
              className={field}
            >
              <option value="">Общ разход</option>
              {couriers.map((c) => (
                <option key={c.accountId} value={c.accountId}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Бележка (по избор)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="напр. зареждане OMV"
              className={field}
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Откажи
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Записвам…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
