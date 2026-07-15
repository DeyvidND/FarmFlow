'use client';

import { useEffect, useState } from 'react';
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
  UserPlus,
  Send,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn, dmy, eur } from '@/lib/utils';
import {
  ApiError,
  enableDeliveryOnFarm,
  grantTenantCourierAccess,
  listTenantCourierAccess,
  revokeTenantCourierAccess,
  type PlatformTenantDetail,
  type TenantCourierAccess,
} from '@/lib/api-client';
import { EnterPanelButton } from '@/components/enter-panel-button';
import { ProducerOnboardDialog } from '@/components/producer-onboard-dialog';

const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Чака', tone: 'bg-ff-amber-soft text-ff-amber-600' },
  confirmed: { label: 'Потвърдена', tone: 'bg-ff-green-50 text-ff-green-700' },
  preparing: { label: 'Приготвя се', tone: 'bg-ff-green-50 text-ff-green-700' },
  out_for_delivery: { label: 'За доставка', tone: 'bg-ff-green-50 text-ff-green-700' },
  delivered: { label: 'Доставена', tone: 'bg-ff-green-100 text-ff-green-800' },
  cancelled: { label: 'Отказана', tone: 'bg-ff-red-soft text-ff-red' },
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

function CarrierPill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-bold',
        on ? 'bg-ff-green-50 text-ff-green-700' : 'bg-ff-surface-2 text-ff-muted-2',
      )}
    >
      {on && <Check size={11} />}
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

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/**
 * Task B2 — flat driver-login roster for this tenant. Accounts are no longer
 * bound to a fixed leg number (that binding now happens per-day on the
 * assignment board, Task C2), so this is just email + invite-pending status,
 * with invite / re-invite / revoke actions. Mirrors the old
 * `CourierHomesModal` account UX (farmer panel), moved here because account
 * creation is now a super-admin-only action — see `PlatformCourierController`.
 */
