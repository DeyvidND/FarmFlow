'use client';

import * as React from 'react';
import { ExternalLink, Truck, Info, CheckCircle2, AlertCircle, ShieldCheck, BookOpen, Upload, ChevronDown, Plug } from 'lucide-react';
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

/** Plain-language walkthrough of the courier flow, shown to the farmer on the
 *  „Доставки“ page so the two apps (panel + dostavki) read as one. */
const FLOW_STEPS: ReadonlyArray<{ title: string; desc: string }> = [
  {
    title: 'Свържи куриер',
    desc: 'Въведи акаунта си в Еконт или Speedy по-долу. Прави се само веднъж.',
  },
  {
    title: 'Клиентът избира „Куриер“',
    desc: 'При поръчка от магазина ти системата сама подготвя чернова на пратка — с адреса и наложения платеж.',
  },
  {
    title: 'Отвори „Доставки“',
    desc: 'Поръчките те чакат като готови чернови. Избираш куриер — Еконт или Speedy — и създаваш товарителницата с един клик.',
  },
  {
    title: 'Предай по твой избор',
    desc: 'Или принтираш товарителницата и сам я носиш до офис, или маркираш пратките и заявяваш куриер да мине и да ги вземе. Наложеният платеж се връща при теб.',
  },
];

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

