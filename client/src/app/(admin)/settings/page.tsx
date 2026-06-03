'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { firstMessage } from '@/components/auth/auth-shell';

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
  const [mustChange, setMustChange] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/bff/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.mustChangePassword) setMustChange(true);
      })
      .catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

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
      toast.success('Паролата е сменена успешно');
      router.push('/dashboard');
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

      {mustChange && (
        <div className="mb-6 rounded-[10px] border border-ff-amber-soft bg-ff-amber-soft/40 px-4 py-3 text-[13.5px] font-semibold text-ff-amber-600">
          Смени временната си парола, за да продължиш.
        </div>
      )}

      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <h2 className="mb-4 text-[16px] font-extrabold">Смяна на парола</h2>
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
    </div>
  );
}
