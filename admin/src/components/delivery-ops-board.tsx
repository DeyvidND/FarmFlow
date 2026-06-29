import Link from 'next/link';
import { Truck, AlertTriangle, ChevronRight } from 'lucide-react';
import { eur } from '@/lib/utils';
import type { DeliveryOps } from '@/lib/api-client';

function daysAgo(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'amber' | 'red';
}) {
  const valueCls = tone === 'red' ? 'text-ff-red' : tone === 'amber' ? 'text-ff-amber-600' : 'text-ff-ink';
  return (
    <div className="rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">{label}</div>
      <div className={`ff-fig mt-1.5 text-[24px] font-extrabold tracking-[-0.02em] ${valueCls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-ff-muted">{sub}</div>}
    </div>
  );
}

/** Cross-tenant delivery snapshot shown atop the delivery accounts page. */
export function DeliveryOpsBoard({ ops }: { ops: DeliveryOps }) {
  const s = ops.shipments;
  const c = ops.cod;
  const problems = s.returned + s.refused;

  return (
    <div className="mb-6">
      <h2 className="mb-3 flex items-center gap-2 text-[16px] font-extrabold">
        <Truck size={17} className="text-ff-green-600" /> Доставки — преглед
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        <Metric label="Пратки" value={String(s.total)} sub={`${s.delivered} доставени · ${s.shipped} в път`} />
        <Metric
          label="Чакащи чернови"
          value={String(s.drafts)}
          sub="още не са товарителници"
          tone={s.drafts ? 'amber' : undefined}
        />
        <Metric label="НП за събиране" value={eur(c.pendingStotinki)} sub="още при клиента" />
        <Metric
          label="НП несетълнат"
          value={eur(c.outstandingStotinki)}
          sub="събран, още не изплатен"
          tone={c.outstandingStotinki ? 'amber' : undefined}
        />
        <Metric
          label="Проблемни"
          value={String(problems)}
          sub={`${s.returned} върнати · ${s.refused} отказани`}
          tone={problems ? 'red' : undefined}
        />
      </div>

      {ops.stuckDrafts.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl border border-[#e7c9a0] bg-ff-surface shadow-ff-sm">
          <div className="flex items-center gap-2 border-b border-ff-border-2 bg-ff-amber-softer px-5 py-3">
            <AlertTriangle size={16} className="shrink-0 text-ff-amber-600" />
            <h3 className="text-[13.5px] font-extrabold text-ff-amber-600">
              Чакащи чернови — фермери, които не са пуснали пратките си
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                  {['Фермер', 'Ферма', 'Чернови', 'Най-стара'].map((h) => (
                    <th key={h} className="px-5 py-2.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ops.stuckDrafts.map((d) => {
                  const age = daysAgo(d.oldestAt);
                  return (
                    <tr key={`${d.tenantId}-${d.farmerId}`} className="border-b border-ff-border-2 last:border-0">
                      <td className="px-5 py-2.5 text-[13.5px] font-bold text-ff-ink">{d.farmerName}</td>
                      <td className="px-5 py-2.5">
                        <Link
                          href={`/tenants/${d.tenantId}`}
                          className="inline-flex items-center gap-1 text-[13px] font-bold text-ff-green-700 no-underline hover:underline"
                        >
                          {d.tenantName}
                          <ChevronRight size={14} className="text-ff-muted-2" />
                        </Link>
                      </td>
                      <td className="ff-fig px-5 py-2.5 text-[13.5px] font-bold">{d.count}</td>
                      <td className="px-5 py-2.5 text-[13px]">
                        <span className={age >= 3 ? 'font-bold text-ff-red' : 'text-ff-ink-2'}>
                          {age === 0 ? 'днес' : `преди ${age} ${age === 1 ? 'ден' : 'дни'}`}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
