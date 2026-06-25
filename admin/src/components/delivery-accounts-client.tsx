'use client';

import { useEffect, useState } from 'react';
import { Search, Plus, Truck, Store, Copy, Check, RefreshCw, X, Package } from 'lucide-react';
import { toast } from 'sonner';
import { eur } from '@/lib/utils';
import {
  ApiError,
  listDeliveryAccounts,
  createDeliveryAccount,
  setDeliveryActive,
  listDeliveryShipments,
  type DeliveryAccount,
  type DeliveryShipment,
  type Paginated,
} from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

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

function TypeBadges({ type }: { type: DeliveryAccount['type'] }) {
  const shop = type === 'farm' || type === 'both';
  const delivery = type === 'delivery' || type === 'both';
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {shop && (
        <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-50 px-2 py-0.5 text-[12px] font-bold text-ff-green-700">
          <Store size={12} /> Магазин
        </span>
      )}
      {delivery && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#EEF4FF] px-2 py-0.5 text-[12px] font-bold text-[#3457B1]">
          <Truck size={12} /> Доставка
        </span>
      )}
    </span>
  );
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const rnd = new Uint32Array(14);
  crypto.getRandomValues(rnd);
  let p = '';
  for (let i = 0; i < rnd.length; i++) p += chars[rnd[i] % chars.length];
  return p;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
      className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
    >
      {copied ? <Check size={13} className="text-ff-green-600" /> : <Copy size={13} />}
      {copied ? 'Копирано' : 'Копирай'}
    </button>
  );
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const DEAD_COD = ['cancelled', 'failed', 'returned', 'refused', 'върн', 'отказ', 'анулир'];

/** COD state for one shipment: collected (money in), dead (never coming), or pending. */
function codState(s: DeliveryShipment): 'collected' | 'dead' | 'pending' {
  if (s.codCollectedAt || s.codSettledAt) return 'collected';
  const st = (s.status ?? '').toLowerCase();
  if (DEAD_COD.some((m) => st.includes(m))) return 'dead';
  return 'pending';
}

function StatusPill({ status }: { status: string }) {
  const st = (status ?? '').toLowerCase();
  const dead = DEAD_COD.some((m) => st.includes(m));
  const done = st.includes('deliver') || st.includes('достав');
  const tone = dead
    ? 'bg-[#FBE9E7] text-ff-red'
    : done
      ? 'bg-ff-green-100 text-ff-green-800'
      : 'bg-ff-surface-2 text-ff-ink-2';
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[12px] font-bold ${tone}`}>
      {status || '—'}
    </span>
  );
}

function CarrierTag({ carrier }: { carrier: string }) {
  const speedy = carrier === 'speedy';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-bold ${
        speedy ? 'bg-[#FFF1E8] text-[#B4541C]' : 'bg-[#EEF4FF] text-[#3457B1]'
      }`}
    >
      {speedy ? 'Speedy' : 'Econt'}
    </span>
  );
}

