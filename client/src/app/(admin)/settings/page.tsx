'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { firstMessage } from '@/components/auth/auth-shell';
import { getTenant, updateTenant } from '@/lib/api-client';
import type { RouteEndMode, RoutingConfig } from '@/lib/types';

const END_LABELS: { mode: RouteEndMode; label: string; hint: string }[] = [
  { mode: 'home', label: 'Към дома', hint: 'обратно до базата' },
  { mode: 'last', label: 'Едностранно', hint: 'край при последната доставка' },
  { mode: 'custom', label: 'По избор', hint: 'друг адрес' },
];

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
      <input
        className="rounded-sm border border-ff-border bg-ff-surface-2 px-3.5 py-3 text-[15px] text-ff-ink outline-none transition-colors placeholder:text-ff-muted-2 focus:border-ff-green-500"
        {...props}
      />
    </label>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  // Home / depot + route-end settings.
  const [home, setHome] = useState('');
  const [endMode, setEndMode] = useState<RouteEndMode>('home');
  const [endAddr, setEndAddr] = useState('');
  const [savingLoc, setSavingLoc] = useState(false);

  useEffect(() => {
    getTenant()
      .then((t) => {
        setHome(t.farmAddress ?? '');
        const r = (t.routing ?? {}) as RoutingConfig;
        setEndMode(r.endMode ?? 'home');
        setEndAddr(r.endAddress ?? '');
      })
      .catch(() => {});
  }, []);

  async function saveLocation(e: React.FormEvent) {
    e.preventDefault();
    setSavingLoc(true);
    try {
      await updateTenant({
        farmAddress: home.trim(),
        routing: { endMode, endAddress: endMode === 'custom' ? endAddr.trim() : '' },
      });
      toast.success('Локацията е запазена');
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSavingLoc(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setDone(false);

    if (next.length < 6) {
      setError('Новата парола трябва да е поне 6 символа');
      return;
    }
    if (next !== confirm) {
      setError('Паролите не съвпадат');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/session/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(firstMessage(data?.message) ?? 'Грешна текуща парола');
        return;
      }
      // Stay on the page and surface a clear success state (the status moves from
      // the form to a confirmation) instead of redirecting away silently.
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      toast.success('Паролата е сменена успешно');
      router.refresh();
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-[480px]">
      <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Настройки</h1>
      <p className="mb-6 text-[13.5px] text-ff-muted">Управлявай настройките на профила си.</p>

      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <h2 className="mb-4 text-[16px] font-extrabold">Смяна на парола</h2>

        {done && (
          <div className="mb-4 flex items-center gap-2.5 rounded-[10px] border border-ff-green-100 bg-ff-green-50 px-4 py-3 text-[13.5px] font-semibold text-ff-green-800">
            <Check size={17} strokeWidth={2.6} className="shrink-0 text-ff-green-600" />
            Паролата е сменена успешно. Следващия път влез с новата парола.
          </div>
        )}

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field
            label="Текуща парола"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Field
            label="Нова парола"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <Field
            label="Потвърди нова парола"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />

          {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

          <Button
            variant="primary"
            type="submit"
            disabled={loading}
            className="mt-0.5 w-full rounded-sm py-[13px] text-[15.5px]"
          >
            {loading ? 'Зареждане…' : 'Смени паролата'}
          </Button>
        </form>
      </div>

      {/* Home / depot + route end */}
      <div className="mt-6 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <h2 className="mb-1 text-[16px] font-extrabold">Локация и маршрут</h2>
        <p className="mb-4 text-[13px] text-ff-muted">
          Адресът на базата е началото на маршрута за доставка. Запазва се като точка на картата.
        </p>
        <form onSubmit={saveLocation} className="flex flex-col gap-4">
          <Field
            label="Адрес на базата (дом)"
            placeholder="напр. с. Звездица, общ. Варна"
            value={home}
            onChange={(e) => setHome(e.target.value)}
          />

          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ff-ink-2">Край на маршрута</span>
            <div className="flex flex-wrap gap-2">
              {END_LABELS.map(({ mode, label, hint }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setEndMode(mode)}
                  className={`flex-1 rounded-sm border px-3 py-2.5 text-left transition ${
                    endMode === mode
                      ? 'border-ff-green-500 bg-ff-green-100'
                      : 'border-ff-border bg-ff-surface-2 hover:border-ff-green-500'
                  }`}
                >
                  <span className="block text-[14px] font-bold text-ff-ink">{label}</span>
                  <span className="block text-[12px] text-ff-muted">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {endMode === 'custom' && (
            <Field
              label="Краен адрес"
              placeholder="напр. бул. Сливница 33, Варна"
              value={endAddr}
              onChange={(e) => setEndAddr(e.target.value)}
            />
          )}

          <Button
            variant="primary"
            type="submit"
            disabled={savingLoc}
            className="mt-0.5 w-full rounded-sm py-[13px] text-[15.5px]"
          >
            {savingLoc ? 'Записване…' : 'Запази локацията'}
          </Button>
        </form>
      </div>
    </div>
  );
}
