'use client';

/**
 * Delivery settings → Напомняне в деня на доставка. When on, the platform
 * reminds each own-delivery customer of their approved time window on the
 * morning of delivery (server cron). Channel is email by default (free),
 * switchable to SMS via settings.sms.channel. Off by default.
 *
 * Single-boolean setting → AUTO-SAVES on toggle (no SaveBar): the toggle
 * optimistically flips, PATCHes tenants/me immediately, and reverts on error.
 * Deliberately avoids the shared fixed-position `SaveBar` — this card is mounted
 * inside the delivery-settings screen, which already renders its own page-level
 * save bar for its `cfg`, and two fixed bottom bars would overlap and hide each
 * other's controls. Auto-save also just reads better for a lone on/off flag.
 */
import * as React from 'react';
import { MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, getTenant, updateTenant } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function SmsReminderCard() {
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [on, setOn] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    getTenant()
      .then((t) => {
        if (!active) return;
        setOn(!!t.sms?.dayOfReminder);
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    const prev = on;
    setOn(next); // optimistic
    setBusy(true);
    try {
      await updateTenant({ sms: { dayOfReminder: next } });
      toast.success('Настройката е запазена');
    } catch (e) {
      setOn(prev); // revert on failure
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  return (
    <section className="rounded-xl border border-ff-border bg-ff-surface-2">
      <div className="flex items-center gap-3 px-[15px] py-3.5">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border-2 bg-ff-surface text-ff-muted">
          <MessageSquare size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-extrabold text-ff-ink">
            Напомняне в деня на доставка
          </div>
          <div className="mt-0.5 max-w-[560px] text-[12.5px] leading-snug text-ff-muted">
            Клиентът получава напомняне сутринта с часовия диапазон за доставка. Изисква
            одобрени часове предната вечер.
          </div>
        </div>
        <ToggleSwitch checked={on} onChange={toggle} disabled={busy} />
      </div>
    </section>
  );
}
