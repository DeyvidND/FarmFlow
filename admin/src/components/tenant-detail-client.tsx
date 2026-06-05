'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  ShoppingBasket,
  Wallet,
  Package,
  Users,
  Star,
  Mail,
  Truck,
  CreditCard,
  Boxes,
  Tags,
} from 'lucide-react';
import { cn, dmy, eur } from '@/lib/utils';
import type { PlatformTenantDetail } from '@/lib/api-client';

const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Чака', tone: 'bg-ff-amber-soft text-ff-amber-600' },
  confirmed: { label: 'Потвърдена', tone: 'bg-ff-green-50 text-ff-green-700' },
  preparing: { label: 'Приготвя се', tone: 'bg-ff-green-50 text-ff-green-700' },
  out_for_delivery: { label: 'За доставка', tone: 'bg-ff-green-50 text-ff-green-700' },
  delivered: { label: 'Доставена', tone: 'bg-ff-green-100 text-ff-green-800' },
  cancelled: { label: 'Отказана', tone: 'bg-[#FBE9E7] text-ff-red' },
};

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.03em] text-ff-muted">
        <span className="text-ff-green-600">{icon}</span>
        {label}
      </div>
      <div className="ff-fig mt-2 text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-ff-muted">{sub}</div>}
    </div>
  );
}

function Flag({ on, label, icon }: { on: boolean; label: string; icon: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-bold',
        on ? 'bg-ff-green-50 text-ff-green-700' : 'bg-ff-surface-2 text-ff-muted-2',
      )}
    >
      {icon}
      {label}
    </span>
  );
}

export function TenantDetailClient({ detail: d }: { detail: PlatformTenantDetail }) {
  const active = d.subscriptionStatus === 'active';

  return (
    <div className="animate-ff-fade-up">
      <Link
        href="/tenants"
        className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-ff-green-700 no-underline hover:underline"
      >
        <ArrowLeft size={16} /> Фермери
      </Link>

      {/* header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">{d.name}</h1>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-bold',
                active ? 'bg-ff-green-50 text-ff-green-700' : 'bg-[#FBE9E7] text-ff-red',
              )}
            >
              <span className={cn('h-[7px] w-[7px] rounded-full', active ? 'bg-ff-green-500' : 'bg-ff-red')} />
              {active ? 'Активен' : 'Спрян'}
            </span>
          </div>
          <div className="mt-1 text-[13.5px] text-ff-muted">
            /{d.slug} · клиент от {dmy(d.createdAt)}
          </div>
          <div className="mt-1.5 text-[13.5px] text-ff-ink-2">
            {d.email ?? '—'}
            {d.phone ? ` · ${d.phone}` : ''}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Flag on={d.deliveryEnabled} label="Доставка" icon={<Truck size={13} />} />
          <Flag on={d.econtConfigured} label="Еконт" icon={<Truck size={13} />} />
          <Flag on={d.stripeConnected} label="Stripe" icon={<CreditCard size={13} />} />
          <Flag on={d.multiFarmer} label="Мулти-фермер" icon={<Boxes size={13} />} />
          <Flag on={d.multiSubcat} label="Подкатегории" icon={<Tags size={13} />} />
        </div>
      </div>

      {/* stat cards */}
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
        <StatCard
          icon={<ShoppingBasket size={15} />}
          label="Поръчки"
          value={String(d.orders.total)}
          sub={`${d.orders.delivered} доставени · ${d.orders.pending} чакат`}
        />
        <StatCard
          icon={<Wallet size={15} />}
          label="Оборот"
          value={eur(d.orders.revenueStotinki)}
          sub="без отказани поръчки"
        />
        <StatCard
          icon={<Package size={15} />}
          label="Продукти"
          value={`${d.products.active}/${d.products.total}`}
          sub="активни / общо"
        />
        <StatCard
          icon={<Users size={15} />}
          label="Абонати"
          value={String(d.subscribers.active)}
          sub={`${d.subscribers.unsubscribed} отписани`}
        />
        <StatCard
          icon={<Star size={15} />}
          label="Отзиви"
          value={d.reviews.total ? `${d.reviews.avgRating} ★` : '—'}
          sub={`${d.reviews.total} общо`}
        />
        <StatCard
          icon={<Mail size={15} />}
          label="Имейл изпращания"
          value={String(d.emailUsage.pushCount)}
          sub={d.emailUsage.pushCount ? `дължи ${eur(d.emailUsage.owedStotinki)}` : 'няма'}
        />
      </div>

      {/* recent orders */}
      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="text-[15px] font-extrabold">Последни поръчки</h2>
        </div>
        {d.recentOrders.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ff-muted">Все още няма поръчки.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {['Поръчка', 'Клиент', 'Сума', 'Статус', 'Дата'].map((h) => (
                  <th key={h} className="px-5 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.recentOrders.map((o) => {
                const st = ORDER_STATUS[o.status ?? ''] ?? { label: o.status ?? '—', tone: 'bg-ff-surface-2 text-ff-muted' };
                return (
                  <tr key={o.id} className="border-b border-ff-border-2 last:border-0">
                    <td className="ff-fig px-5 py-3 text-[13px] font-bold text-ff-ink">№ {o.id.slice(0, 8)}</td>
                    <td className="px-5 py-3 text-[13.5px] text-ff-ink-2">{o.customerName ?? '—'}</td>
                    <td className="ff-fig px-5 py-3 text-[14px] font-bold">{eur(o.totalStotinki)}</td>
                    <td className="px-5 py-3">
                      <span className={cn('inline-flex rounded-full px-2.5 py-1 text-[12px] font-bold', st.tone)}>
                        {st.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-[13px] text-ff-muted">{dmy(o.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
