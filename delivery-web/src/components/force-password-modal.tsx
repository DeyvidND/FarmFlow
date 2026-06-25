'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, KeyRound, Check } from 'lucide-react';

/**
 * Blocking first-login screen. Delivery accounts are provisioned by the
 * super-admin with `mustChangePassword=true` (e.g. after a password reset); the
 * econt API locks every endpoint except change-password until it's rotated —
 * this is the UX half of that. It can't be dismissed (no backdrop close, no X).
 */
const WHY = [
  'Паролата ти е зададена от администратора — смени я с твоя собствена.',
  'През този профил създаваш пратки и виждаш наложените платежи — пази достъпа.',
  'Можеш да я сменяш пак по всяко време.',
];

export function ForcePasswordModal() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 12) {
      setError('Новата парола трябва да е поне 12 символа.');
      return;
    }
    if (next === current) {
      setError('Новата парола трябва да е различна от текущата.');
      return;
    }
    if (next !== confirm) {
      setError('Двете нови пароли не съвпадат.');
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
        const msg = (data as { message?: unknown })?.message;
        setError(typeof msg === 'string' ? msg : 'Грешна текуща парола. Опитай пак.');
        return;
      }
      setDone(true);
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  function enter() {
    router.push('/import');
    router.refresh();
  }

  const inputCls =
    'h-10 w-full rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500';

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]">
      <div className="max-h-[94vh] w-[460px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
        {done ? (
          <div className="px-7 py-9 text-center">
            <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-ff-green-50 text-ff-green-700">
              <Check size={30} strokeWidth={2.6} />
            </span>
            <h2 className="font-display text-[21px] font-extrabold tracking-[-0.015em] text-ff-ink">
              Готово! Паролата е сменена.
            </h2>
            <p className="mx-auto mt-2 max-w-[330px] text-[14px] leading-relaxed text-ff-ink-2">
              Системата е отключена.
            </p>
            <button
              onClick={enter}
              className="mt-6 w-full rounded-xl bg-ff-green-700 px-5 py-3 text-[15px] font-bold text-white hover:brightness-95"
            >
              Към пратките
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-3 border-b border-ff-border px-7 pb-5 pt-6">
              <span className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-xl bg-ff-green-50 text-ff-green-700">
                <ShieldCheck size={23} />
              </span>
              <div>
                <div className="mb-0.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">
                  Първа стъпка · защита на профила
                </div>
                <h2 className="font-display text-[20px] font-extrabold tracking-[-0.015em] text-ff-ink">
                  Смени началната парола
                </h2>
              </div>
            </div>

            <div className="px-7 pb-7 pt-5">
              <div className="mb-4 rounded-xl border border-ff-green-100 bg-ff-green-50 p-4">
                <div className="flex flex-col gap-2.5">
                  {WHY.map((t) => (
                    <div key={t} className="flex items-start gap-2.5">
                      <Check size={16} strokeWidth={2.6} className="mt-px shrink-0 text-ff-green-600" />
                      <span className="text-[13.5px] leading-relaxed text-ff-ink-2">{t}</span>
                    </div>
                  ))}
                </div>
              </div>

              <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-bold text-ff-ink-2">Текуща парола</span>
                  <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-bold text-ff-ink-2">Нова парола (поне 12 символа)</span>
                  <input type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-bold text-ff-ink-2">Повтори новата парола</span>
                  <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} />
                </label>

                {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

                <button
                  type="submit"
                  disabled={loading}
                  className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-5 py-3 text-[15px] font-bold text-white hover:brightness-95 disabled:opacity-60"
                >
                  <KeyRound size={17} /> {loading ? 'Запазване…' : 'Запази новата парола'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
