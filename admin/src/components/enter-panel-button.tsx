'use client';

import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, impersonateOwner } from '@/lib/api-client';

/**
 * Super-admin „влез в панела" — opens the farm's FULL farmer panel as its owner via a
 * short-TTL SSO link (server-minted, audit-logged). For support/onboarding help.
 */
export function EnterPanelButton({ tenantId }: { tenantId: string }) {
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const { url } = await impersonateOwner(tenantId);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно влизане в панела');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      title="Отваря истинския панел на фермера като него — за поддръжка"
      className="inline-flex items-center gap-1.5 rounded-lg border border-[#3457B1] bg-[#EEF4FF] px-3 py-1.5 text-[13px] font-bold text-[#3457B1] hover:brightness-95 disabled:opacity-60"
    >
      <LogIn size={14} /> {busy ? 'Отваряне…' : 'Влез в панела'}
    </button>
  );
}
