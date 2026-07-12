'use client';

import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, impersonateFarmer } from '@/lib/api-client';

/**
 * Super-admin „влез като фермер" — opens the farmer's „Доставки" app as them via a
 * short-TTL SSO link (server-minted, audit-logged). Hidden when the farmer has no
 * login to impersonate.
 */
export function ImpersonateButton({ farmerId, hasLogin }: { farmerId: string; hasLogin: boolean }) {
  const [busy, setBusy] = useState(false);
  if (!hasLogin) return null;

  async function go() {
    setBusy(true);
    try {
      const { url } = await impersonateFarmer(farmerId);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно влизане като фермер');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      title="Отваря приложението Доставки като този фермер — за поддръжка"
      className="inline-flex items-center gap-1.5 rounded-lg border border-ff-demo bg-ff-demo-soft px-3 py-1.5 text-[13px] font-bold text-ff-demo hover:brightness-95 disabled:opacity-60"
    >
      <LogIn size={14} /> {busy ? 'Отваряне…' : 'Влез като фермер'}
    </button>
  );
}
