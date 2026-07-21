'use client';

/**
 * Настройки → „Комисиона и такси". The missing operator control over
 * `tenants.settings.vendorFinance`.
 *
 * Why it exists: the per-producer „Комисиона %" input in the farmer panel writes
 * `farmers.commission_rate_bps`, but every consumer multiplies that rate by
 * `commissionEnabled` — and nothing in the app could ever set that flag. So an
 * operator would enter 10% on a producer, see it stored, and Статистики would still
 * read „Комисионата е изключена". This screen is the switch.
 *
 * Deliberately conservative: the feature is dormant by default and stays that way
 * until the operator turns it on here. Turning it ON is what makes amounts appear in
 * „Моят отчет" for every producer, so the copy says so plainly.
 */
import * as React from 'react';
import { Percent } from 'lucide-react';
import { toast } from 'sonner';
import { SaveBar } from '@/components/panels/panel-ui';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import {
  ApiError,
  getVendorFinanceSettings,
  updateVendorFinanceSettings,
  type VendorFinanceSettings,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[16px] sm:text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

/** 1000 bps → '10'; a whole percent keeps no trailing zero. */
const bpsToPct = (bps: number) => String(Math.round(bps) / 100);

/** 1250 minor units → '12.5'. Same arithmetic as bpsToPct, different unit — kept
 *  separate so the two can't be confused at the call site. */
const minorToAmount = (minor: number) => String(Math.round(minor) / 100);

/** '10,5' → 1050. null on blank, non-numeric, negative or over 100%. */
function pctToBps(input: string): number | null {
  const t = input.trim();
  if (t === '') return 0; // an empty rate means „no default", not an error
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** '12,50' → 1250 minor units. null on blank/non-numeric/negative. */
function amountToMinor(input: string): number | null {
  const t = input.trim();
  if (t === '') return 0;
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function CommissionCard() {
  const [saved, setSaved] = React.useState<VendorFinanceSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const [commissionEnabled, setCommissionEnabled] = React.useState(false);
  const [ratePct, setRatePct] = React.useState('');
  const [subscriptionEnabled, setSubscriptionEnabled] = React.useState(false);
  const [feeAmount, setFeeAmount] = React.useState('');

  const apply = React.useCallback((s: VendorFinanceSettings) => {
    setSaved(s);
    setCommissionEnabled(s.commissionEnabled);
    setRatePct(s.defaultCommissionRateBps ? bpsToPct(s.defaultCommissionRateBps) : '');
    setSubscriptionEnabled(s.subscriptionEnabled);
    setFeeAmount(
      s.defaultSubscriptionFeeStotinki ? minorToAmount(s.defaultSubscriptionFeeStotinki) : '',
    );
  }, []);

  React.useEffect(() => {
    let active = true;
    getVendorFinanceSettings()
      .then((s) => active && apply(s))
      .catch((e) => active && toast.error(errMsg(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [apply]);

  const rateBps = pctToBps(ratePct);
  const feeMinor = amountToMinor(feeAmount);
  // Compare against what would actually be SENT, so a reformat of the same number
  // („10" vs „10.0") is not reported as an unsaved change.
  const dirty =
    !!saved &&
    rateBps !== null &&
    feeMinor !== null &&
    (commissionEnabled !== saved.commissionEnabled ||
      rateBps !== saved.defaultCommissionRateBps ||
      subscriptionEnabled !== saved.subscriptionEnabled ||
      feeMinor !== saved.defaultSubscriptionFeeStotinki);

  const save = async () => {
    if (rateBps === null) {
      toast.error('Комисионата трябва да е между 0 и 100%');
      return;
    }
    if (feeMinor === null) {
      toast.error('Месечната такса трябва да е положително число');
      return;
    }
    setSaving(true);
    try {
      apply(
        await updateVendorFinanceSettings({
          commissionEnabled,
          defaultCommissionRateBps: rateBps,
          subscriptionEnabled,
          defaultSubscriptionFeeStotinki: feeMinor,
        }),
      );
      toast.success('Настройките са записани');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => saved && apply(saved);

  return (
    <section className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
      <div className="flex items-center gap-1.5 text-[16px] font-extrabold">
        <Percent size={17} /> Комисиона и такси
      </div>
      <p className="mt-1 text-[13px] leading-snug text-ff-muted">
        Колко задържаш от оборота на всеки производител. Докато комисионата е
        изключена, процентите не се прилагат никъде — Статистики и „Моят отчет&quot;
        показват 0.
      </p>

      {loading ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[14px] font-bold text-ff-ink">Начислявай комисиона</div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">
                  Щом включиш това, дължимите суми стават видими на производителите в
                  „Моят отчет&quot;.
                </div>
              </div>
              <ToggleSwitch checked={commissionEnabled} onChange={setCommissionEnabled} />
            </div>
            <label className={labelCls}>
              Комисиона по подразбиране (%)
              <input
                value={ratePct}
                onChange={(e) => setRatePct(e.target.value)}
                inputMode="decimal"
                placeholder="5"
                className={field}
              />
              <span className="text-[11.5px] font-semibold text-ff-muted">
                Прилага се за всеки производител без собствен процент. Отделният
                процент в панела на фермера има предимство.
              </span>
            </label>
          </div>

          <div className="flex flex-col gap-3 border-t border-ff-border-2 pt-5">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[14px] font-bold text-ff-ink">Месечни абонаментни такси</div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">
                  Позволява начисляване на месечни такси на производителите.
                </div>
              </div>
              <ToggleSwitch checked={subscriptionEnabled} onChange={setSubscriptionEnabled} />
            </div>
            <label className={labelCls}>
              Месечна такса по подразбиране (€)
              <input
                value={feeAmount}
                onChange={(e) => setFeeAmount(e.target.value)}
                inputMode="decimal"
                placeholder="12"
                className={field}
              />
            </label>
          </div>
        </div>
      )}

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={discard} />}
    </section>
  );
}
