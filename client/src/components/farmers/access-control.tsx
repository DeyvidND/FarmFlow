'use client';

import { useState } from 'react';
import { KeyRound, Check, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, grantFarmerAccess, revokeFarmerAccess } from '@/lib/api-client';
import type { FarmerAccess } from '@/lib/types';

/** Per-producer login provisioning: invite by email, resend, or revoke. */
export function AccessControl({ farmerId, initial }: { farmerId: string; initial?: FarmerAccess }) {
  const [access, setAccess] = useState<FarmerAccess | undefined>(initial);
  const [email, setEmail] = useState(initial?.loginEmail ?? '');
  const [busy, setBusy] = useState(false);

  async function invite() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await grantFarmerAccess(farmerId, email.trim());
      setAccess(res);
      toast.success('Поканата е изпратена');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await revokeFarmerAccess(farmerId);
      setAccess(undefined);
      toast.success('Достъпът е премахнат');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-ff-border-2 px-[18px] pb-4 pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
        <KeyRound size={14} /> Личен достъп
      </div>
      {access ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-ff-ink-2">
            {access.invitePending ? (
              <><Send size={13} className="text-ff-amber-600" /> Поканен · {access.loginEmail}</>
            ) : (
              <><Check size={13} className="text-ff-green-700" /> Активен · {access.loginEmail}</>
            )}
          </span>
          <div className="flex items-center gap-2">
            {access.invitePending && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={invite}>
                Изпрати отново
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={revoke} title="Откажи достъп">
              <X size={14} /> Откажи
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="имейл на фермера"
            className="min-w-[160px] flex-1 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm focus:outline-none focus:ring-2 focus:ring-ff-green-500/40"
          />
          <Button size="sm" variant="primary" disabled={busy || !email.trim()} onClick={invite}>
            <Send size={14} /> Покани
          </Button>
        </div>
      )}
    </div>
  );
}
