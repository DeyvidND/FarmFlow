'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthShell, AuthField, firstMessage } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';

export default function RegisterPage() {
  const router = useRouter();
  const [farm, setFarm] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== password2) {
      setError('Паролите не съвпадат');
      return;
    }
    if (password.length < 6) {
      setError('Паролата трябва да е поне 6 символа');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/session/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farmName: farm, email, phone: phone || undefined, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(firstMessage(data?.message) ?? 'Регистрацията е неуспешна');
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
      <h1 className="mb-1 text-[20px] font-extrabold">Създай акаунт</h1>
      <p className="mb-[22px] text-[13.5px] text-ff-muted">Започни да управляваш поръчките си днес.</p>

      <form onSubmit={onSubmit} className="flex flex-col gap-[15px]">
        <AuthField
          label="Име на фермата"
          placeholder="Ферма Петрови"
          required
          value={farm}
          onChange={(e) => setFarm(e.target.value)}
        />
        <AuthField
          label="Имейл"
          type="email"
          placeholder="ime@ferma.bg"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label="Телефон"
          type="tel"
          placeholder="+359 88 000 0000"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <AuthField
            label="Парола"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <AuthField
            label="Потвърди парола"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            required
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
          />
        </div>

        {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

        <Button
          variant="primary"
          type="submit"
          disabled={loading}
          className="mt-1 w-full rounded-sm py-[13px] text-[15.5px]"
        >
          {loading ? 'Зареждане…' : 'Създай акаунт'}
        </Button>

        <p className="mt-0.5 text-center text-xs leading-[1.5] text-ff-muted">
          С регистрацията приемаш условията за ползване
        </p>
      </form>

      <div className="mt-4 text-center text-[13.5px] text-ff-ink-2">
        Вече имаш акаунт?{' '}
        <Link href="/login" className="font-bold text-ff-green-700 no-underline">
          Влез
        </Link>
      </div>
    </AuthShell>
  );
}
