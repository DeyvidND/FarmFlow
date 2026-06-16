'use client';

/**
 * Client-loaded versions of the «Конфигурации» screens so they can render as a
 * sub-section *inside* Настройки (keeping the settings shell + a back button)
 * instead of navigating away to a whole page. Each section self-loads the same
 * data the standalone route loads server-side, then renders the existing panel —
 * so the panels stay the single source of UI. The standalone routes
 * (/setup, /delivery, /slots, /features, /marketing-tracking) are unchanged and
 * still work for deep links.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  getTenant,
  getStripeSummary,
  listSlots,
  getSlotRule,
  getSiteMarketing,
  updateSiteMarketing,
} from '@/lib/api-client';
import { SetupPanel, type StripeStatus } from '@/components/panels/setup-panel';
import { DeliveryClient } from '@/components/delivery/delivery-client';
import { SlotsClient } from '@/components/slots/slots-client';
import { FeaturesPanel, type FeatureFlags } from '@/components/panels/features-panel';
import type { Slot, SlotRule, DeliveryConfig } from '@/lib/types';

function Loading() {
  return <p className="text-[14px] text-ff-muted">Зареждане…</p>;
}

const loadErr = () => toast.error('Неуспешно зареждане');

// ---- Методи и цени (/setup) ----
export function SetupSection() {
  const [s, setS] = React.useState<{
    enabled: boolean;
    delivery: DeliveryConfig | null;
    stripe: StripeStatus;
  } | null>(null);

  React.useEffect(() => {
    let on = true;
    Promise.all([getTenant(), getStripeSummary().catch(() => null)])
      .then(([t, stripe]) => {
        if (!on) return;
        setS({
          enabled: !!t.deliveryEnabled,
          delivery: t.delivery ?? null,
          stripe: stripe
            ? { enabled: stripe.enabled, connected: stripe.connected, chargesEnabled: stripe.chargesEnabled }
            : null,
        });
      })
      .catch(() => on && loadErr());
    return () => {
      on = false;
    };
  }, []);

  if (!s) return <Loading />;
  return <SetupPanel initialEnabled={s.enabled} initialDelivery={s.delivery} stripe={s.stripe} />;
}

// ---- Доставка (/delivery) ----
// Seeded demo week (25–31 May 2026) — matches the standalone Delivery page.
const DEMO_WEEK_FROM = '2026-05-25';
const DEMO_WEEK_TO = '2026-05-31';
export function DeliverySection() {
  const [s, setS] = React.useState<{
    enabled: boolean;
    delivery: DeliveryConfig | null;
    slotFreeCount: number;
  } | null>(null);

  React.useEffect(() => {
    let on = true;
    Promise.all([getTenant(), listSlots(DEMO_WEEK_FROM, DEMO_WEEK_TO).catch(() => [] as Slot[])])
      .then(([t, slots]) => {
        if (!on) return;
        const slotFreeCount = slots.reduce((sum, sl) => sum + ((sl.booked ?? 0) >= 1 ? 0 : 1), 0);
        setS({ enabled: !!t.deliveryEnabled, delivery: t.delivery ?? null, slotFreeCount });
      })
      .catch(() => on && loadErr());
    return () => {
      on = false;
    };
  }, []);

  if (!s) return <Loading />;
  return (
    <DeliveryClient
      initialEnabled={s.enabled}
      initialDelivery={s.delivery}
      slotFreeCount={s.slotFreeCount}
    />
  );
}

// ---- Часове за доставка (/slots) ----
/** Today's date in Bulgaria local time (YYYY-MM-DD). */
function bgToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function currentWeek(): { days: string[]; today: string } {
  const today = bgToday();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = isoAddDays(today, mondayOffset);
  return { days: Array.from({ length: 7 }, (_, i) => isoAddDays(monday, i)), today };
}

