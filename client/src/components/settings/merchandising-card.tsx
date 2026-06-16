'use client';

/**
 * Settings → най-продавани и препоръки. Two opt-in storefront features:
 *   - „Най-продавани" — a best-sellers filter chip on the shop page.
 *   - „Препоръчани в количката" — „Често купувано заедно" picks on the cart screen.
 * Stored in settings.merchandising via PATCH /tenants/me/merchandising; the chaika
 * storefront reads the resolved flags from its profile.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SaveBar } from '@/components/panels/panel-ui';
import {
  ApiError,
  getMerchandising,
  updateMerchandising,
  type MerchandisingConfig,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

type FeatureKey = 'bestSellers' | 'recommendations';

const ROWS: { key: FeatureKey; title: string; desc: string }[] = [
  {
    key: 'bestSellers',
    title: 'Най-продавани',
    desc: 'Добавя бутон „Най-продавани“ в магазина (втори, след „Всички“), който показва най-купуваните продукти.',
  },
  {
    key: 'recommendations',
    title: 'Препоръчани в количката',
    desc: 'Показва блок „Често купувано заедно“ в количката с продукти, които клиентите купуват заедно с тези в нея.',
  },
];

const same = (a: MerchandisingConfig, b: MerchandisingConfig) =>
  JSON.stringify(a) === JSON.stringify(b);

export function MerchandisingCard() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<MerchandisingConfig | null>(null);
  const [cfg, setCfg] = React.useState<MerchandisingConfig | null>(null);

  React.useEffect(() => {
    let active = true;
    getMerchandising()
      .then(({ merchandising }) => {
        if (!active) return;
        setSaved(merchandising);
        setCfg(merchandising);
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const dirty = !!cfg && !!saved && !same(cfg, saved);

  const setShow = (key: FeatureKey, show: boolean) =>
    setCfg((p) => (p ? { ...p, [key]: { show } } : p));

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const { merchandising } = await updateMerchandising(cfg);
      setSaved(merchandising);
      setCfg(merchandising);
      toast.success('Настройките са обновени');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={cn(
        'rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm',
        dirty && 'mb-16',
      )}
    >
      <h2 className="text-[16px] font-extrabold">Най-продавани и препоръки</h2>
      <p className="mt-1 text-[13px] leading-snug text-ff-muted">
        Включи автоматични секции, базирани на реалните поръчки. Стават активни щом
        магазинът натрупа продажби; до тогава се пълнят с препоръчани продукти.
      </p>

      {loading || !cfg ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {ROWS.map((row) => (
            <div
              key={row.key}
              className="rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3"
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-extrabold text-ff-ink">{row.title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">{row.desc}</div>
                </div>
                <ToggleSwitch
                  checked={cfg[row.key].show}
                  onChange={(v) => setShow(row.key, v)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => setCfg(saved)} />}
    </section>
  );
}
