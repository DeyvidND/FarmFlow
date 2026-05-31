'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Leaf } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.message ?? 'Грешен имейл или парола');
        return;
      }
      router.push('/tenants');
      router.refresh();
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-ff-bg px-4">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-ff-green-700 text-[#EAF1E4] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
            <Leaf size={28} strokeWidth={1.9} />
          </div>
          <div className="text-center">
            <div className="font-display text-[22px] font-extrabold tracking-[-0.01em]">FarmFlow — Платформа</div>
            <div className="mt-0.5 text-[13px] font-semibold text-ff-muted">Администрация на фермите</div>
          </div>
        </div>

        <div className="rounded-2xl border border-ff-border bg-ff-surface p-7 shadow-ff-md">
          <h1 className="mb-1 text-[19px] font-extrabold">Вход за администратор</h1>
          <p className="mb-[22px] text-[13.5px] text-ff-muted">Управление на абонаментите на фермите.</p>

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-bold text-ff-ink-2">Имейл</span>
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="admin@farmflow.bg"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[14.5px] outline-none focus:border-ff-green-500"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-bold text-ff-ink-2">Парола</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[14.5px] outline-none focus:border-ff-green-500"
              />
            </label>

            {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="mt-0.5 h-12 w-full rounded-xl bg-ff-green-700 text-[15.5px] font-bold text-white transition hover:brightness-95 disabled:opacity-60"
            >
              {loading ? 'Зареждане…' : 'Влез'}
            </button>
          </form>
        </div>
        <div className="mt-5 text-center text-[12.5px] text-ff-muted">FarmFlow © 2026</div>
      </div>
    </div>
  );
}
