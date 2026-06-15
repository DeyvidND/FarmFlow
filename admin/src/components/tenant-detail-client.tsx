'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
  Pencil,
  Check,
  X,
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

const INPUT =
  'w-full rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] text-ff-ink outline-none focus:border-ff-green-500 focus:ring-2 focus:ring-ff-green-100';

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] font-bold uppercase tracking-[0.03em] text-ff-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ff-muted">{hint}</span>}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-left"
    >
      <span
        className={cn(
          'relative h-[22px] w-[40px] shrink-0 rounded-full transition-colors',
          checked ? 'bg-ff-green-600' : 'bg-ff-surface-2',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all',
            checked ? 'left-[20px]' : 'left-[2px]',
          )}
        />
      </span>
      <span className="text-[13.5px] font-semibold text-ff-ink-2">{label}</span>
    </button>
  );
}

export function TenantDetailClient({ detail: d }: { detail: PlatformTenantDetail }) {
  const router = useRouter();
  const active = d.subscriptionStatus === 'active';

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: d.name,
    slug: d.slug,
    email: d.email ?? '',
    phone: d.phone ?? '',
    siteUrl: d.siteUrl ?? '',
    deliveryEnabled: d.deliveryEnabled,
    multiFarmer: d.multiFarmer,
    multiSubcat: d.multiSubcat,
  });

  function reset() {
    setForm({
      name: d.name,
      slug: d.slug,
      email: d.email ?? '',
      phone: d.phone ?? '',
      siteUrl: d.siteUrl ?? '',
      deliveryEnabled: d.deliveryEnabled,
      multiFarmer: d.multiFarmer,
      multiSubcat: d.multiSubcat,
    });
    setErr(null);
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/bff/platform/tenants/${d.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          slug: form.slug.trim(),
          email: form.email.trim() || undefined,
          phone: form.phone.trim() || undefined,
          siteUrl: form.siteUrl.trim() || undefined,
          deliveryEnabled: form.deliveryEnabled,
          multiFarmer: form.multiFarmer,
          multiSubcat: form.multiSubcat,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
        const msg = Array.isArray(body.message) ? body.message.join(', ') : body.message;
        throw new Error(msg ?? 'Грешка при запис');
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Грешка при запис');
    } finally {
      setSaving(false);
    }
  }

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
        <div className="flex flex-col items-end gap-2.5">
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-1.5 text-[13px] font-bold text-ff-green-700 shadow-ff-sm hover:bg-ff-green-50"
            >
              <Pencil size={14} /> Редактирай
            </button>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Flag on={d.deliveryEnabled} label="Доставка" icon={<Truck size={13} />} />
            <Flag on={d.econtConfigured} label="Еконт" icon={<Truck size={13} />} />
            <Flag on={d.stripeConnected} label="Stripe" icon={<CreditCard size={13} />} />
            <Flag on={d.multiFarmer} label="Мулти-фермер" icon={<Boxes size={13} />} />
            <Flag on={d.multiSubcat} label="Подкатегории" icon={<Tags size={13} />} />
          </div>
        </div>
      </div>

      {/* edit form */}
      {editing && (
        <div className="mt-4 rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
          <h2 className="text-[15px] font-extrabold">Данни за фермата</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Име на фермата">
              <input className={INPUT} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Slug" hint="Публичен адрес на магазина — малки букви, цифри, тирета.">
              <input className={INPUT} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            </Field>
            <Field label="Имейл">
              <input
                className={INPUT}
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Телефон">
              <input
                className={INPUT}
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </Field>
            <Field
              label="Адрес на сайта"
              hint={'За бутона „Редактирай сайта“ в панела на фермера'}
            >
              <input
                className={INPUT}
                type="url"
                placeholder="https://ferma.farmsteadflow.com"
                value={form.siteUrl}
                onChange={(e) => setForm({ ...form, siteUrl: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t border-ff-border-2 pt-4">
            <Toggle
              checked={form.deliveryEnabled}
              onChange={(v) => setForm({ ...form, deliveryEnabled: v })}
              label="Доставка"
            />
            <Toggle
              checked={form.multiFarmer}
              onChange={(v) => setForm({ ...form, multiFarmer: v })}
              label="Мулти-фермер"
            />
            <Toggle
              checked={form.multiSubcat}
              onChange={(v) => setForm({ ...form, multiSubcat: v })}
              label="Подкатегории"
            />
          </div>

          {err && <p className="mt-3 text-[13px] font-semibold text-ff-red">{err}</p>}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-700 px-4 py-2 text-[13.5px] font-bold text-white shadow-ff-sm hover:bg-ff-green-800 disabled:opacity-60"
            >
              <Check size={15} /> {saving ? 'Запазва…' : 'Запази'}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-4 py-2 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2 disabled:opacity-60"
            >
              <X size={15} /> Откажи
            </button>
          </div>
        </div>
      )}

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