/** One numbered step inside a „Откъде да взема тези данни?“ helper. */
function Stp({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-ff-green-100 text-[10.5px] font-extrabold text-ff-green-700">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

/** Collapsible „where do I get these credentials?“ guide under a connect card —
 *  plain, farmer-friendly steps, hidden by default so the card stays simple. */
function CredHelp({ children }: { children: React.ReactNode }) {
  return (
    <details className="group mb-3 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[12.5px] font-bold text-ff-ink-2 [&::-webkit-details-marker]:hidden">
        Откъде да взема тези данни?
        <ChevronDown size={15} className="shrink-0 text-ff-muted transition-transform group-open:rotate-180" />
      </summary>
      <ol className="mt-2 flex flex-col gap-1.5 text-[12.5px] leading-snug text-ff-ink-2">
        {children}
      </ol>
    </details>
  );
}

export function FarmerDeliveryClient() {
  // ── SSO handoff ──────────────────────────────────────────────────────────
  const [handoffBusy, setHandoffBusy] = React.useState(false);

  // One-click SSO into dostavki, landing on a specific page — same login, no
  // second sign-in. `next` is allowlisted server-side in dostavki, so an unknown
  // value just falls back to the role default.
  const handoffTo = async (next: string) => {
    setHandoffBusy(true);
    try {
      const { token } = await requestDeliveryHandoff();
      const base =
        process.env.NEXT_PUBLIC_DELIVERY_URL ?? 'https://dostavki.fermeribg.com';
      window.open(
        `${base}/api/session/handoff?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`,
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

  // A connected carrier whose seeded sender has no phone → finalize (Еконт) rejects
  // the label. Warn and point the farmer at dostavki → Настройки to fix the sender.
  const [econtSenderMissing, setEcontSenderMissing] = React.useState(false);
  const [speedySenderMissing, setSpeedySenderMissing] = React.useState(false);

  // ── On mount: fetch both configs ─────────────────────────────────────────
  React.useEffect(() => {
    getFarmerEcontConfig()
      .then((cfg) => {
        setEcontConfigured(cfg.configured ?? false);
        setEcontSenderMissing(Boolean(cfg.configured) && !cfg.sender?.phone);
      })
      .catch(() => setEcontConfigured(false));
    getFarmerSpeedyConfig()
      .then((cfg) => {
        setSpeedyConfigured(cfg.configured ?? false);
        setSpeedySenderMissing(Boolean(cfg.configured) && !cfg.sender?.phone);
      })
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
      setEcontSenderMissing(Boolean(cfg.configured ?? true) && !cfg.sender?.phone);
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
      setSpeedySenderMissing(Boolean(cfg.configured ?? true) && !cfg.sender?.phone);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSpeedySaving(false);
    }
  };

  // Readiness drives the next-step hint: until a carrier is connected the farmer
  // can't ship, so we point them at the connect cards instead of the empty app.
  const statusLoading = econtConfigured === undefined || speedyConfigured === undefined;
  const anyConnected = Boolean(econtConfigured) || Boolean(speedyConfigured);
  const senderPhoneMissing = econtSenderMissing || speedySenderMissing;

  // Until a carrier is connected the dostavki app is empty, so the primary action
  // is „connect a carrier" (scroll to the cards below), not „open the app".
  const carriersRef = React.useRef<HTMLDivElement>(null);
  const scrollToCarriers = () => carriersRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="animate-ff-fade-up flex flex-col gap-4">
      {/* Page heading */}
      <div className="mb-1">
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">
          Доставки
        </h1>
        <p className="mt-0.5 text-[14px] text-ff-ink-2">
          Свържи куриер веднъж и пращай поръчките си с няколко клика. Управлението на пратките е в приложението „Доставки“.
        </p>
      </div>

      {/* How-it-works + one-click handoff to the dostavki app */}
      <div className="rounded-[14px] border border-ff-green-100 bg-ff-green-50 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-green-100 text-ff-green-700">
            <Truck size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-extrabold text-ff-ink">Как работят доставките</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ff-ink-2">
              <ConfigBadge configured={econtConfigured} />
              <span className="text-ff-muted-2">Еконт</span>
              <span className="mx-1 text-ff-muted-2">·</span>
              <ConfigBadge configured={speedyConfigured} />
              <span className="text-ff-muted-2">Speedy</span>
            </div>
          </div>
          {anyConnected ? (
            <Button variant="primary" size="sm" onClick={() => handoffTo('/shipments')} disabled={handoffBusy}>
              <ExternalLink size={15} /> {handoffBusy ? 'Отваряне…' : 'Отвори Доставки'}
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={scrollToCarriers} disabled={statusLoading}>
              <Plug size={15} /> Свържи куриер
            </Button>
          )}
        </div>

        {/* Next-step hint — keyed to whether a carrier is connected yet */}
        {!statusLoading && (
          anyConnected ? (
            <div className="mt-4 flex items-center gap-2 rounded-[10px] border border-ff-green-100 bg-ff-surface px-3 py-2 text-[12.5px] font-bold text-ff-green-700">
              <CheckCircle2 size={15} className="shrink-0" />
              Готов си — поръчките с куриер ще те чакат в „Доставки“, готови за изпращане.
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-2 rounded-[10px] border border-[#e7c9a0] bg-ff-amber-softer px-3 py-2 text-[12.5px] font-bold text-ff-amber-600">
              <AlertCircle size={15} className="shrink-0" />
              Още няма свързан куриер. Свържи Еконт или Speedy по-долу, за да започнеш.
            </div>
          )
        )}

        {/* Seeded sender has no phone → Еконт rejects the label. Nudge to fix it first. */}
        {senderPhoneMissing && (
          <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-[#e7c9a0] bg-ff-amber-softer px-3 py-2 text-[12.5px] text-ff-amber-600">
            <AlertCircle size={15} className="mt-px shrink-0" />
            <span>
              Подателят няма телефон. Добави го в{' '}
              <button
                type="button"
                onClick={() => handoffTo('/settings')}
                disabled={handoffBusy}
                className="font-bold underline hover:no-underline disabled:opacity-60"
              >
                Доставки → Настройки
              </button>{' '}
              преди първата товарителница — иначе Еконт я отказва.
            </span>
          </div>
        )}

        <ol className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {FLOW_STEPS.map((s, i) => (
            <li
              key={s.title}
              className="flex items-start gap-3 rounded-[12px] border border-ff-green-100 bg-ff-surface px-3.5 py-3"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[12.5px] font-extrabold text-white">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="text-[13.5px] font-bold text-ff-ink">{s.title}</div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-ff-ink-2">{s.desc}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-3.5 flex flex-col gap-1.5 text-[12px] text-ff-ink-2">
          <div className="flex items-start gap-1.5">
            <ShieldCheck size={13} className="mt-px shrink-0 text-ff-green-700" />
            Плащаш само цената на куриера — без такса от платформата. Истинска товарителница се създава чак щом потвърдиш пратката.
          </div>
          <div className="flex items-start gap-1.5">
            <Info size={13} className="mt-px shrink-0 text-ff-green-700" />
            Влизаш със същия акаунт — не е нужно второ влизане.
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {anyConnected && (
            <button
              type="button"
              onClick={() => handoffTo('/import')}
              disabled={handoffBusy}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-ff-green-700 hover:underline disabled:opacity-60"
            >
              <Upload size={14} /> Внеси пратки от Excel
            </button>
          )}
          <button
            type="button"
            onClick={() => handoffTo('/help')}
            disabled={handoffBusy}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-ff-green-700 hover:underline disabled:opacity-60"
          >
            <BookOpen size={14} /> Пълно ръководство
          </button>
        </div>
      </div>

      {/* Carrier connect cards */}
      <div ref={carriersRef} className="flex scroll-mt-4 flex-col gap-4">
        {/* Econt */}
        <div className="rounded-[14px] border border-ff-border bg-ff-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[15px] font-extrabold text-ff-ink">Еконт</div>
              <div className="mt-0.5 text-[12.5px] text-ff-ink-2">
                Същите данни като в e-Econt профила ти (бизнес клиент).
              </div>
            </div>
            <ConfigBadge configured={econtConfigured} />
          </div>

          <CredHelp>
            <Stp n={1}>Нужен е фирмен акаунт в Еконт — за товарителници и наложен платеж.</Stp>
            <Stp n={2}>
              Влез в профила си на{' '}
              <a href="https://econt.com" target="_blank" rel="noopener noreferrer" className="font-bold text-ff-green-700 hover:underline">econt.com</a>
              {' '}— там са твоят потребител и парола. Или кажи в офис на Еконт: „искам да издавам товарителници от моята система“.
            </Stp>
            <Stp n={3}>Въведи ги тук веднъж — готово.</Stp>
          </CredHelp>

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
                Нужен е API потребител от Speedy — различен от логина в сайта.
              </div>
            </div>
            <ConfigBadge configured={speedyConfigured} />
          </div>

          <CredHelp>
            <Stp n={1}>Поискай <b>API достъп</b> от Speedy — не става автоматично.</Stp>
            <Stp n={2}>
              Пиши на{' '}
              <a href="mailto:api.registration@speedy.bg" className="font-bold text-ff-green-700 hover:underline">api.registration@speedy.bg</a>
              {' '}(или кажи на търговеца си от Speedy). Дай име, фирма и телефон.
            </Stp>
            <Stp n={3}>Speedy ти праща потребител и парола за API — въведи ги тук.</Stp>
          </CredHelp>

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
