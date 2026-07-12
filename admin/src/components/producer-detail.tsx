import Link from 'next/link';
import { ArrowLeft, ChevronRight, Package, Truck, Wallet, ShoppingBasket, Check } from 'lucide-react';
import { cn, eur, dmy } from '@/lib/utils';
import type { FarmerDetail } from '@/lib/api-client';
import { ImpersonateButton } from './impersonate-button';
import { ProductImportDialog } from './product-import-dialog';
import { ProducerCuration } from './producer-curation';

const SHIP_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Чакаща', tone: 'bg-ff-surface-2 text-ff-ink-2' },
  created: { label: 'Създадена', tone: 'bg-ff-amber-soft text-ff-amber-600' },
  shipped: { label: 'Изпратена', tone: 'bg-ff-amber-softer text-ff-amber-600' },
  delivered: { label: 'Доставена', tone: 'bg-ff-green-50 text-ff-green-700' },
  returned: { label: 'Върната', tone: 'bg-ff-red-soft text-ff-red' },
  refused: { label: 'Отказана', tone: 'bg-ff-red-soft text-ff-red' },
  draft: { label: 'Чернова', tone: 'bg-ff-surface-2 text-ff-muted-2' },
};

const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Чака', tone: 'bg-ff-amber-soft text-ff-amber-600' },
  confirmed: { label: 'Потвърдена', tone: 'bg-ff-green-50 text-ff-green-700' },
  preparing: { label: 'Приготвя се', tone: 'bg-ff-green-50 text-ff-green-700' },
  out_for_delivery: { label: 'За доставка', tone: 'bg-ff-green-50 text-ff-green-700' },
  delivered: { label: 'Доставена', tone: 'bg-ff-green-100 text-ff-green-800' },
  cancelled: { label: 'Отказана', tone: 'bg-ff-red-soft text-ff-red' },
};

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">
        <span className="text-ff-green-600">{icon}</span>
        {label}
      </div>
      <div className="ff-fig mt-2 text-[24px] font-extrabold tracking-[-0.02em] text-ff-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-ff-muted">{sub}</div>}
    </div>
  );
}

function CarrierPill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold',
        on ? 'bg-ff-green-50 text-ff-green-700' : 'bg-ff-surface-2 text-ff-muted-2',
      )}
    >
      {on && <Check size={12} />}
      {label}
    </span>
  );
}

const money = (st: number | null) => (st == null ? '—' : eur(st));

export function ProducerDetail({ farmer: f }: { farmer: FarmerDetail }) {
  return (
    <div className="animate-ff-fade-up">
      <Link
        href="/producers"
        className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-ff-green-700 no-underline hover:underline"
      >
        <ArrowLeft size={16} /> Производители
      </Link>

      {/* header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
        <div className="min-w-0">
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">{f.name}</h1>
          <div className="mt-1 text-[13.5px] text-ff-muted">
            {f.role ? `${f.role} · ` : ''}
            <Link href={`/tenants/${f.tenantId}`} className="inline-flex items-center gap-1 font-bold text-ff-green-700 no-underline hover:underline">
              {f.tenantName}
              <ChevronRight size={13} className="text-ff-muted-2" />
            </Link>
          </div>
          <div className="mt-1.5 text-[13.5px] text-ff-ink-2">
            {f.hasLogin ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {f.loginEmail ?? '—'}
                {f.invitePending && (
                  <span className="rounded-full bg-ff-amber-soft px-2 py-0.5 text-[11px] font-bold text-ff-amber-600">покана</span>
                )}
              </span>
            ) : (
              <span className="text-ff-muted-2">няма достъп</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2.5">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ProductImportDialog tenantId={f.tenantId} farmerId={f.id} farmerName={f.name} />
            <ImpersonateButton farmerId={f.id} hasLogin={f.hasLogin} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <CarrierPill on={f.econtConnected} label="Еконт" />
            <CarrierPill on={f.speedyConnected} label="Speedy" />
          </div>
        </div>
      </div>

      <ProducerCuration farmer={f} />

      {/* stat cards */}
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
        <StatCard icon={<Package size={15} />} label="Продукти" value={String(f.counts.products)} />
        <StatCard icon={<ShoppingBasket size={15} />} label="Куриер поръчки" value={String(f.counts.courierOrders)} />
        <StatCard
          icon={<Truck size={15} />}
          label="Пратки"
          value={String(f.counts.shipments)}
          sub={f.counts.draftShipments > 0 ? `${f.counts.draftShipments} чакащи чернови` : 'няма чернови'}
        />
        <StatCard
          icon={<Wallet size={15} />}
          label="НП"
          value={money(f.cod.pendingStotinki)}
          sub={`събрани ${money(f.cod.collectedStotinki)}`}
        />
      </div>

      {/* recent shipments */}
      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="text-[15px] font-extrabold">Последни пратки</h2>
        </div>
        {f.recentShipments.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ff-muted">Все още няма пратки.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                  {['Получател', 'Куриер', 'Статус', 'Товарителница', 'НП', 'Дата'].map((h) => (
                    <th key={h} className="px-5 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {f.recentShipments.map((sh) => {
                  const st = SHIP_STATUS[sh.status] ?? { label: sh.status, tone: 'bg-ff-surface-2 text-ff-muted' };
                  return (
                    <tr key={sh.id} className="border-b border-ff-border-2 last:border-0">
                      <td className="px-5 py-3 text-[13.5px] font-semibold text-ff-ink">{sh.receiverName || '—'}</td>
                      <td className="px-5 py-3 text-[13px] text-ff-ink-2">{sh.carrier === 'speedy' ? 'Speedy' : sh.carrier === 'econt' ? 'Еконт' : '—'}</td>
                      <td className="px-5 py-3"><span className={cn('inline-flex rounded-full px-2.5 py-1 text-[12px] font-bold', st.tone)}>{st.label}</span></td>
                      <td className="ff-fig px-5 py-3 text-[13px] text-ff-ink-2">{sh.trackingNumber || '—'}</td>
                      <td className="ff-fig px-5 py-3 text-[13px] text-ff-ink-2">{money(sh.codAmountStotinki)}</td>
                      <td className="px-5 py-3 text-[13px] text-ff-muted">{dmy(sh.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* recent courier orders */}
      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="text-[15px] font-extrabold">Последни куриер поръчки</h2>
        </div>
        {f.recentOrders.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ff-muted">Все още няма куриер поръчки.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                  {['Поръчка', 'Клиент', 'Сума', 'Статус', 'Дата'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-5 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {f.recentOrders.map((o) => {
                  const st = ORDER_STATUS[o.status ?? ''] ?? { label: o.status ?? '—', tone: 'bg-ff-surface-2 text-ff-muted' };
                  return (
                    <tr key={o.id} className="border-b border-ff-border-2 last:border-0">
                      <td className="ff-fig whitespace-nowrap px-5 py-3 text-[13px] font-bold text-ff-ink">№ {o.id.slice(0, 8)}</td>
                      <td className="px-5 py-3 text-[13.5px] text-ff-ink-2">{o.customerName ?? '—'}</td>
                      <td className="ff-fig whitespace-nowrap px-5 py-3 text-[14px] font-bold">{eur(o.totalStotinki)}</td>
                      <td className="px-5 py-3"><span className={cn('inline-flex rounded-full px-2.5 py-1 text-[12px] font-bold', st.tone)}>{st.label}</span></td>
                      <td className="whitespace-nowrap px-5 py-3 text-[13px] text-ff-muted">{dmy(o.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
