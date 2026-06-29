'use client';

import * as React from 'react';
import { ExternalLink, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  requestDeliveryHandoff,
  getFarmerEcontConfig,
  saveFarmerEcontCredentials,
  getFarmerSpeedyConfig,
  saveFarmerSpeedyCredentials,
} from '@/lib/api-client';

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function ConfigBadge({ configured }: { configured: boolean | undefined }) {
  if (configured === undefined) {
    return (
      <span className="inline-flex items-center rounded-full bg-ff-surface-2 px-2.5 py-0.5 text-[12px] font-semibold text-ff-muted">
        Зарежда…
      </span>
    );
  }
  return configured ? (
    <span className="inline-flex items-center rounded-full bg-ff-green-50 px-2.5 py-0.5 text-[12px] font-bold text-ff-green-700">
      Свързан ✓
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-ff-surface-2 px-2.5 py-0.5 text-[12px] font-semibold text-ff-muted-2">
      Не е свързан
    </span>
  );
}

export function FarmerDeliveryClient() {
  // ── SSO handoff ──────────────────────────────────────────────────────────
  const [handoffBusy, setHandoffBusy] = React.useState(false);

  const openDostavki = async () => {
    setHandoffBusy(true);
    try {
      const { token } = await requestDeliveryHandoff();
      const base =
        process.env.NEXT_PUBLIC_DELIVERY_URL ?? 'https://dostavki.fermeribg.com';
      window.open(
        `${base}/api/session/handoff?token=${encodeURIComponent(token)}`,
        '_blank',
        'noopener',
      );
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setHandoffBusy(false);
    }
  };

  // ── Econt state ──────────────────────────────────────────────────────────
  const [econtConfigured, setEcontConfigured] = React.useState<boolean | undefined>(undefined);
  const [econtUsername, setEcontUsername] = React.useState('');
  const [econtPassword, setEcontPassword] = React.useState('');
  const [econtSaving, setEcontSaving] = React.useState(false);

  // ── Speedy state ─────────────────────────────────────────────────────────
  const [speedyConfigured, setSpeedyConfigured] = React.useState<boolean | undefined>(undefined);
  const [speedyUserName, setSpeedyUserName] = React.useState('');
  const [speedyPassword, setSpeedyPassword] = React.useState('');
  const [speedySaving, setSpeedySaving] = React.useState(false);

  // ── On mount: fetch both configs ─────────────────────────────────────────
  React.useEffect(() => {
    getFarmerEcontConfig()
      .then((cfg) => setEcontConfigured(cfg.configured ?? false))
      .catch(() => setEcontConfigured(false));
    getFarmerSpeedyConfig()
      .then((cfg) => setSpeedyConfigured(cfg.configured ?? false))
      .catch(() => setSpeedyConfigured(false));
  }, []);

  // ── Econt connect ────────────────────────────────────────────────────────
  const connectEcont = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!econtUsername.trim() || !econtPassword) return;
    setEcontSaving(true);
    try {
      await saveFarmerEcontCredentials({ username: econtUsername.trim(), password: econtPassword });
      toast.success('Еконт е свързан успешно');
      setEcontPassword('');
      // Re-fetch to confirm
      const cfg = await getFarmerEcontConfig();
      setEcontConfigured(cfg.configured ?? true);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setEcontSaving(false);
    }
  };

  // ── Speedy connect ───────────────────────────────────────────────────────
  const connectSpeedy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!speedyUserName.trim() || !speedyPassword) return;
    setSpeedySaving(true);
    try {
      await saveFarmerSpeedyCredentials({ userName: speedyUserName.trim(), password: speedyPassword });
      toast.success('Speedy е свързан успешно');
      setSpeedyPassword('');
      const cfg = await getFarmerSpeedyConfig();
      setSpeedyConfigured(cfg.configured ?? true);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSpeedySaving(false);
    }
  };

  return (
    <div className="animate-ff-fade-up flex flex-col gap-4">
      {/* Page heading */}
      <div className="mb-1">
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">
          Доставки
        </h1>
        <p className="mt-0.5 text-[14px] text-ff-ink-2">
          Свържи куриерски акаунти и управлявай пратките си в приложението за доставки.
        </p>
      </div>

      {/* SSO handoff card */}
      <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-ff-green-100 bg-ff-green-50 px-4 py-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-green-100 text-ff-green-700">
          <Truck size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-extrabold text-ff-ink">Пратки и куриери</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ff-ink-2">
            <ConfigBadge configured={econtConfigured} />
            <span className="text-ff-muted-2">Еконт</span>
            <span className="mx-1 text-ff-muted-2">·</span>
            <ConfigBadge configured={speedyConfigured} />
            <span className="text-ff-muted-2">Speedy</span>
          </div>
        </div>
        <Button variant="primary" size="sm" onClick={openDostavki} disabled={handoffBusy}>
          <ExternalLink size={15} /> {handoffBusy ? 'Отваряне…' : 'Отвори Доставки'}
        </Button>
      </div>

      {/* Carrier connect cards */}
      <div className="flex flex-col gap-4">
        {/* Econt */}
        <div className="rounded-[14px] border border-ff-border bg-ff-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[15px] font-extrabold text-ff-ink">Еконт</div>
              <div className="mt-0.5 text-[12.5px] text-ff-ink-2">
                Въведи потребителско име и парола от акаунта си в Еконт.
              </div>
            </div>
            <ConfigBadge configured={econtConfigured} />
          </div>
          <form onSubmit={connectEcont} className="flex flex-col gap-3">
            <label className={labelCls}>
              Потребителско име
              <input
                className={field}
                type="text"
                autoComplete="username"
                placeholder="ivanov@example.com"
                value={econtUsername}
                onChange={(ev) => setEcontUsername(ev.target.value)}
              />
            </label>
            <label className={labelCls}>
              Парола
              <input
                className={field}
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={econtPassword}
                onChange={(ev) => setEcontPassword(ev.target.value)}
              />
            </label>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={econtSaving || !econtUsername.trim() || !econtPassword}
              >
                {econtSaving ? 'Свързване…' : econtConfigured ? 'Обнови данните' : 'Свържи Еконт'}
              </Button>
            </div>
          </form>
        </div>

        {/* Speedy */}
        <div className="rounded-[14px] border border-ff-border bg-ff-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[15px] font-extrabold text-ff-ink">Speedy</div>
              <div className="mt-0.5 text-[12.5px] text-ff-ink-2">
                Въведи потребителско име и парола от акаунта си в Speedy.
              </div>
            </div>
            <ConfigBadge configured={speedyConfigured} />
          </div>
          <form onSubmit={connectSpeedy} className="flex flex-col gap-3">
            <label className={labelCls}>
              Потребителско име
              <input
                className={field}
                type="text"
                autoComplete="username"
                placeholder="ivanov@example.com"
                value={speedyUserName}
                onChange={(ev) => setSpeedyUserName(ev.target.value)}
              />
            </label>
            <label className={labelCls}>
              Парола
              <input
                className={field}
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={speedyPassword}
                onChange={(ev) => setSpeedyPassword(ev.target.value)}
              />
            </label>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={speedySaving || !speedyUserName.trim() || !speedyPassword}
              >
                {speedySaving ? 'Свързване…' : speedyConfigured ? 'Обнови данните' : 'Свържи Speedy'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
