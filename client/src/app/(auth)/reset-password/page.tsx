'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthShell, AuthField, firstMessage } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';

export default function ResetPasswordPage() {
  const router = useRouter();
  // undefined = still reading the URL · null = no token · string = ready
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token');
    setToken(t && t.length > 10 ? t : null);
    // Strip the token from the address bar so it doesn't linger in browser
    // history or server access logs once we've captured it in state.
    if (t) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (pw.length < 8) {
      setError('Паролата трябва да е поне 8 символа.');
      return;
    }
    if (pw !== pw2) {
      setError('Двете пароли не съвпадат.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/session/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: pw }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(firstMessage(data?.message) ?? 'Връзката е невалидна или изтекла.');
        return;
      }
      router.push('/login?reset=1');
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  if (token === undefined) {
    return (
      <AuthShell footer="ФермериБГ © 2026">
        <p className="text-[14px] text-ff-muted">Зареждане…</p>
      </AuthShell>
    );
  }

  if (token === null) {
    return (
      <AuthShell footer="ФермериБГ © 2026">
        <h1 className="mb-1 text-[20px] font-extrabold">Невалидна връзка</h1>
        <p className="mb-[22px] text-[13.5px] text-ff-muted">
          Връзката за смяна на паролата липсва или е непълна. Заяви нова.
        </p>
        <Link
          href="/forgot-password"
          className="text-[13.5px] font-semibold text-ff-green-700 no-underline"
        >
          Заяви нова връзка →
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell footer="ФермериБГ © 2026">
      <h1 className="mb-1 text-[20px] font-extrabold">Нова парола</h1>
      <p className="mb-[22px] text-[13.5px] text-ff-muted">Въведи новата си парола два пъти.</p>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthField
          label="Нова парола"
          type="password"
          placeholder="••••••••"
          autoComplete="new-password"
          required
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <AuthField
          label="Повтори новата парола"
          type="password"
          placeholder="••••••••"
          autoComplete="new-password"
          required
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />

        {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

        <Button
          variant="primary"
          type="submit"
          disabled={loading}
          className="mt-0.5 w-full rounded-sm py-[13px] text-[15.5px]"
        >
          {loading ? 'Запазване…' : 'Запази новата парола'}
        </Button>
      </form>
    </AuthShell>
  );
}