function CourierAccessSection({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = useState<TenantCourierAccess[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [email, setEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  // A Set (not a single accountId) so two rows can genuinely be busy at
  // once — a single `string | null` would let a second row's call clobber
  // the first's busy flag, re-enabling a still-in-flight row's buttons and
  // letting a duplicate request through. See CourierHomesModal (client/)
  // for the same pattern, fixed there after the identical bug.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    listTenantCourierAccess(tenantId)
      .then((list) => alive && setRows(list))
      .catch((e) => alive && setLoadErr(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [tenantId]);

  async function invite() {
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error('Въведи имейл');
      return;
    }
    setInviting(true);
    try {
      const res = await grantTenantCourierAccess(tenantId, trimmed);
      setRows((cur) => [...(cur ?? []).filter((r) => r.accountId !== res.accountId), res]);
      setEmail('');
      toast.success('Поканата е изпратена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setInviting(false);
    }
  }

  async function resend(row: TenantCourierAccess) {
    setBusyIds((cur) => new Set(cur).add(row.accountId));
    try {
      const res = await grantTenantCourierAccess(tenantId, row.email);
      setRows((cur) => (cur ?? []).map((r) => (r.accountId === row.accountId ? res : r)));
      toast.success('Поканата е изпратена отново');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyIds((cur) => {
        const next = new Set(cur);
        next.delete(row.accountId);
        return next;
      });
    }
  }

  async function revoke(row: TenantCourierAccess) {
    setBusyIds((cur) => new Set(cur).add(row.accountId));
    try {
      await revokeTenantCourierAccess(tenantId, row.accountId);
      setRows((cur) => (cur ?? []).filter((r) => r.accountId !== row.accountId));
      toast.success('Достъпът е премахнат');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyIds((cur) => {
        const next = new Set(cur);
        next.delete(row.accountId);
        return next;
      });
    }
  }

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ff-border-2 px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-[15px] font-extrabold">
          <Truck size={16} className="text-ff-green-600" /> Куриери
        </h2>
        {!!rows?.length && (
          <span className="text-[12.5px] text-ff-muted">
            {rows.length} {rows.length === 1 ? 'куриер' : 'куриери'}
          </span>
        )}
      </div>

      <div className="px-5 py-3.5">
        {loadErr && <p className="mb-3 text-[13px] font-semibold text-ff-red">{loadErr}</p>}

        {rows === null && !loadErr && <p className="py-4 text-center text-sm text-ff-muted">Зарежда…</p>}

        {rows?.length === 0 && (
          <p className="py-4 text-center text-sm text-ff-muted">Тази ферма няма поканени куриери.</p>
        )}

        {!!rows?.length && (
          <ul className="flex flex-col divide-y divide-ff-border-2">
            {rows.map((row) => (
              <li key={row.accountId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="inline-flex flex-wrap items-center gap-2 text-[13.5px] text-ff-ink-2">
                  {row.email}
                  {row.invitePending ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-ff-amber-soft px-2 py-0.5 text-[11px] font-bold text-ff-amber-600">
                      <Send size={11} /> поканен
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-50 px-2 py-0.5 text-[11px] font-bold text-ff-green-700">
                      <Check size={11} /> активен
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  {row.invitePending && (
                    <button
                      type="button"
                      onClick={() => void resend(row)}
                      disabled={busyIds.has(row.accountId)}
                      className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[12px] font-bold text-ff-ink-2 hover:bg-ff-surface-2 disabled:opacity-60"
                    >
                      Изпрати отново
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void revoke(row)}
                    disabled={busyIds.has(row.accountId)}
                    className="inline-flex items-center gap-1 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[12px] font-bold text-ff-red hover:bg-ff-red-soft disabled:opacity-60"
                  >
                    <X size={13} /> Премахни достъп
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void invite();
          }}
          className="mt-3 flex flex-wrap items-center gap-2 border-t border-ff-border-2 pt-3.5"
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="имейл на куриера"
            aria-label="Имейл за покана на куриер"
            disabled={inviting}
            className={cn(INPUT, 'max-w-[280px]')}
          />
          <button
            type="submit"
            disabled={inviting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-700 px-3.5 py-2 text-[13px] font-bold text-white hover:brightness-95 disabled:opacity-60"
          >
            <UserPlus size={14} /> {inviting ? 'Кани се…' : 'Покани куриер'}
          </button>
        </form>
      </div>
    </div>
  );
}

export function TenantDetailClient({ detail: d }: { detail: PlatformTenantDetail }) {
  const router = useRouter();
  const active = d.subscriptionStatus === 'active';

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [deliveryOn, setDeliveryOn] = useState(d.deliveryAccount);
  const [onboardOpen, setOnboardOpen] = useState(false);

  async function enableDelivery() {
    setEnabling(true);
    try {
      await enableDeliveryOnFarm(d.id);
      setDeliveryOn(true);
      toast.success(`${d.name}: доставката е включена`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно включване на доставка');
    } finally {
      setEnabling(false);
    }
  }
  const [form, setForm] = useState({
    name: d.name,
    slug: d.slug,
    email: d.email ?? '',
    phone: d.phone ?? '',
    siteUrl: d.siteUrl ?? '',
    deliveryEnabled: d.deliveryEnabled,
    deliveriesPackageEnabled: d.deliveriesPackageEnabled,
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
      deliveriesPackageEnabled: d.deliveriesPackageEnabled,
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
          deliveriesPackageEnabled: form.deliveriesPackageEnabled,
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
                active ? 'bg-ff-green-50 text-ff-green-700' : 'bg-ff-red-soft text-ff-red',
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
          {!deliveryOn && (
            <button
              type="button"
              onClick={enableDelivery}
              disabled={enabling}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-1.5 text-[13px] font-bold text-ff-demo shadow-ff-sm hover:bg-ff-demo-soft disabled:opacity-60"
            >
              <Truck size={14} /> {enabling ? 'Включване…' : 'Включи доставка'}
            </button>
          )}
          <EnterPanelButton tenantId={d.id} />
          <div className="flex flex-wrap justify-end gap-2">
            <Flag on={d.deliveryEnabled} label="Доставка" icon={<Truck size={13} />} />
            <Flag on={d.deliveriesPackageEnabled} label="Пакет Доставки" icon={<Truck size={13} />} />
            <Flag on={deliveryOn} label="Доставка акаунт" icon={<Truck size={13} />} />
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
                placeholder="https://ferma.fermeribg.com"
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
              checked={form.deliveriesPackageEnabled}
              onChange={(v) => setForm({ ...form, deliveriesPackageEnabled: v })}
              label="Пакет Доставки"
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

      {/* farmers + their deliveries — the producer↔login↔carrier↔shipment view */}
      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-[15px] font-extrabold">
            <Users size={16} className="text-ff-green-600" /> Фермери и доставки
          </h2>
          <div className="flex items-center gap-3">
            {d.farmers.length > 0 && (
              <span className="text-[12.5px] text-ff-muted">
                {d.farmers.length} {d.farmers.length === 1 ? 'фермер' : 'фермери'} ·{' '}
                {d.farmers.filter((f) => f.hasLogin).length} с достъп
              </span>
            )}
            <button
              onClick={() => setOnboardOpen(true)}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-ff-green-700 px-3.5 text-[13px] font-bold text-white shadow-ff-sm hover:brightness-95"
            >
              <UserPlus size={16} /> Onboard производител
            </button>
          </div>
        </div>
        {d.farmers.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ff-muted">Тази ферма няма добавени фермери.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                  {['Фермер', 'Вход', 'Свързани', 'Продукти', 'Поръчки', 'Пратки', 'НП чака'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.farmers.map((f) => (
                  <tr key={f.id} className="border-b border-ff-border-2 last:border-0 align-top">
                    <td className="px-4 py-3">
                      <div className="text-[13.5px] font-bold text-ff-ink">{f.name}</div>
                      {f.role && <div className="text-[12px] text-ff-muted">{f.role}</div>}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ff-ink-2">
                      {f.hasLogin ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          {f.loginEmail ?? '—'}
                          {f.invitePending && (
                            <span className="rounded-full bg-ff-amber-soft px-2 py-0.5 text-[11px] font-bold text-ff-amber-600">
                              покана
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ff-muted-2">няма достъп</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <CarrierPill on={f.econtConnected} label="Еконт" />
                        <CarrierPill on={f.speedyConnected} label="Speedy" />
                      </div>
                    </td>
                    <td className="ff-fig px-4 py-3 text-[13.5px] text-ff-ink-2">{f.products}</td>
                    <td className="ff-fig px-4 py-3 text-[13.5px] text-ff-ink-2">{f.courierOrders}</td>
                    <td className="ff-fig whitespace-nowrap px-4 py-3 text-[13.5px] text-ff-ink-2">
                      {f.shipments}
                      {f.draftShipments > 0 && (
                        <span className="ml-1 text-[12px] text-ff-amber-600">+{f.draftShipments} чернови</span>
                      )}
                    </td>
                    <td className="ff-fig px-4 py-3 text-[13.5px] font-bold text-ff-ink">{eur(f.codPendingStotinki)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* driver logins (Task B2) */}
      <CourierAccessSection tenantId={d.id} />

      {/* recent orders */}
      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="text-[15px] font-extrabold">Последни поръчки</h2>
        </div>
        {d.recentOrders.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ff-muted">Все още няма поръчки.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                  {['Поръчка', 'Клиент', 'Сума', 'Статус', 'Дата'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-5 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
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
                      <td className="ff-fig whitespace-nowrap px-5 py-3 text-[13px] font-bold text-ff-ink">№ {o.id.slice(0, 8)}</td>
                      <td className="px-5 py-3 text-[13.5px] text-ff-ink-2">{o.customerName ?? '—'}</td>
                      <td className="ff-fig whitespace-nowrap px-5 py-3 text-[14px] font-bold">{eur(o.totalStotinki)}</td>
                      <td className="px-5 py-3">
                        <span className={cn('inline-flex rounded-full px-2.5 py-1 text-[12px] font-bold', st.tone)}>
                          {st.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-[13px] text-ff-muted">{dmy(o.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {onboardOpen && <ProducerOnboardDialog tenantId={d.id} onClose={() => setOnboardOpen(false)} />}
    </div>
  );
}
