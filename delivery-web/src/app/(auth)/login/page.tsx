'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Leaf } from 'lucide-react';

type Mode = 'login' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [farmName, setFarmName] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/session/login' : '/api/session/signup';
      const payload =
        mode === 'login'
          ? { email: email.trim(), password }
          : { email: email.trim(), password, farmName: farmName.trim(), phone: phone.trim() };
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
            <Leaf size={24} strokeWidth={1.9} />
          </div>
          <div>
            <div className="font-display text-[19px] font-extrabold">ФермериБГ · Доставка</div>
            <div className="text-[12.5px] text-ff-muted">{mode === 'login' ? 'Вход в системата' : 'Нова регистрация'}</div>
          </div>
        </div>

        <div className="mb-4 flex gap-1 rounded-xl bg-ff-surface-2 p-1">
          <button type="button" onClick={() => setMode('login')} className={tabCls(mode === 'login')}>Вход</button>
          <button type="button" onClick={() => setMode('signup')} className={tabCls(mode === 'signup')}>Регистрация</button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === 'signup' && (
            <input className={input} placeholder="Име на фирмата / фермата" value={farmName} onChange={(e) => setFarmName(e.target.value)} required minLength={2} />
          )}
          <input className={input} type="email" placeholder="Имейл" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          <input className={input} type="password" placeholder="Парола" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'signup' ? 12 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {mode === 'signup' && (
            <input className={input} type="tel" placeholder="Телефон (по избор)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          )}
          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}
          <button type="submit" disabled={busy} className="mt-1 h-11 rounded-xl bg-ff-green-700 text-[15px] font-bold text-white hover:brightness-95 disabled:opacity-60">
            {busy ? 'Моля изчакайте…' : mode === 'login' ? 'Вход' : 'Създай акаунт'}
          </button>
          {mode === 'signup' && <p className="text-[12px] text-ff-muted">Паролата трябва да е поне 12 знака.</p>}
        </form>
      </div>
    </div>
  );
}

function tabCls(active: boolean) {
  return `flex-1 rounded-lg px-3 py-2 text-[13.5px] font-bold transition-colors ${active ? 'bg-ff-surface text-ff-ink shadow-ff-sm' : 'text-ff-muted hover:text-ff-ink-2'}`;
}
