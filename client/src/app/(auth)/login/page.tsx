'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthShell, AuthField, firstMessage } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';

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
        setError(firstMessage(data?.message) ?? 'Грешен имейл или парола');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell footer="FarmFlow © 2026">
      <h1 className="mb-1 text-[20px] font-extrabold">Влез в профила си</h1>
      <p className="mb-[22px] text-[13.5px] text-ff-muted">Продължи към управлението на фермата.</p>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthField
          label="Имейл"
          type="email"
          placeholder="ime@ferma.bg"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div>
          <AuthField
            label="Парола"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="mt-[7px] text-right">
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="text-[12.5px] font-semibold text-ff-green-700 no-underline"
            >
              Забравена парола?
            </a>
          </div>
        </div>

        {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

        <Button
          variant="primary"
          type="submit"
          disabled={loading}
          className="mt-0.5 w-full rounded-sm py-[13px] text-[15.5px]"
        >
          {loading ? 'Зареждане…' : 'Влез'}
        </Button>
      </form>

      <div className="mt-5 text-center text-[13.5px] text-ff-ink-2">
        Нямаш акаунт?{' '}
        <Link href="/register" className="font-bold text-ff-green-700 no-underline">
          Регистрирай се
        </Link>
      </div>
    </AuthShell>
  );
}
