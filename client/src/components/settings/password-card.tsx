'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { firstMessage } from '@/components/auth/auth-shell';

export function PasswordCard() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setDone(false);

    if (next.length < 8) {
      setError('Новата парола трябва да е поне 8 символа');
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
    <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
      <h2 className="mb-4 text-[16px] font-extrabold">Смяна на парола</h2>

      {done && (
        <div className="mb-4 flex items-center gap-2.5 rounded-[10px] border border-ff-green-100 bg-ff-green-50 px-4 py-3 text-[13.5px] font-semibold text-ff-green-800">
          <Check size={17} strokeWidth={2.6} className="shrink-0 text-ff-green-600" />
          Паролата е сменена успешно. Следващия път влез с новата парола.
        </div>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Текуща парола"
          type="password"
          placeholder="••••••••"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <TextField
          label="Нова парола"
          type="password"
          placeholder="••••••••"
          autoComplete="new-password"
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <TextField
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
  );
}
