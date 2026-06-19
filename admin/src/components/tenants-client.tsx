'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, AlertTriangle, Plus, Copy, Check, RefreshCw, ChevronRight, Sparkles, FlaskConical, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  ApiError,
  setTenantStatus,
  setTenantPremium,
  createTenant,
  createDemoTenant,
  deleteTenant,
  listTenants,
  type PlatformTenant,
  type Paginated,
} from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';

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

/** Whole days from now until an ISO date (min 0). */
function daysUntil(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

function StatusBadge({ t }: { t: PlatformTenant }) {
  const s = t.subscriptionStatus;
  if (s === 'past_due') {
    const d = daysUntil(t.graceUntil);
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-amber-softer px-2.5 py-1 text-[12.5px] font-bold text-ff-amber-600">
        <span className="h-[7px] w-[7px] rounded-full bg-ff-amber-600" />
        Просрочен{d ? ` · ${d}д` : ''}
      </span>
    );
  }
  const active = s === 'active';
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

function PlanBadge({ premium }: { premium: boolean }) {
  return premium ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-50 px-2.5 py-1 text-[12px] font-bold text-ff-green-700">
      <Sparkles size={12} /> Премиум
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-ff-surface-2 px-2.5 py-1 text-[12px] font-bold text-ff-ink-2">
      Стандартен
    </span>
  );
}

function DemoBadge({ expiresAt }: { expiresAt: string | null }) {
  const d = daysUntil(expiresAt);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#EEF4FF] px-2.5 py-1 text-[12px] font-bold text-[#3457B1]">
      <FlaskConical size={12} /> ДЕМО{expiresAt ? ` · ${d}д` : ''}
    </span>
  );
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  // Use the CSPRNG, not Math.random() — this is a real account credential.
  const rnd = new Uint32Array(14);
  crypto.getRandomValues(rnd);
  let p = '';
  for (let i = 0; i < rnd.length; i++) p += chars[rnd[i] % chars.length];
  return p;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
    >
      {copied ? <Check size={13} className="text-ff-green-600" /> : <Copy size={13} />}
      {copied ? 'Копирано' : 'Копирай'}
    </button>
  );
}

interface AddFarmerDialogProps {
  onClose: () => void;
  onCreated: (t: PlatformTenant) => void;
}

