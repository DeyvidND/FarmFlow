'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthShell, AuthField, firstMessage } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/session/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(firstMessage(data?.message) ?? 'Възникна грешка. Опитай отново.');
        return;
      }
      setSent(true);
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell footer="FarmFlow © 2026">
      {sent ? (
        <>
          <h1 className="mb-1 text-[20px] font-extrabold">Провери пощата си</h1>
          <p className="mb-[22px] text-[13.5px] leading-relaxed text-ff-muted">
            Ако <b>{email}</b> има профил във FarmFlow, изпратихме връзка за смяна на паролата.
            Връзката е валидна 30 минути. Виж и в папка „Спам“.
          </p>
          <Link
            href="/login"
            className="text-[13.5px] font-semibold text-ff-green-700 no-underline"
          >
            ← Обратно към вход
          </Link>
        </>
      ) : (
        <>
          <h1 className="mb-1 text-[20px] font-extrabold">Забравена парола</h1>
          <p className="mb-[22px] text-[13.5px] text-ff-muted">
            Въведи имейла си и ще ти изпратим връзка, с която да зададеш нова парола.
          </p>

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

            {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

            <Button
              variant="primary"
              type="submit"
              disabled={loading}
              className="mt-0.5 w-full rounded-sm py-[13px] text-[15.5px]"
            >
              {loading ? 'Изпращане…' : 'Изпрати връзка'}
            </Button>
          </form>

          <div className="mt-5 text-center">
            <Link href="/login" className="text-[12.5px] font-semibold text-ff-green-700 no-underline">
              ← Обратно към вход
            </Link>
          </div>
        </>
      )}
    </AuthShell>
  );
}
