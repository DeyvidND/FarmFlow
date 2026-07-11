'use client';

import type { CommissionSummary } from '@/lib/api-client';

const euro = (stotinki: number) => `${(stotinki / 100).toFixed(2)} €`;

export function MyReportClient({ summary }: { summary: CommissionSummary }) {
  const me = summary.farmers[0]; // producer scope returns at most own row
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Моят отчет</h1>
        <p className="text-sm text-muted-foreground">
          Оборотът ти от събраните поръчки на пазара{summary.commissionEnabled ? ' и дължимата комисиона' : ''}.
        </p>
      </div>
      {!me ? (
        <p className="text-sm text-muted-foreground">Още няма събрани поръчки с твои продукти.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">Поръчки</div>
            <div className="mt-1 text-2xl font-semibold">{me.orderCount}</div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="text-sm text-muted-foreground">Оборот</div>
            <div className="mt-1 text-2xl font-semibold">{euro(me.grossStotinki)}</div>
          </div>
          {summary.commissionEnabled && (
            <div className="rounded-lg border p-4">
              <div className="text-sm text-muted-foreground">Комисиона</div>
              <div className="mt-1 text-2xl font-semibold">{euro(me.commissionStotinki)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
