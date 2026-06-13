'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getSiteMarketing, updateSiteMarketing } from '@/lib/api-client';

type Form = {
  ga4: string;
  googleAds: string;
  googleAdsLabel: string;
  metaPixel: string;
  gtm: string;
  tiktok: string;
};

const EMPTY: Form = {
  ga4: '', googleAds: '', googleAdsLabel: '', metaPixel: '', gtm: '', tiktok: '',
};

// Soft client-side format check, mirroring the backend `normalizeMarketing`
// patterns. A malformed value is warned about but still sent — the server drops
// it (it never reaches the storefront), so this only guides the farmer.
const PATTERNS: Record<keyof Form, RegExp> = {
  ga4: /^G-[A-Z0-9]{4,15}$/i,
  googleAds: /^AW-[0-9]{6,15}$/i,
  googleAdsLabel: /^[A-Za-z0-9_-]{6,40}$/,
  metaPixel: /^[0-9]{10,20}$/,
  gtm: /^GTM-[A-Z0-9]{4,12}$/i,
  tiktok: /^[A-Z0-9]{10,40}$/i,
};

export default function MarketingTrackingPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSiteMarketing()
      .then((res) => {
        setForm({
          ga4: res.marketing.ga4 ?? '',
          googleAds: res.marketing.googleAds ?? '',
          googleAdsLabel: res.marketing.googleAdsLabel ?? '',
          metaPixel: res.marketing.metaPixel ?? '',
          gtm: res.marketing.gtm ?? '',
          tiktok: res.marketing.tiktok ?? '',
        });
      })
      .catch(() => toast.error('Неуспешно зареждане'))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const invalid = (key: keyof Form): boolean => {
    const v = form[key].trim();
    return !!v && !PATTERNS[key].test(v);
  };

  async function save() {
    setSaving(true);
    try {
      const res = await updateSiteMarketing({ ...form });
      // Reflect what the server actually kept (it drops malformed/lone values),
      // so the form shows the real stored state after a save.
      setForm({
        ga4: res.marketing.ga4 ?? '',
        googleAds: res.marketing.googleAds ?? '',
        googleAdsLabel: res.marketing.googleAdsLabel ?? '',
        metaPixel: res.marketing.metaPixel ?? '',
        gtm: res.marketing.gtm ?? '',
        tiktok: res.marketing.tiktok ?? '',
      });
      toast.success('Запазено');
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="max-w-[760px] text-[14px] text-ff-muted">Зареждане…</p>;
  }

  const card = 'rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm';
  const label = 'mb-1 block text-[13px] font-bold text-ff-ink';
  const input =
    'w-full rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] text-ff-ink outline-none focus:border-ff-green-600';
  const inputBad = 'border-ff-amber-600 focus:border-ff-amber-600';
  const help = 'mt-1 text-[12px] text-ff-muted';

  // One labeled vendor input + helper line.
  const field = (
    key: keyof Form,
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
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Маркетинг и проследяване</h1>
        <p className="text-[13.5px] text-ff-muted">
          Постави ID-тата си от Google и Meta — магазинът сам слага рекламните и
          аналитични кодове. Не е нужен програмист. Празно поле = изключено.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        {/* Google Analytics */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Google Analytics (GA4)</h2>
          <div className="flex flex-col gap-3">
            {field(
              'ga4',
              'Measurement ID',
              'G-XXXXXXXXXX',
              <>
                Намира се в Google Analytics → Admin → Data Streams → твоят сайт →
                „Measurement ID&rdquo; (започва с <b>G-</b>).
              </>,
            )}
          </div>
        </section>

        {/* Google Ads */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Google Ads</h2>
          <div className="flex flex-col gap-3">
            {field(
              'googleAds',
              'Conversion ID',
              'AW-XXXXXXXXX',
              <>
                В Google Ads → Tools → Conversions → твоята конверсия → „Tag setup&rdquo;.
                ID-то започва с <b>AW-</b>.
              </>,
            )}
            {field(
              'googleAdsLabel',
              'Conversion Label (за „покупка")',
              'AbC-D1efGhIjk2',
              <>
                Етикетът до Conversion ID (частта след наклонената черта в
                <b> AW-XXX/etiket</b>). Нужен е, за да се отчита покупка като
                конверсия. Без Conversion ID не се пази.
              </>,
            )}
          </div>
        </section>

        {/* Meta Pixel */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Meta Pixel (Facebook / Instagram)</h2>
          <div className="flex flex-col gap-3">
            {field(
              'metaPixel',
              'Pixel ID',
              '123456789012345',
              <>
                В Meta Events Manager → Data Sources → твоят Pixel. ID-то е число
                (10–20 цифри).
              </>,
            )}
          </div>
        </section>

        {/* Advanced: GTM + TikTok */}
        <section className={card}>
          <h2 className="mb-1 text-[15px] font-extrabold">Други (по избор)</h2>
          <p className="mb-3 text-[12.5px] text-ff-muted">
            Само ако вече ползваш тези инструменти.
          </p>
          <div className="flex flex-col gap-3">
            {field(
              'gtm',
              'Google Tag Manager — Container ID',
              'GTM-XXXXXXX',
              <>
                Ако управляваш всички кодове през GTM. Намира се в Tag Manager →
                горе до името на контейнера (започва с <b>GTM-</b>).
              </>,
            )}
            {field(
              'tiktok',
              'TikTok Pixel ID',
              'CXXXXXXXXXXXXXXXXX',
              <>
                В TikTok Ads Manager → Assets → Events → Web Events → твоят Pixel.
              </>,
            )}
          </div>
        </section>

        <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-3 text-[12.5px] text-ff-muted">
          Магазинът показва бар за съгласие (GDPR) — рекламните кодове се активират
          чак след като посетителят приеме бисквитките. Покупките се отчитат
          автоматично на страницата за потвърждение.
        </div>

        <div className="mt-1 flex justify-end border-t border-ff-border pt-4">
          <Button type="button" onClick={save} disabled={saving}
            className="rounded-sm px-6 py-2.5 text-[14px] font-bold">
            {saving ? 'Запазване…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