export function SlotsSection() {
  const { days, today } = React.useMemo(() => currentWeek(), []);
  const [s, setS] = React.useState<{ slots: Slot[]; rule: SlotRule | null; delivery: boolean } | null>(
    null,
  );

  React.useEffect(() => {
    let on = true;
    Promise.all([
      listSlots(days[0], days[6]).catch(() => [] as Slot[]),
      getTenant(),
      getSlotRule().catch(() => null),
    ])
      .then(([slots, t, rule]) => {
        if (!on) return;
        setS({ slots, rule, delivery: !!t.deliveryEnabled });
      })
      .catch(() => on && loadErr());
    return () => {
      on = false;
    };
  }, [days]);

  if (!s) return <Loading />;
  return (
    <SlotsClient
      initialSlots={s.slots}
      initialRule={s.rule}
      days={days}
      today={today}
      deliveryEnabled={s.delivery}
    />
  );
}

// ---- Функции на магазина (/features) ----
export function FeaturesSection() {
  const [f, setF] = React.useState<FeatureFlags | null>(null);
  React.useEffect(() => {
    let on = true;
    getTenant()
      .then((t) => {
        if (!on) return;
        setF({
          multiFarmer: !!t.multiFarmer,
          multiSubcat: !!t.multiSubcat,
          articlesEnabled: t.articlesEnabled ?? true,
          reviewsEnabled: t.reviewsEnabled ?? true,
        });
      })
      .catch(() => on && loadErr());
    return () => {
      on = false;
    };
  }, []);
  if (!f) return <Loading />;
  return <FeaturesPanel initial={f} />;
}

// ---- Маркетинг и проследяване (/marketing-tracking) ----
type MForm = {
  ga4: string;
  googleAds: string;
  googleAdsLabel: string;
  metaPixel: string;
  gtm: string;
  tiktok: string;
};
const M_EMPTY: MForm = { ga4: '', googleAds: '', googleAdsLabel: '', metaPixel: '', gtm: '', tiktok: '' };
// Soft client-side format check, mirroring the backend `normalizeMarketing`.
const M_PATTERNS: Record<keyof MForm, RegExp> = {
  ga4: /^G-[A-Z0-9]{4,15}$/i,
  googleAds: /^AW-[0-9]{6,15}$/i,
  googleAdsLabel: /^[A-Za-z0-9_-]{6,40}$/,
  metaPixel: /^[0-9]{10,20}$/,
  gtm: /^GTM-[A-Z0-9]{4,12}$/i,
  tiktok: /^[A-Z0-9]{10,40}$/i,
};

