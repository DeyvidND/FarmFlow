'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, getFarmerReadiness, grantFarmerAccess } from '@/lib/api-client';
import { sortReadiness, READINESS_MISSING_LABEL } from '@/lib/farmer-readiness';
import type { FarmerReadiness } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/**
 * «Готовност на фермерите» (spec §5.2) — read-only board on the Protocols screen:
 * per farmer, whether their legal identity + signature are complete enough to
 * print a filled-in handover protocol. NEVER blocks anything (§5.3) — this is
 * pure information, with a shortcut to the two paths that already exist
 * elsewhere: editing the farmer directly, or re-sending their self-service
 * invite (same `grantFarmerAccess` the Фермери screen already uses).
 */
export function FarmerReadinessBoard() {
  const [rows, setRows] = useState<FarmerReadiness[] | null>(null);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFarmerReadiness()
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => toast.error(errMsg(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows === null) return null; // loading — the rest of the Protocols screen isn't gated on this
  const incomplete = sortReadiness(rows).filter((r) => !r.ready);
  if (incomplete.length === 0) return null; // nothing to flag — don't take up space when everyone's ready

  async function invite(row: FarmerReadiness) {
    if (!row.email) return;
    setInvitingId(row.farmerId);
    try {
      await grantFarmerAccess(row.farmerId, row.email);
      toast.success(`Поканата е изпратена на ${row.name}`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setInvitingId(null);
    }
  }

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <div className="flex items-center gap-2 border-b border-ff-border-2 px-5 py-3.5">
        <AlertCircle size={18} className="text-ff-amber-600" />
        <h2 className="text-[15px] font-extrabold">Готовност на фермерите</h2>
        <span className="text-[12.5px] text-ff-muted">
          {incomplete.length} без пълни данни — протоколите им излизат с празни полета
        </span>
      </div>
      <div className="flex flex-col">
        {incomplete.map((row) => (
          <div
            key={row.farmerId}
            className="flex flex-wrap items-center justify-between gap-2.5 border-b border-ff-border-2 px-5 py-3 last:border-0"
          >
            <div>
              <div className="text-[14px] font-bold">{row.name}</div>
              <div className="text-[12.5px] text-ff-muted">
                {row.missing.map((m) => READINESS_MISSING_LABEL[m]).join(' · ')}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`/farmers?edit=${row.farmerId}`}
                className="inline-flex items-center rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-1.5 text-[12.5px] font-bold text-ff-ink-2"
              >
                Попълни вместо него
              </a>
              <Button
                variant="ghost"
                size="sm"
                disabled={!row.email || invitingId === row.farmerId}
                title={row.email ? undefined : 'Добави имейл на фермера, за да изпратиш покана'}
                onClick={() => void invite(row)}
              >
                <Send size={14} /> Прати покана
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