function AddFarmerDialog({ onClose, onCreated }: AddFarmerDialogProps) {
  const [farmName, setFarmName] = useState('');
  const [email, setEmail] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; email: string; tempPassword: string } | null>(null);
  const [fieldErr, setFieldErr] = useState('');

  function fillPassword() {
    setTempPassword(generatePassword());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!farmName.trim() || !email.trim() || !tempPassword.trim()) {
      setFieldErr('Моля попълнете задължителните полета.');
      return;
    }
    setFieldErr('');
    setBusy(true);
    try {
      const res = await createTenant({ farmName: farmName.trim(), email: email.trim(), tempPassword, phone: phone.trim() || undefined });
      const newTenant: PlatformTenant = {
        id: res.id,
        name: res.name,
        slug: res.slug,
        email: res.email,
        phone: phone.trim() || null,
        subscriptionStatus: 'active',
        premium: false,
        graceUntil: null,
        createdAt: new Date().toISOString(),
        orderCount: 0,
        lastOrderAt: null,
        isDemo: false,
        demoExpiresAt: null,
      };
      onCreated(newTenant);
      setCreated({ name: res.name, email: res.email, tempPassword });
      toast.success(`Фермата "${res.name}" е създадена успешно`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.4)]" onClick={created ? onClose : onClose} />
      <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg">
        {!created ? (
          <>
            <h2 className="mb-4 text-[17px] font-extrabold">Нова ферма</h2>
            <form onSubmit={submit} className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Ime на фермата *</span>
                <input
                  value={farmName}
                  onChange={(e) => setFarmName(e.target.value)}
                  placeholder="Ферма Иванови"
                  required
                  className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Имейл *</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="fermer@example.com"
                  required
                  className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Временна парола *</span>
                <div className="flex gap-2">
                  <input
                    value={tempPassword}
                    onChange={(e) => setTempPassword(e.target.value)}
                    placeholder="Въведи или генерирай"
                    required
                    className="h-10 flex-1 rounded-xl border border-ff-border bg-ff-bg px-3 font-mono text-[13.5px] outline-none focus:border-ff-green-500"
                  />
                  <button
                    type="button"
                    onClick={fillPassword}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface-2 px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface"
                  >
                    <RefreshCw size={13} />
                    Генерирай
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Телефон</span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+359 88 …"
                  className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
                />
              </label>
              {fieldErr && <p className="text-[13px] text-ff-red">{fieldErr}</p>}
              <div className="mt-1 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-ff-border bg-ff-surface px-4 py-2.5 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
                >
                  Откажи
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60"
                >
                  {busy ? 'Създаване…' : 'Създай'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="mb-3 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-ff-green-50 text-ff-green-700">
                <Check size={20} />
              </span>
              <div>
                <h2 className="text-[17px] font-extrabold">Фермата е създадена</h2>
                <p className="mt-0.5 text-[13.5px] text-ff-ink-2">
                  <strong>{created.name}</strong> ({created.email}) е готова. Дайте временната парола на фермера — той ще я смени при първо влизане.
                </p>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
              <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Временна парола</p>
              <div className="flex items-center gap-2.5">
                <code className="flex-1 break-all font-mono text-[15px] font-bold">{created.tempPassword}</code>
                <CopyButton text={created.tempPassword} />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={onClose}
                className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95"
              >
                Затвори
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function TenantsClient({ initial }: { initial: Paginated<PlatformTenant> }) {
  const { items: tenants, setItems: setTenants, loadMore, hasMore, loading } = usePaginatedList<PlatformTenant>(
    initial,
    listTenants,
  );
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<PlatformTenant | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [onlyDemo, setOnlyDemo] = useState(false);
  const [creatingDemo, setCreatingDemo] = useState(false);
  const [demoCreds, setDemoCreds] = useState<{ name: string; email: string; password: string; expiresAt: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<PlatformTenant | null>(null);

  const filtered = tenants.filter(
    (t) =>
      (!onlyDemo || t.isDemo) &&
      (!q ||
        t.name.toLowerCase().includes(q.toLowerCase()) ||
        (t.email ?? '').toLowerCase().includes(q.toLowerCase())),
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

  async function applyPremium(t: PlatformTenant, premium: boolean) {
    setBusyId(t.id);
    const prev = t.premium;
    setTenants((p) => p.map((x) => (x.id === t.id ? { ...x, premium } : x)));
    try {
      await setTenantPremium(t.id, premium);
      toast.success(premium ? `${t.name}: премиум (безплатно)` : `${t.name}: стандартен план`);
    } catch (e) {
      setTenants((p) => p.map((x) => (x.id === t.id ? { ...x, premium: prev } : x)));
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  function onCreated(t: PlatformTenant) {
    setTenants((p) => [t, ...p]);
  }

  async function makeDemo() {
    setCreatingDemo(true);
    try {
      const res = await createDemoTenant();
      const row: PlatformTenant = {
        id: res.id,
        name: res.name,
        slug: res.slug,
        email: res.email,
        phone: null,
        subscriptionStatus: 'active',
        premium: false,
        graceUntil: null,
        createdAt: new Date().toISOString(),
        orderCount: 0,
        lastOrderAt: null,
        isDemo: true,
        demoExpiresAt: res.expiresAt,
      };
      setTenants((p) => [row, ...p]);
      setDemoCreds({ name: res.name, email: res.email, password: res.password, expiresAt: res.expiresAt });
      toast.success('Демо акаунтът е създаден');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setCreatingDemo(false);
    }
  }

  async function removeDemo(t: PlatformTenant) {
    setBusyId(t.id);
    try {
      await deleteTenant(t.id);
      setTenants((p) => p.filter((x) => x.id !== t.id));
      toast.success(`${t.name}: изтрит`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
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
        <div className="flex items-center gap-2.5">
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
          <button
            onClick={() => setOnlyDemo((v) => !v)}
            className={cn(
              'inline-flex h-11 items-center gap-2 rounded-xl border px-3.5 text-[13.5px] font-bold shadow-ff-sm',
              onlyDemo ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700' : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
            )}
          >
            <FlaskConical size={16} />
            Само демо
          </button>
          <button
            onClick={makeDemo}
            disabled={creatingDemo}
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-ff-green-600 bg-ff-surface px-4 text-[13.5px] font-bold text-ff-green-700 shadow-ff-sm hover:bg-ff-green-50 disabled:opacity-60"
          >
            <FlaskConical size={17} />
            {creatingDemo ? 'Създаване…' : 'Създай демо'}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95"
          >
            <Plus size={17} />
            Нова ферма
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* desktop table */}
        <table className="w-full border-collapse max-[760px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Ферма', 'Имейл', 'Поръчки', 'План', 'Статус', 'Достъп'].map((h) => (
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
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/tenants/${t.id}`}
                      className="inline-flex items-center gap-1 text-[14.5px] font-bold text-ff-ink no-underline hover:text-ff-green-700 hover:underline"
                    >
                      {t.name}
                      <ChevronRight size={15} className="text-ff-muted-2" />
                    </Link>
                    {t.isDemo && <DemoBadge expiresAt={t.demoExpiresAt} />}
                  </div>
                  <div className="text-xs text-ff-muted-2">/{t.slug}</div>
                </td>
                <td className="px-5 py-3.5 text-[13.5px] text-ff-ink-2">{t.email ?? '—'}</td>
                <td className="ff-fig px-5 py-3.5 text-[14px] font-bold">{t.orderCount}</td>
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2.5">
                    <PlanBadge premium={t.premium} />
                    <Toggle on={t.premium} disabled={busyId === t.id} onChange={(v) => applyPremium(t, v)} />
                  </div>
                </td>
                <td className="px-5 py-3.5">
                  <StatusBadge t={t} />
                </td>
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2.5">
                    <Toggle
                      on={t.subscriptionStatus !== 'inactive'}
                      disabled={busyId === t.id}
                      onChange={(next) => onToggle(t, next)}
                    />
                    {t.isDemo && (
                      <button
                        type="button"
                        onClick={() => setConfirmDel(t)}
                        disabled={busyId === t.id}
                        title="Изтрий демо"
                        className="grid h-9 w-9 place-items-center rounded-lg border border-ff-border text-ff-red hover:bg-[#FBE9E7] disabled:opacity-50"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
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
                  <Link
                    href={`/tenants/${t.id}`}
                    className="inline-flex items-center gap-1 text-[15.5px] font-extrabold text-ff-ink no-underline hover:text-ff-green-700"
                  >
                    {t.name}
                    <ChevronRight size={16} className="text-ff-muted-2" />
                  </Link>
                  <div className="text-[12.5px] text-ff-muted">{t.email ?? '—'}</div>
                  {t.isDemo && <div className="mt-1"><DemoBadge expiresAt={t.demoExpiresAt} /></div>}
                </div>
                <StatusBadge t={t} />
              </div>
              <div className="flex items-center justify-between gap-2.5">
                <div className="flex items-center gap-2">
                  <PlanBadge premium={t.premium} />
                  <Toggle on={t.premium} disabled={busyId === t.id} onChange={(v) => applyPremium(t, v)} />
                </div>
                <div className="flex items-center gap-2 text-[12px] text-ff-muted">
                  Достъп
                  <Toggle
                    on={t.subscriptionStatus !== 'inactive'}
                    disabled={busyId === t.id}
                    onChange={(next) => onToggle(t, next)}
                  />
                  {t.isDemo && (
                    <button
                      type="button"
                      onClick={() => setConfirmDel(t)}
                      disabled={busyId === t.id}
                      title="Изтрий демо"
                      className="grid h-9 w-9 place-items-center rounded-lg border border-ff-border text-ff-red hover:bg-[#FBE9E7] disabled:opacity-50"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && <p className="px-5 py-12 text-center text-sm text-ff-muted">Няма намерени ферми.</p>}
      </div>

      {hasMore && (
        <div className="mt-5 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
          >
            {loading ? 'Зареждане…' : 'Зареди още'}
          </button>
        </div>
      )}

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

      {/* add farmer dialog */}
      {showAdd && (
        <AddFarmerDialog
          onClose={() => setShowAdd(false)}
          onCreated={(t) => {
            onCreated(t);
          }}
        />
      )}

      {/* demo credentials */}
      {demoCreds && (
        <>
          <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.4)]" onClick={() => setDemoCreds(null)} />
          <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg">
            <div className="mb-3 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-ff-green-50 text-ff-green-700">
                <FlaskConical size={20} />
              </span>
              <div>
                <h2 className="text-[17px] font-extrabold">Демо акаунтът е готов</h2>
                <p className="mt-0.5 text-[13.5px] text-ff-ink-2">
                  <strong>{demoCreds.name}</strong> — дайте тези данни на приятел. Изтрива се автоматично на{' '}
                  {new Date(demoCreds.expiresAt).toLocaleDateString('bg-BG')}.
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2.5">
              <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Имейл</p>
                <div className="flex items-center gap-2.5">
                  <code className="flex-1 break-all font-mono text-[14px] font-bold">{demoCreds.email}</code>
                  <CopyButton text={demoCreds.email} />
                </div>
              </div>
              <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Парола</p>
                <div className="flex items-center gap-2.5">
                  <code className="flex-1 break-all font-mono text-[15px] font-bold">{demoCreds.password}</code>
                  <CopyButton text={demoCreds.password} />
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setDemoCreds(null)} className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95">
                Затвори
              </button>
            </div>
          </div>
        </>
      )}

      {/* confirm demo delete */}
      {confirmDel && (
        <>
          <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.4)]" onClick={() => setConfirmDel(null)} />
          <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 w-[400px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg">
            <div className="mb-3 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-[#FBE9E7] text-ff-red">
                <AlertTriangle size={20} />
              </span>
              <div>
                <h2 className="text-[17px] font-extrabold">Изтриване на демо</h2>
                <p className="mt-0.5 text-[13.5px] leading-[1.45] text-ff-ink-2">
                  Изтриване на <strong>{confirmDel.name}</strong> и всичките му данни? Това е необратимо.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2.5">
              <button onClick={() => setConfirmDel(null)} className="rounded-xl border border-ff-border bg-ff-surface px-4 py-2.5 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">
                Откажи
              </button>
              <button
                onClick={() => { const t = confirmDel; setConfirmDel(null); removeDemo(t); }}
                className="rounded-xl bg-ff-red px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95"
              >
                Изтрий
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
