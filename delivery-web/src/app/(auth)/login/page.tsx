'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Truck, AlertTriangle } from 'lucide-react';

const PANEL_URL = process.env.NEXT_PUBLIC_PANEL_URL ?? 'https://app.fermeribg.com';

// Login only — delivery accounts are provisioned by the super-admin
// (platform „Доставка"), there is no self-service registration.
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Landed here after a failed SSO handoff from the farmer panel (expired link,
  // or the tenant's „Доставки" package isn't active) — most farmers never got
  // delivery-web credentials at all, so a bare email/password form with no
  // explanation is a dead end. Show the API's actual reason and a way back.
  const handoffFailed = params.get('reason') === 'handoff';
  const handoffMsg = params.get('msg');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await fetch('/api/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.message || 'Грешка');
      }
      router.push('/import');
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Грешка');
    } finally {
      setBusy(false);
    }
  }

  const input =
    'h-11 w-full rounded-xl border border-ff-border bg-ff-bg px-3.5 text-[15px] outline-none focus:border-ff-green-500';

  return (
    <div className="grid min-h-screen place-items-center bg-ff-bg px-4">
      <div className="w-[420px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-7 shadow-ff-lg">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-[12px] bg-ff-green-700 text-[#EAF1E4]">
            <Truck size={24} strokeWidth={1.9} />
          </div>
          <div>
            <div className="font-display text-[19px] font-extrabold">ФермериБГ · Доставка</div>
            <div className="text-[12.5px] text-ff-muted">Вход в системата</div>
          </div>
        </div>

        {handoffFailed && (
          <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-ff-amber-600/30 bg-ff-amber-softer px-3.5 py-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-ff-amber-600" />
            <div className="text-[13.5px] leading-relaxed text-ff-ink-2">
              <p className="font-bold text-ff-amber-600">Връзката от панела не проработи</p>
              <p className="mt-0.5">
                {handoffMsg ?? 'Опитай пак от „Доставки" в панела — линкът важи само за кратко.'}
              </p>
              <a href={PANEL_URL} className="mt-2 inline-block font-bold text-ff-green-700 underline underline-offset-2">
                Върни се в панела →
              </a>
            </div>
          </div>
        )}

        <form onSubmit={submit} className="flex flex-col gap-3">
          <input className={input} type="email" placeholder="Имейл" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          <input className={input} type="password" placeholder="Парола" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}
          <button type="submit" disabled={busy} className="mt-1 h-11 rounded-xl bg-ff-green-700 text-[15px] font-bold text-white hover:brightness-95 disabled:opacity-60">
            {busy ? 'Моля изчакайте…' : 'Вход'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
