'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Coins, Receipt, Wallet, Plus, Pencil, Trash2 } from 'lucide-react';
import { moneyFromStotinki } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { deleteExpense, getPnl, listExpenses, setCommissionBps } from '@/lib/api-client';
import { errMsg, StatTile } from '@/lib/stat-ui';
import type { ExpenseRow, PnlSummary, StatsRange } from '@/lib/types';
import { CATEGORY_LABELS, bpsToPct, pctToBps } from './pnl-format';
import { ExpenseDialog } from './expense-dialog';

const card = 'rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm';

/** 'YYYY-MM-DD' → 'DD.MM' за компактния списък с разходи. */
const shortDate = (d: string) => {
  const [, m, dd] = d.split('-');
  return `${dd}.${m}`;
};

export function PnlSection({
  range,
  mode,
  applied,
}: {
  range: StatsRange;
  mode: 'preset' | 'custom';
  applied: { from: string; to: string } | null;
}) {
  const [data, setData] = useState<PnlSummary | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pct, setPct] = useState('');
  const [savingPct, setSavingPct] = useState(false);

  const load = useCallback(async () => {
    if (mode === 'custom' && !applied) return;
    setLoading(true);
    try {
      const summary = mode === 'custom' && applied ? await getPnl(applied) : await getPnl({ range });
      setData(summary);
      setPct(bpsToPct(summary.commissionBps));
      setExpenses(await listExpenses(summary.from, summary.to));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [mode, applied, range]);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePct() {
    const bps = pctToBps(pct);
    if (bps === null) {
      toast.error('Процентът трябва да е между 0 и 50');
      return;
    }
    setSavingPct(true);
    try {
      await setCommissionBps(bps);
      toast.success('Процентът е записан');
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSavingPct(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Да изтрия ли разхода?')) return;
    try {
      await deleteExpense(id);
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const courierName = (id: string | null) =>
    id ? (data?.couriers.find((c) => c.accountId === id)?.name ?? 'Куриер') : 'Общ';

  return (
    <section className="mt-8 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-ff-ink">Приходи и разходи</h2>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus size={16} /> Добави разход
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile Icon={Coins} label="Приходи" value={moneyFromStotinki(data?.revenue.totalStotinki ?? 0)} sub={`доставка ${moneyFromStotinki(data?.revenue.deliveryStotinki ?? 0)} + комисионна ${moneyFromStotinki(data?.revenue.commissionStotinki ?? 0)}`} />
        <StatTile Icon={Receipt} label="Разходи" value={moneyFromStotinki(data?.expenses.totalStotinki ?? 0)} index={1} />
        <StatTile Icon={Wallet} label="Печалба" value={moneyFromStotinki(data?.profitStotinki ?? 0)} index={2} />
      </div>

      <div className={card}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] font-bold text-ff-ink-2">
            Информационна комисионна (%)
            <input
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              inputMode="decimal"
              className="w-28 rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] font-semibold text-ff-ink focus:outline-none focus:ring-2 focus:ring-ff-green-500/40"
            />
          </label>
          <Button onClick={savePct} disabled={savingPct}>
            {savingPct ? 'Записвам…' : 'Запази'}
          </Button>
          <p className="text-[12.5px] font-semibold text-ff-muted-2">
            Прилага се върху стойността на доставените стоки за целия избран период.
          </p>
        </div>
      </div>

      {/* Таблица на широко, карти на телефон. */}
      <div className={card}>
        <h3 className="mb-3 font-display text-base font-bold text-ff-ink">Печалба по куриер</h3>
        {loading && !data ? (
          <p className="text-[13.5px] font-semibold text-ff-muted-2">Зареждам…</p>
        ) : (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-[13.5px]">
                <thead className="text-[12px] font-bold uppercase text-ff-muted-2">
                  <tr>
                    <th className="py-2">Куриер</th>
                    <th className="py-2 text-right">Доставка</th>
                    <th className="py-2 text-right">Комисионна</th>
                    <th className="py-2 text-right">Приход</th>
                    <th className="py-2 text-right">Разходи</th>
                    <th className="py-2 text-right">Печалба</th>
                  </tr>
                </thead>
                <tbody className="font-semibold text-ff-ink-2">
                  {(data?.couriers ?? []).map((c) => (
                    <tr key={c.accountId} className="border-t border-ff-border">
                      <td className="py-2">{c.name}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(c.deliveryStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(c.commissionStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(c.revenueStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(c.expenseStotinki)}</td>
                      <td className={`py-2 text-right ${c.profitStotinki < 0 ? 'text-ff-red' : 'text-ff-ink'}`}>
                        {moneyFromStotinki(c.profitStotinki)}
                      </td>
                    </tr>
                  ))}
                  {data && data.unassigned.revenueStotinki > 0 && (
                    <tr className="border-t border-ff-border text-ff-muted-2">
                      <td className="py-2">Неразпределени</td>
                      <td className="py-2 text-right">{moneyFromStotinki(data.unassigned.deliveryStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(data.unassigned.commissionStotinki)}</td>
                      <td className="py-2 text-right">{moneyFromStotinki(data.unassigned.revenueStotinki)}</td>
                      <td className="py-2 text-right">—</td>
                      <td className="py-2 text-right">—</td>
                    </tr>
                  )}
                  {data && data.generalExpensesStotinki > 0 && (
                    <tr className="border-t border-ff-border text-ff-muted-2">
                      <td className="py-2">Общи разходи</td>
                      <td className="py-2 text-right">—</td>
                      <td className="py-2 text-right">—</td>
                      <td className="py-2 text-right">—</td>
                      <td className="py-2 text-right">{moneyFromStotinki(data.generalExpensesStotinki)}</td>
                      <td className="py-2 text-right">−{moneyFromStotinki(data.generalExpensesStotinki)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-2 sm:hidden">
              {(data?.couriers ?? []).map((c) => (
                <div key={c.accountId} className="rounded-xl border border-ff-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] font-bold text-ff-ink">{c.name}</span>
                    <span className={`text-[14px] font-extrabold ${c.profitStotinki < 0 ? 'text-ff-red' : 'text-ff-ink'}`}>
                      {moneyFromStotinki(c.profitStotinki)}
                    </span>
                  </div>
                  <div className="mt-1 text-[12.5px] font-semibold text-ff-muted-2">
                    приход {moneyFromStotinki(c.revenueStotinki)} · разходи {moneyFromStotinki(c.expenseStotinki)}
                  </div>
                </div>
              ))}
              {data && data.generalExpensesStotinki > 0 && (
                <div className="rounded-xl border border-ff-border p-3 text-[13px] font-semibold text-ff-muted-2">
                  Общи разходи: {moneyFromStotinki(data.generalExpensesStotinki)}
                </div>
              )}
            </div>

            {data && data.couriers.length === 0 && (
              <p className="text-[13.5px] font-semibold text-ff-muted-2">
                Няма доставки с назначен куриер в периода.
              </p>
            )}
          </>
        )}
      </div>

      <div className={card}>
        <h3 className="mb-3 font-display text-base font-bold text-ff-ink">Разходи за периода</h3>
        {expenses.length === 0 ? (
          <p className="text-[13.5px] font-semibold text-ff-muted-2">Няма въведени разходи.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-ff-border">
            {expenses.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-bold text-ff-ink">
                    {CATEGORY_LABELS[e.category]} · {moneyFromStotinki(e.amountStotinki)}
                  </div>
                  <div className="truncate text-[12.5px] font-semibold text-ff-muted-2">
                    {shortDate(e.date)} · {courierName(e.courierAccountId)}
                    {e.note ? ` · ${e.note}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label="Промени"
                    onClick={() => {
                      setEditing(e);
                      setDialogOpen(true);
                    }}
                    className="rounded-lg p-2 text-ff-muted-2 hover:bg-ff-surface-2"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Изтрий"
                    onClick={() => void remove(e.id)}
                    className="rounded-lg p-2 text-ff-muted-2 hover:bg-ff-surface-2"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialogOpen && (
        <ExpenseDialog
          expense={editing}
          couriers={data?.couriers ?? []}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}
