'use client';

import { useState } from 'react';
import { KeyRound, Check, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, grantFarmerAccess, revokeFarmerAccess } from '@/lib/api-client';
import type { FarmerAccess } from '@/lib/types';

/** Per-producer login status on the farmer card. Inviting (which needs the email)
 *  happens in the edit panel — there's only one email field — so here we just show
 *  status and the quick re-send / revoke actions; «Без достъп» opens the panel. */
export function AccessControl({
  farmerId,
  access,
  onOpenEdit,
  onAccessChange,
}: {
  farmerId: string;
  access?: FarmerAccess;
  /** Open the farmer edit panel (where the invite + email live). */
  onOpenEdit: () => void;
  onAccessChange: (farmerId: string, next: FarmerAccess | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function resend() {
    if (!access) return;
    setBusy(true);
    try {
      const res = await grantFarmerAccess(farmerId, access.loginEmail);
      onAccessChange(farmerId, res);
      toast.success('Поканата е изпратена отново');
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
      onAccessChange(farmerId, undefined);
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
              <Button size="sm" variant="ghost" disabled={busy} onClick={resend}>
                Изпрати отново
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={revoke} title="Откажи достъп">
              <X size={14} /> Откажи
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] text-ff-muted">Този фермер няма достъп до панела.</span>
          <Button size="sm" variant="ghost" onClick={onOpenEdit}>
            <Send size={14} /> Покани
          </Button>
        </div>
      )}
    </div>
  );
}
