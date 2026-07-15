'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, KeyRound, Check, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { firstMessage } from '@/components/auth/auth-shell';

/**
 * Blocking first-login modal that forces the farmer to replace the temporary
 * password the operator handed them. It explains *why* this matters (the temp
 * password travelled by email / by hand, so others may have seen it) and can't
 * be dismissed — there is no backdrop-close and no X. The server also enforces
 * `mustChangePassword` on every write (MustChangePasswordGuard), so this is the
 * UX half of a guarantee the API keeps anyway.
 *
 * On success it flips to a clear confirmation panel ("Готово!") instead of
 * silently redirecting — so the status visibly moves from "трябва да смениш" to
 * "сменена успешно" before the panel unlocks.
 */
const WHY = [
  'Само ти ще можеш да влизаш — човек с временната парола вече няма достъп.',
  'Пазиш поръчките, клиентите и данните на фермата си от чужди очи.',
  'Можеш да я сменяш пак по всяко време от „Настройки“.',
];

function PwField({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          placeholder="••••••••"
          autoComplete={autoComplete}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3.5 py-3 pr-11 text-[15px] text-ff-ink outline-none transition-colors placeholder:text-ff-muted-2 focus:border-ff-green-500"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? 'Скрий паролата' : 'Покажи паролата'}
          className="absolute right-2.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-ff-muted hover:text-ff-ink"
        >
          {show ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
    </label>
  );
}

export function ForcePasswordModal({ role = 'admin' }: { role?: string }) {
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

    if (next.length < 8) {
      setError('Новата парола трябва да е поне 8 символа.');
      return;
    }
    if (next === current) {
      setError('Новата парола трябва да е различна от временната.');
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
        setError(firstMessage(data?.message) ?? 'Грешна временна парола. Провери я и опитай пак.');
        return;
      }
      setDone(true);
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  function enterPanel() {
    // Re-run the server layout so the fresh token (mustChangePassword=false)
    // unmounts this modal. Farmer sub-accounts and driver logins have no
    // /dashboard access (FarmerRouteGuard/DriverRouteGuard bounce them back) —
    // land each directly on their own allowed screen.
    router.push(role === 'farmer' ? '/stats' : role === 'driver' ? '/route' : '/dashboard');
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]">
      <div className="animate-ff-pop max-h-[94vh] w-[460px] max-w-full overflow-y-auto rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
        {done ? (
          <div className="px-7 py-9 text-center">
            <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-ff-green-100 text-ff-green-700">
              <Check size={30} strokeWidth={2.6} />
            </span>
            <h2 className="font-display text-[21px] font-extrabold tracking-[-0.015em] text-ff-ink">
              Готово! Паролата е сменена.
            </h2>
            <p className="mx-auto mt-2 max-w-[330px] text-[14px] leading-relaxed text-ff-ink-2">
              Вече влизаш само със своята лична парола. Целият панел е отключен — можеш да започнеш
              работа.
            </p>
            <Button variant="primary" onClick={enterPanel} className="mt-6 w-full rounded-sm py-[13px] text-[15.5px]">
              Към таблото
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-3 border-b border-ff-border-2 px-7 pb-5 pt-6">
              <span className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
                <ShieldCheck size={23} />
              </span>
              <div>
                <div className="mb-0.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted">
                  Първа стъпка · защита на профила
                </div>
                <h2 className="font-display text-[20px] font-extrabold tracking-[-0.015em] text-ff-ink">
                  Смени временната парола
                </h2>
              </div>
            </div>

            <div className="px-7 pb-7 pt-5">
              <p className="text-[14px] leading-relaxed text-ff-ink-2">
                Влезе с <b>временна парола</b>, която ти даде администраторът. Тя пътува по имейл или
                се казва на ръка, затова е възможно да са я виждали и други хора. Преди да продължиш,
                задай своя лична парола, която знаеш <b>само ти</b>.
              </p>

              <div className="mt-4 rounded-xl border border-ff-green-100 bg-ff-green-50 p-4">
                <div className="mb-2.5 text-[12.5px] font-extrabold uppercase tracking-[0.03em] text-ff-green-800">
                  Защо е нужно
                </div>
                <div className="flex flex-col gap-2.5">
                  {WHY.map((t) => (
                    <div key={t} className="flex items-start gap-2.5">
                      <Check size={16} strokeWidth={2.6} className="mt-px shrink-0 text-ff-green-600" />
                      <span className="text-[13.5px] leading-relaxed text-ff-ink-2">{t}</span>
                    </div>
                  ))}
                </div>
              </div>

              <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-4">
                <PwField label="Временна парола" value={current} onChange={setCurrent} autoComplete="current-password" />
                <PwField label="Нова парола (поне 8 символа)" value={next} onChange={setNext} autoComplete="new-password" />
                <PwField label="Повтори новата парола" value={confirm} onChange={setConfirm} autoComplete="new-password" />

                {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

                <Button
                  variant="primary"
                  type="submit"
                  disabled={loading}
                  className="mt-0.5 w-full rounded-sm py-[13px] text-[15.5px]"
                >
                  <KeyRound size={17} /> {loading ? 'Запазване…' : 'Запази новата парола'}
                </Button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