/** Slide-over with the FULL shipment history of one account (paginated „Зареди още"). */
function ShipmentHistoryDrawer({ account, onClose }: { account: DeliveryAccount; onClose: () => void }) {
  const [items, setItems] = useState<DeliveryShipment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listDeliveryShipments(account.id)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e) => alive && setErr(errMsg(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [account.id]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await listDeliveryShipments(account.id, cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }

  const cod = (s: DeliveryShipment) => {
    const v = s.codAmountStotinki ?? 0;
    if (v === 0) return <span className="text-ff-muted">—</span>;
    const state = codState(s);
    const tone = state === 'collected' ? 'text-ff-green-700' : state === 'dead' ? 'text-ff-muted line-through' : 'text-ff-ink-2';
    return <span className={`ff-fig ${tone}`} title={state === 'collected' ? 'Събрано' : state === 'dead' ? 'Няма да се събере' : 'Чака'}>{eur(v)}</span>;
  };

  const track = (s: DeliveryShipment) => s.trackingNumber || s.econtShipmentNumber || '—';

  return (
    <>
      <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.4)]" onClick={onClose} />
      <div className="animate-ff-fade-up fixed right-0 top-0 z-50 flex h-full w-[760px] max-w-[96vw] flex-col border-l border-ff-border bg-ff-bg shadow-ff-lg">
        <div className="flex items-start justify-between gap-3 border-b border-ff-border bg-ff-surface px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Package size={18} className="text-ff-green-600" />
              <h2 className="truncate text-[17px] font-extrabold">Всички пратки — {account.name}</h2>
            </div>
            <p className="mt-0.5 text-[13px] text-ff-muted">
              {account.overview.total} общо · {eur(account.overview.codPendingStotinki)} чака · <span className="text-ff-green-700">{eur(account.overview.codCollectedStotinki)} събрано</span>
            </p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {err && <p className="px-5 py-12 text-center text-sm text-ff-red">{err}</p>}

          {!err && (
            <>
              {/* desktop */}
              <table className="w-full border-collapse max-[760px]:hidden">
                <thead>
                  <tr className="sticky top-0 z-10 border-b border-ff-border bg-ff-surface-2 text-left">
                    {['Получател', 'Куриер', 'Статус', 'Наложен платеж', 'Проследяване', 'Създадена'].map((h) => (
                      <th key={h} className="px-4 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((s) => (
                    <tr key={s.id} className="border-b border-ff-border-2 last:border-0">
                      <td className="px-4 py-3 text-[13.5px] font-bold text-ff-ink">{s.receiverName ?? '—'}</td>
                      <td className="px-4 py-3"><CarrierTag carrier={s.carrier} /></td>
                      <td className="px-4 py-3"><StatusPill status={s.status} /></td>
                      <td className="px-4 py-3 text-[13px] whitespace-nowrap">{cod(s)}</td>
                      <td className="ff-fig px-4 py-3 text-[12.5px] text-ff-ink-2">{track(s)}</td>
                      <td className="ff-fig px-4 py-3 text-[12.5px] text-ff-ink-2 whitespace-nowrap">{fmtDateTime(s.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* mobile cards */}
              <div className="hidden flex-col max-[760px]:flex">
                {items.map((s) => (
                  <div key={s.id} className="flex flex-col gap-2 border-b border-ff-border-2 px-4 py-3 last:border-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[14.5px] font-extrabold text-ff-ink">{s.receiverName ?? '—'}</div>
                      <StatusPill status={s.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ff-muted">
                      <CarrierTag carrier={s.carrier} />
                      <span>Платеж: {cod(s)}</span>
                      <span>Просл.: <span className="ff-fig text-ff-ink-2">{track(s)}</span></span>
                      <span>{fmtDateTime(s.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {!loading && items.length === 0 && (
                <p className="px-5 py-12 text-center text-sm text-ff-muted">Няма пратки за този акаунт.</p>
              )}

              {(cursor || loading) && (
                <div className="flex justify-center px-5 py-5">
                  <button
                    onClick={loadMore}
                    disabled={loading || !cursor}
                    className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
                  >
                    {loading ? 'Зареждане…' : 'Зареди още'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (a: DeliveryAccount) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [shop, setShop] = useState(false);
  const [delivery, setDelivery] = useState(true);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 12) { setErr('Попълнете име, имейл и парола (поне 12 знака).'); return; }
    if (!shop && !delivery) { setErr('Изберете поне една роля.'); return; }
    setErr(''); setBusy(true);
    try {
      const res = await createDeliveryAccount({ name: name.trim(), email: email.trim(), password, phone: phone.trim() || undefined, shop, delivery, active });
      onCreated({
        id: res.id, name: res.name, slug: res.slug, email: res.email, phone: phone.trim() || null,
        type: shop && delivery ? 'both' : delivery ? 'delivery' : 'farm',
        active, createdAt: new Date().toISOString(),
        overview: { total: 0, codPendingStotinki: 0, codCollectedStotinki: 0, econt: 0, speedy: 0, lastShipmentAt: null },
      });
      setCreated({ name: res.name, email: res.email, password: res.password });
      toast.success(`Акаунтът "${res.name}" е създаден`);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.4)]" onClick={onClose} />
      <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg">
        {!created ? (
          <>
            <h2 className="mb-4 text-[17px] font-extrabold">Нов акаунт за доставка</h2>
            <form onSubmit={submit} className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Име *</span>
                <input value={name} onChange={(e) => setName(e.target.value)} required className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Имейл *</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Парола *</span>
                <div className="flex gap-2">
                  <input value={password} onChange={(e) => setPassword(e.target.value)} required className="h-10 flex-1 rounded-xl border border-ff-border bg-ff-bg px-3 font-mono text-[13.5px] outline-none focus:border-ff-green-500" />
                  <button type="button" onClick={() => setPassword(generatePassword())} className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface-2 px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface">
                    <RefreshCw size={13} /> Генерирай
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-bold text-ff-ink-2">Телефон</span>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500" />
              </label>
              <div className="flex flex-wrap gap-4 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
                <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={shop} onChange={(e) => setShop(e.target.checked)} /> Магазин</label>
                <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} /> Доставка</label>
                <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Активен</label>
              </div>
              {err && <p className="text-[13px] text-ff-red">{err}</p>}
              <div className="mt-1 flex justify-end gap-2.5">
                <button type="button" onClick={onClose} className="rounded-xl border border-ff-border bg-ff-surface px-4 py-2.5 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">Откажи</button>
                <button type="submit" disabled={busy} className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60">{busy ? 'Създаване…' : 'Създай'}</button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="mb-3 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-ff-green-50 text-ff-green-700"><Check size={20} /></span>
              <div>
                <h2 className="text-[17px] font-extrabold">Акаунтът е създаден</h2>
                <p className="mt-0.5 text-[13.5px] text-ff-ink-2"><strong>{created.name}</strong> — данните за вход в приложението за доставка. Показват се само сега.</p>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2.5">
              <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Имейл</p>
                <div className="flex items-center gap-2.5"><code className="flex-1 break-all font-mono text-[14px] font-bold">{created.email}</code><CopyButton text={created.email} /></div>
              </div>
              <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">Парола</p>
                <div className="flex items-center gap-2.5"><code className="flex-1 break-all font-mono text-[15px] font-bold">{created.password}</code><CopyButton text={created.password} /></div>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={onClose} className="rounded-xl bg-ff-green-700 px-4 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95">Затвори</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function DeliveryAccountsClient({ initial }: { initial: Paginated<DeliveryAccount> }) {
  const { items, setItems, loadMore, hasMore, loading } = usePaginatedList<DeliveryAccount>(initial, listDeliveryAccounts);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [detail, setDetail] = useState<DeliveryAccount | null>(null);

  const needle = q.trim().toLowerCase();
  const rows = items.filter((a) => !needle || a.name.toLowerCase().includes(needle) || (a.email ?? '').toLowerCase().includes(needle) || a.slug.toLowerCase().includes(needle));

  async function toggle(a: DeliveryAccount, next: boolean) {
    setBusyId(a.id);
    setItems((p) => p.map((x) => (x.id === a.id ? { ...x, active: next } : x)));
    try {
      await setDeliveryActive(a.id, next);
      toast.success(next ? `${a.name}: услугата е включена` : `${a.name}: услугата е спряна`);
    } catch (e) {
      setItems((p) => p.map((x) => (x.id === a.id ? { ...x, active: !next } : x)));
      toast.error(errMsg(e));
    } finally { setBusyId(null); }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Доставка</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">{items.length} {items.length === 1 ? 'акаунт' : 'акаунта'}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative w-[280px] max-[560px]:w-full">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ff-muted"><Search size={18} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Търси по име, имейл или slug…" className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-11 pr-3 text-[14.5px] shadow-ff-sm outline-none focus:border-ff-green-500" />
          </div>
          <button onClick={() => setShowAdd(true)} className="inline-flex h-11 items-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95">
            <Plus size={17} /> Нов акаунт
          </button>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* desktop */}
        <table className="w-full border-collapse max-[860px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Акаунт', 'Тип', 'Пратки', 'Наложен платеж', 'Последна', 'Услуга'].map((h) => (
                <th key={h} className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr
                key={a.id}
                onClick={() => setDetail(a)}
                className="cursor-pointer border-b border-ff-border-2 last:border-0 hover:bg-ff-surface-2"
                title="Виж всички пратки"
              >
                <td className="px-5 py-3.5">
                  <div className="text-[14.5px] font-bold text-ff-ink">{a.name}</div>
                  <div className="text-xs text-ff-muted-2">{a.email ?? '—'} · /{a.slug}</div>
                </td>
                <td className="px-5 py-3.5"><TypeBadges type={a.type} /></td>
                <td className="ff-fig px-5 py-3.5 text-[14px] font-bold">
                  {a.overview.total}
                  <span className="ml-1 text-[11.5px] font-normal text-ff-muted">({a.overview.econt}E·{a.overview.speedy}S)</span>
                </td>
                <td className="ff-fig px-5 py-3.5 text-[13px] text-ff-ink-2 whitespace-nowrap">
                  <span title="Чака">{eur(a.overview.codPendingStotinki)}</span>
                  <span className="text-ff-muted"> · </span>
                  <span className="text-ff-green-700" title="Събрано">{eur(a.overview.codCollectedStotinki)}</span>
                </td>
                <td className="ff-fig px-5 py-3.5 text-[13px] text-ff-ink-2 whitespace-nowrap">{fmtDate(a.overview.lastShipmentAt)}</td>
                <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}><Toggle on={a.active} disabled={busyId === a.id} onChange={(v) => toggle(a, v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* mobile cards */}
        <div className="hidden flex-col max-[860px]:flex">
          {rows.map((a) => (
            <div key={a.id} onClick={() => setDetail(a)} className="flex cursor-pointer flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 last:border-0 active:bg-ff-surface-2">
              <div className="flex items-start justify-between gap-2.5">
                <div className="min-w-0">
                  <div className="text-[15.5px] font-extrabold text-ff-ink">{a.name}</div>
                  <div className="text-[12.5px] text-ff-muted">{a.email ?? '—'}</div>
                  <div className="mt-1"><TypeBadges type={a.type} /></div>
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <Toggle on={a.active} disabled={busyId === a.id} onChange={(v) => toggle(a, v)} />
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ff-muted">
                <span>Пратки: <b className="ff-fig text-ff-ink-2">{a.overview.total}</b></span>
                <span>Чака: <span className="ff-fig text-ff-ink-2">{eur(a.overview.codPendingStotinki)}</span></span>
                <span>Събрано: <span className="ff-fig text-ff-green-700">{eur(a.overview.codCollectedStotinki)}</span></span>
                <span>Последна: <span className="ff-fig text-ff-ink-2">{fmtDate(a.overview.lastShipmentAt)}</span></span>
              </div>
            </div>
          ))}
        </div>

        {rows.length === 0 && <p className="px-5 py-12 text-center text-sm text-ff-muted">{needle ? 'Няма намерени акаунти.' : 'Все още няма акаунти за доставка.'}</p>}
      </div>

      {hasMore && (
        <div className="mt-5 flex justify-center">
          <button onClick={loadMore} disabled={loading} className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60">
            {loading ? 'Зареждане…' : 'Зареди още'}
          </button>
        </div>
      )}

      {showAdd && <CreateDialog onClose={() => setShowAdd(false)} onCreated={(a) => setItems((p) => [a, ...p])} />}
      {detail && <ShipmentHistoryDrawer account={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
