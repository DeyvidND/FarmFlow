'use client';

/**
 * Delivery settings → SMS напомняне в деня на доставка. When on, the platform
 * SMSes each own-delivery customer their approved time window on the morning of
 * delivery (server cron). Off by default — SMS-ите се таксуват. Self-contained
 * (own load/save cycle via GET/PATCH tenants/me), independent of the surrounding
 * delivery-config save flow — mirrors nav-visibility-card.tsx.
 */
import * as React from 'react';
import { MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SaveBar } from '@/components/panels/panel-ui';
import { ApiError, getTenant, updateTenant } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function SmsReminderCard() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [on, setOn] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    getTenant()
      .then((t) => {
        if (!active) return;
        const v = !!t.sms?.dayOfReminder;
        setSaved(v);
        setOn(v);
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const dirty = on !== saved;

  const save = async () => {
    setSaving(true);
    try {
      await updateTenant({ sms: { dayOfReminder: on } });
      setSaved(on);
      toast.success('Настройката е запазена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <section className={cn('rounded-xl border border-ff-border bg-ff-surface-2', dirty && 'mb-16')}>
      <div className="flex items-center gap-3 px-[15px] py-3.5">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border-2 bg-ff-surface text-ff-muted">
          <MessageSquare size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-extrabold text-ff-ink">
            SMS напомняне в деня на доставка
          </div>
          <div className="mt-0.5 max-w-[560px] text-[12.5px] leading-snug text-ff-muted">
            Клиентът получава SMS сутринта с часовия диапазон за доставка. Изисква одобрени
            часове предната вечер. SMS-ите се таксуват.
          </div>
        </div>
        <ToggleSwitch checked={on} onChange={setOn} />
      </div>

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => setOn(saved)} />}
    </section>
  );
}
