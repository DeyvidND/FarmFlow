'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, changePassword } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export default function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErr('');
    if (newPassword.length < 12) {
      setFieldErr('Новата парола трябва да е поне 12 символа.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setFieldErr('Паролите не съвпадат.');
      return;
    }
    setBusy(true);
    try {
      await changePassword({ currentPassword, newPassword });
      toast.success('Паролата е сменена успешно');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-6">
        <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Настройки</h1>
        <p className="mt-0.5 text-[13.5px] text-ff-muted">Управление на акаунта на платформения администратор</p>
      </div>

      <div className="max-w-[480px] rounded-xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-ff-green-50 text-ff-green-700">
            <KeyRound size={18} />
          </span>
          <h2 className="text-[16px] font-extrabold">Смяна на парола</h2>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ff-ink-2">Текуща парола</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ff-ink-2">Нова парола</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
              className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold text-ff-ink-2">Потвърди нова парола</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="h-10 rounded-xl border border-ff-border bg-ff-bg px-3 text-[14px] outline-none focus:border-ff-green-500"
            />
          </label>
          {fieldErr && <p className="text-[13px] text-ff-red">{fieldErr}</p>}
          <div className="mt-1 flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-ff-green-700 px-5 py-2.5 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60"
            >
              {busy ? 'Запис…' : 'Смени паролата'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
