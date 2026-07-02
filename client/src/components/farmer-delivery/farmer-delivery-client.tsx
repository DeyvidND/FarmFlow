'use client';

import * as React from 'react';
import { ExternalLink, Truck, Info, CheckCircle2, AlertCircle, ShieldCheck, BookOpen, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  requestDeliveryHandoff,
  getFarmerEcontConfig,
  getFarmerSpeedyConfig,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** Plain-language walkthrough of the courier flow, shown to the farmer on the
 *  „Доставки“ page so the two apps (panel + dostavki) read as one. */
const FLOW_STEPS: ReadonlyArray<{ title: string; desc: string }> = [
  {
    title: 'Свържи куриер',
    desc: 'Свързването на Еконт или Speedy става в приложението „Доставки“. Прави се само веднъж.',
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

  // ── Read-only carrier status ─────────────────────────────────────────────
  const [econtConfigured, setEcontConfigured] = React.useState<boolean | undefined>(undefined);
  const [speedyConfigured, setSpeedyConfigured] = React.useState<boolean | undefined>(undefined);

  // A connected carrier whose seeded sender has no phone → finalize (Еконт) rejects
  // the label. Warn and point the farmer at dostavki → Настройки to fix the sender.
  const [econtSenderMissing, setEcontSenderMissing] = React.useState(false);
  const [speedySenderMissing, setSpeedySenderMissing] = React.useState(false);

  // ── On mount: fetch both configs (read-only status) ──────────────────────
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

  // Readiness drives the next-step hint: until a carrier is connected the farmer
  // can't ship, so we point them at dostavki instead of the empty app.
  const statusLoading = econtConfigured === undefined || speedyConfigured === undefined;
  const anyConnected = Boolean(econtConfigured) || Boolean(speedyConfigured);
  const senderPhoneMissing = econtSenderMissing || speedySenderMissing;

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

      {/* Honest disclosure: the courier pipeline is fully built, but chaika
          checkout still locks it to local-only delivery — so connecting a
          carrier here doesn't yet produce customer orders. Without this line
          a farmer has no way to know why „Доставки" stays empty. */}
      <div className="flex items-start gap-2.5 rounded-[14px] border border-[#e7c9a0] bg-ff-amber-softer px-4 py-3 text-[12.5px] text-ff-amber-600">
        <AlertCircle size={16} className="mt-px shrink-0" />
        <span>Куриерска доставка е готова, но още не е активна за клиенти в магазина.</span>
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
            <Button variant="primary" size="sm" onClick={() => handoffTo('/settings')} disabled={statusLoading || handoffBusy}>
              <ExternalLink size={15} /> {handoffBusy ? 'Отваряне…' : 'Свържи куриер в Доставки'}
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
              Още няма свързан куриер. Свържи Еконт или Speedy в приложението „Доставки“, за да започнеш.
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

      {/* Carrier connection now lives entirely in dostavki — this is a
          read-only note + handoff, not a form. Scope note preserved: this
          connects a carrier for THIS producer's own products only, distinct
          from any shop-wide carrier the owner connected inside „Доставки"
          itself. Without this line a farmer can't tell why there are two
          places that both look like "connect Econt". */}
      <div className="rounded-[14px] border border-ff-border bg-ff-surface p-5">
        <div className="text-[15px] font-extrabold text-ff-ink">Свързване на куриер</div>
        <p className="mt-1.5 text-[12.5px] leading-snug text-ff-ink-2">
          Свързването на Еконт или Speedy — потребител, парола и подател — става изцяло в приложението „Доставки“.
          Свържи веднъж там и поръчките за твоите продукти ще минават през твоя акаунт. Това е отделно от общия
          куриерски акаунт на магазина — ако вече има такъв, той не важи за твоите продукти.
        </p>
        <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button variant="primary" size="sm" onClick={() => handoffTo('/settings')} disabled={handoffBusy}>
            <ExternalLink size={15} /> {handoffBusy ? 'Отваряне…' : 'Отвори Доставки → Настройки'}
          </Button>
          <button
            type="button"
            onClick={() => handoffTo('/help')}
            disabled={handoffBusy}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-ff-green-700 hover:underline disabled:opacity-60"
          >
            <BookOpen size={14} /> Откъде да взема тези данни?
          </button>
        </div>
      </div>
    </div>
  );
}