export function MarketingSection() {
  const [form, setForm] = React.useState<MForm>(M_EMPTY);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const apply = (m: Partial<Record<keyof MForm, string | null>>) =>
    setForm({
      ga4: m.ga4 ?? '',
      googleAds: m.googleAds ?? '',
      googleAdsLabel: m.googleAdsLabel ?? '',
      metaPixel: m.metaPixel ?? '',
      gtm: m.gtm ?? '',
      tiktok: m.tiktok ?? '',
    });

  React.useEffect(() => {
    let on = true;
    getSiteMarketing()
      .then((res) => on && apply(res.marketing))
      .catch(() => on && toast.error('Неуспешно зареждане'))
      .finally(() => on && setLoading(false));
    return () => {
      on = false;
    };
  }, []);

  const set = <K extends keyof MForm>(key: K, value: MForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const invalid = (key: keyof MForm): boolean => {
    const v = form[key].trim();
    return !!v && !M_PATTERNS[key].test(v);
  };

  async function save() {
    setSaving(true);
    try {
      const res = await updateSiteMarketing({ ...form });
      apply(res.marketing); // reflect what the server kept (it drops malformed values)
      toast.success('Запазено');
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Loading />;

  const card = 'rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm';
  const label = 'mb-1 block text-[13px] font-bold text-ff-ink';
  const input =
    'w-full rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] text-ff-ink outline-none focus:border-ff-green-600';
  const inputBad = 'border-ff-amber-600 focus:border-ff-amber-600';
  const help = 'mt-1 text-[12px] text-ff-muted';

  const field = (
    key: keyof MForm,
    title: string,
    placeholder: string,
    helpText: React.ReactNode,
  ) => (
    <div>
      <label className={label}>{title}</label>
      <input
        className={`${input} ${invalid(key) ? inputBad : ''}`}
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="none"
      />
      {invalid(key) && (
        <p className="mt-1 text-[12px] font-semibold text-ff-amber-600">
          Изглежда сгрешен формат — провери, иначе няма да се запази.
        </p>
      )}
      <p className={help}>{helpText}</p>
    </div>
  );

  return (
    <div className="max-w-[760px]">
      <div className="mb-6">
        <h2 className="mb-1 text-[18px] font-extrabold tracking-[-0.01em]">Маркетинг и проследяване</h2>
        <p className="text-[13.5px] text-ff-muted">
          Постави ID-тата си от Google и Meta — магазинът сам слага рекламните и
          аналитични кодове. Не е нужен програмист. Празно поле = изключено.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <section className={card}>
          <h3 className="mb-3 text-[15px] font-extrabold">Google Analytics (GA4)</h3>
          <div className="flex flex-col gap-3">
            {field('ga4', 'Measurement ID', 'G-XXXXXXXXXX', (
              <>
                Намира се в Google Analytics → Admin → Data Streams → твоят сайт →
                „Measurement ID&rdquo; (започва с <b>G-</b>).
              </>
            ))}
          </div>
        </section>

        <section className={card}>
          <h3 className="mb-3 text-[15px] font-extrabold">Google Ads</h3>
          <div className="flex flex-col gap-3">
            {field('googleAds', 'Conversion ID', 'AW-XXXXXXXXX', (
              <>
                В Google Ads → Tools → Conversions → твоята конверсия → „Tag setup&rdquo;.
                ID-то започва с <b>AW-</b>.
              </>
            ))}
            {field('googleAdsLabel', 'Conversion Label (за „покупка")', 'AbC-D1efGhIjk2', (
              <>
                Етикетът до Conversion ID (частта след наклонената черта в
                <b> AW-XXX/etiket</b>). Нужен е, за да се отчита покупка като
                конверсия. Без Conversion ID не се пази.
              </>
            ))}
          </div>
        </section>

        <section className={card}>
          <h3 className="mb-3 text-[15px] font-extrabold">Meta Pixel (Facebook / Instagram)</h3>
          <div className="flex flex-col gap-3">
            {field('metaPixel', 'Pixel ID', '123456789012345', (
              <>
                В Meta Events Manager → Data Sources → твоят Pixel. ID-то е число
                (10–20 цифри).
              </>
            ))}
          </div>
        </section>

        <section className={card}>
          <h3 className="mb-1 text-[15px] font-extrabold">Други (по избор)</h3>
          <p className="mb-3 text-[12.5px] text-ff-muted">Само ако вече ползваш тези инструменти.</p>
          <div className="flex flex-col gap-3">
            {field('gtm', 'Google Tag Manager — Container ID', 'GTM-XXXXXXX', (
              <>
                Ако управляваш всички кодове през GTM. Намира се в Tag Manager →
                горе до името на контейнера (започва с <b>GTM-</b>).
              </>
            ))}
            {field('tiktok', 'TikTok Pixel ID', 'CXXXXXXXXXXXXXXXXX', (
              <>В TikTok Ads Manager → Assets → Events → Web Events → твоят Pixel.</>
            ))}
          </div>
        </section>

        <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-3 text-[12.5px] text-ff-muted">
          Магазинът показва бар за съгласие (GDPR) — рекламните кодове се активират
          чак след като посетителят приеме бисквитките. Покупките се отчитат
          автоматично на страницата за потвърждение.
        </div>

        <div className="mt-1 flex justify-end border-t border-ff-border pt-4">
          <Button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-sm px-6 py-2.5 text-[14px] font-bold"
          >
            {saving ? 'Запазване…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
