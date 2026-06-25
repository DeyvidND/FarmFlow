'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Truck, KeyRound, Check, Eye, EyeOff } from 'lucide-react';

// Invite-accept / set-password page. The super-admin sends a one-time invite
// link (dostavki.fermeribg.com/reset-password?token=<JWT>); the invitee sets a
// password here, then logs in. The API verifies the single-use token and returns
// only { ok: true } (no session) — so on success we send the user to /login.
function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [show, setShow] = useState(false);

  const metLength = next.length >= 12;
  const matches = confirm.length > 0 && next === confirm;
  const valid = metLength && next === confirm;

  const input =
    'h-11 w-full rounded-xl border border-ff-border bg-ff-bg pl-3.5 pr-11 text-[16px] outline-none focus:border-ff-green-500';
  const eyeBtn =
    'absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-ff-muted transition-colors hover:bg-ff-surface hover:text-ff-ink-2';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 12) {
      setError('Новата парола трябва да е поне 12 символа.');
      return;
    }
    if (next !== confirm) {
      setError('Двете пароли не съвпадат.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/session/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = (data as { message?: unknown })?.message;
        setError(typeof msg === 'string' ? msg : 'Връзката е невалидна или изтекла');
        return;
      }
      setDone(true);
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-ff-bg px-4">
      <div className="w-[420px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-7 shadow-ff-lg">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-[12px] bg-ff-green-700 text-[#EAF1E4]">
            <Truck size={24} strokeWidth={1.9} />
          </div>
          <div>
            <div className="font-display text-[19px] font-extrabold">ФермериБГ · Доставка</div>
            <div className="text-[12.5px] text-ff-muted">Задай парола</div>
          </div>
        </div>

        {!token ? (
          <div className="rounded-xl border border-ff-border bg-ff-bg p-4">
            <div className="text-[15px] font-bold text-ff-ink">Невалидна връзка</div>
            <p className="mt-1 text-[13.5px] leading-relaxed text-ff-ink-2">
              Връзката за достъп е непълна. Поискай нова покана от администратора.
            </p>
          </div>
        ) : done ? (
          <div className="text-center">
            <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-ff-green-50 text-ff-green-700">
              <Check size={30} strokeWidth={2.6} />
            </span>
            <h2 className="font-display text-[20px] font-extrabold tracking-[-0.015em] text-ff-ink">
              Готово — паролата е зададена
            </h2>
            <p className="mx-auto mt-2 max-w-[320px] text-[14px] leading-relaxed text-ff-ink-2">
              Вече можеш да влезеш в системата.
            </p>
            <button
              onClick={() => router.push('/login')}
              className="mt-6 h-11 w-full rounded-xl bg-ff-green-700 text-[15px] font-bold text-white hover:brightness-95"
            >
              Към вход
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="relative">
                <input
                  className={input}
                  type={show ? 'text' : 'password'}
                  placeholder="Нова парола"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                  autoComplete="new-password"
                  aria-describedby="pw-hint"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Скрий паролата' : 'Покажи паролата'}
                  aria-pressed={show}
                  className={eyeBtn}
                >
                  {show ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <p
                id="pw-hint"
                className={`flex items-center gap-1.5 px-0.5 text-[12.5px] ${
                  metLength ? 'text-ff-green-600' : 'text-ff-muted'
                }`}
              >
                {metLength ? (
                  <Check size={14} strokeWidth={3} className="shrink-0" />
                ) : (
                  <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-current opacity-50" />
                )}
                {metLength
                  ? 'Паролата е достатъчно дълга'
                  : next.length > 0
                    ? `Поне 12 символа (още ${12 - next.length})`
                    : 'Паролата трябва да е поне 12 символа'}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="relative">
                <input
                  className={input}
                  type={show ? 'text' : 'password'}
                  placeholder="Повтори новата парола"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Скрий паролата' : 'Покажи паролата'}
                  aria-pressed={show}
                  className={eyeBtn}
                >
                  {show ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {confirm.length > 0 && (
                <p
                  className={`flex items-center gap-1.5 px-0.5 text-[12.5px] ${
                    matches ? 'text-ff-green-600' : 'text-ff-red'
                  }`}
                >
                  {matches ? (
                    <Check size={14} strokeWidth={3} className="shrink-0" />
                  ) : (
                    <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-current opacity-50" />
                  )}
                  {matches ? 'Паролите съвпадат' : 'Паролите не съвпадат'}
                </p>
              )}
            </div>

            {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}
            <button
              type="submit"
              disabled={loading || !valid}
              className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 text-[15px] font-bold text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <KeyRound size={17} /> {loading ? 'Запазване…' : 'Запази паролата'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
