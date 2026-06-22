'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthShell, AuthField, firstMessage } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');

  // Show a hint when we bounced the user here (expired session, or after a reset).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('reason') === 'expired') {
      setNotice('Сесията изтече. Влез отново, за да продължиш.');
    } else if (params.get('reset') === '1') {
      setNotice('Паролата е сменена. Влез с новата парола.');
    }
  }, []);

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
    <AuthShell footer="ФермериБГ © 2026">
      <h1 className="mb-1 text-[20px] font-extrabold">Влез в профила си</h1>
      <p className="mb-[22px] text-[13.5px] text-ff-muted">Продължи към управлението на фермата.</p>

      {notice && (
        <p className="mb-4 rounded-[10px] border border-ff-amber-soft bg-ff-amber-soft/40 px-3.5 py-2.5 text-[13px] font-semibold text-ff-amber-600">
          {notice}
        </p>
      )}

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
            <Link
              href="/forgot-password"
              className="text-[12.5px] font-semibold text-ff-green-700 no-underline"
            >
              Забравена парола?
            </Link>
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

    </AuthShell>
  );
}
