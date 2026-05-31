'use client';

import { useState } from 'react';
import { Search, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { cn, dmy } from '@/lib/utils';
import { ApiError, setTenantStatus, type PlatformTenant } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="relative shrink-0 rounded-full transition-colors disabled:opacity-50"
      style={{ width: 46, height: 26, padding: 3, background: on ? 'var(--ff-green-600)' : '#D9D2C2' }}
    >
      <span
        className="absolute rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200"
        style={{ top: 3, left: on ? 23 : 3, width: 20, height: 20 }}
      />
    </button>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-bold',
        active ? 'bg-ff-green-50 text-ff-green-700' : 'bg-[#FBE9E7] text-ff-red',
      )}
    >
      <span className={cn('h-[7px] w-[7px] rounded-full', active ? 'bg-ff-green-500' : 'bg-ff-red')} />
      {active ? 'Активен' : 'Спрян'}
    </span>
  );
}

export function TenantsClient({ initial }: { initial: PlatformTenant[] }) {
  const [tenants, setTenants] = useState<PlatformTenant[]>(initial);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<PlatformTenant | null>(null);

  const filtered = tenants.filter(
    (t) =>
      !q ||
      t.name.toLowerCase().includes(q.toLowerCase()) ||
      (t.email ?? '').toLowerCase().includes(q.toLowerCase()),
  );

  async function apply(t: PlatformTenant, status: 'active' | 'inactive') {
    setBusyId(t.id);
    const prev = t.subscriptionStatus;
    setTenants((p) => p.map((x) => (x.id === t.id ? { ...x, subscriptionStatus: status } : x)));
    try {
      await setTenantStatus(t.id, status);
      toast.success(status === 'active' ? `${t.name}: достъпът е възстановен` : `${t.name}: достъпът е спрян`);
    } catch (e) {
      setTenants((p) => p.map((x) => (x.id === t.id ? { ...x, subscriptionStatus: prev } : x)));
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  // Disabling asks for confirmation; enabling is immediate.
  function onToggle(t: PlatformTenant, next: boolean) {
    if (!next) setConfirmOff(t);
    else apply(t, 'active');
  }

  const activeCount = tenants.filter((t) => t.subscriptionStatus === 'active').length;

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Фермери</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            {tenants.length} {tenants.length === 1 ? 'ферма' : 'ферми'} · {activeCount} активни
          </p>
        </div>
        <div className="relative w-[280px] max-[560px]:w-full">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ff-muted">
            <Search size={18} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Търси по ферма или имейл…"
            className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-11 pr-3 text-[14.5px] shadow-ff-sm outline-none focus:border-ff-green-500"
          />
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* desktop table */}
        <table className="w-full border-collapse max-[760px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Ферма', 'Имейл', 'Телефон', 'Поръчки', 'Последна поръчка', 'Статус', 'Действие'].map((h) => (
                <th key={h} className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id} className="border-b border-ff-border-2 last:border-0">
                <td className="px-5 py-3.5">
                  <div className="text-[14.5px] font-bold">{t.name}</div>
                  <div className="text-xs text-ff-muted-2">/{t.slug}</div>
                </td>
                <td className="px-5 py-3.5 text-[13.5px] text-ff-ink-2">{t.email ?? '—'}</td>
                <td className="px-5 py-3.5 text-[13.5px] text-ff-ink-2">{t.phone ?? '—'}</td>
                <td className="ff-fig px-5 py-3.5 text-[14px] font-bold">{t.orderCount}</td>
                <td className="px-5 py-3.5 text-[13.5px] text-ff-ink-2">{dmy(t.lastOrderAt)}</td>
                <td className="px-5 py-3.5">
                  <StatusBadge active={t.subscriptionStatus === 'active'} />
                </td>
                <td className="px-5 py-3.5">
                  <Toggle
                    on={t.subscriptionStatus === 'active'}
                    disabled={busyId === t.id}
                    onChange={(next) => onToggle(t, next)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* mobile cards */}
        <div className="hidden flex-col max-[760px]:flex">
          {filtered.map((t) => (
            <div key={t.id} className="flex flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 last:border-0">
              <div className="flex items-start justify-between gap-2.5">
                <div className="min-w-0">
                  <div className="text-[15.5px] font-extrabold">{t.name}</div>
                  <div className="text-[12.5px] text-ff-muted">{t.email ?? '—'}</div>
                </div>
                <StatusBadge active={t.subscriptionStatus === 'active'} />
              </div>
              <div className="flex items-center justify-between text-[12.5px] text-ff-muted">
                <span>
                  {t.orderCount} поръчки · {dmy(t.lastOrderAt)}
                </span>
                <Toggle
                  on={t.subscriptionStatus === 'active'}
                  disabled={busyId === t.id}
                  onChange={(next) => onToggle(t, next)}
                />
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && <p className="px-5 py-12 text-center text-sm text-ff-muted">Няма намерени ферми.</p>}
      </div>

      {/* confirm disable dialog */}
      {confirmOff && (
        <>
          <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.4)]" onClick={() => setConfirmOff(null)} />
          <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 w-[400px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg">
            <div className="mb-3 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-[#FBE9E7] text-ff-red">
                <AlertTriangle size={20} />
              </span>
              <div>
                <h2 className="text-[17px] font-extrabold">Спиране на достъпа</h2>
                <p className="mt-0.5 text-[13.5px] leading-[1.45] text-ff-ink-2">
                  Спиране на достъпа за <strong>{confirmOff.name}</strong>? Фермерът ще може да влезе, но маршрут,
                  производство и създаване на слотове ще бъдат блокирани, а историята — ограничена до 7 дни. Онлайн
                  магазинът продължава да работи.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2.5">
              <button
                onClick={() => setConfirmOff(null)}
                className="rounded-xl border border-ff-border bg-ff-surface px-4 py-2.5 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
              >
                Откажи
              </button>
              <button
                onClick={() => {
                  const t = confirmOff;
                  setConfirmOff(null);
                  apply(t, 'inactive');
                }}
                className="rounded-xl bg-ff-red px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95"
              >
                Спри достъпа
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
