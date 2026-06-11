'use client';

/**
 * Settings → начална страница. Lets the farm choose which of the three dynamic
 * home blocks (категории / фермери / най-актуални) appear on the storefront home
 * and how many items each shows. Stored in settings.landing via PATCH
 * /tenants/me/landing; the chaika storefront reads the resolved config.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SaveBar } from '@/components/panels/panel-ui';
import {
  ApiError,
  getLanding,
  updateLanding,
  getTenant,
  type LandingConfig,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

type BlockKey = 'categories' | 'farmers' | 'latest';

const ROWS: { key: BlockKey; title: string; desc: string; allowAll: boolean }[] = [
  { key: 'categories', title: 'Категории', desc: 'Плочки „Какво ще намериш“.', allowAll: true },
  { key: 'farmers', title: 'Фермери', desc: 'Блок „Запознай се с фермерите“.', allowAll: false },
  { key: 'latest', title: 'Най-актуални', desc: 'Блок „Най-актуални предложения“.', allowAll: false },
];

const range1to12 = Array.from({ length: 12 }, (_, i) => i + 1);

const same = (a: LandingConfig, b: LandingConfig) => JSON.stringify(a) === JSON.stringify(b);

export function LandingCard() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [multiFarmer, setMultiFarmer] = React.useState(true);
  const [saved, setSaved] = React.useState<LandingConfig | null>(null);
  const [cfg, setCfg] = React.useState<LandingConfig | null>(null);

  React.useEffect(() => {
    let active = true;
    Promise.all([getLanding(), getTenant()])
      .then(([l, t]) => {
        if (!active) return;
        setSaved(l.landing);
        setCfg(l.landing);
        setMultiFarmer(Boolean(t.multiFarmer));
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const dirty = !!cfg && !!saved && !same(cfg, saved);

  const setShow = (key: BlockKey, show: boolean) =>
    setCfg((p) => (p ? { ...p, [key]: { ...p[key], show } } : p));
  const setCount = (key: BlockKey, count: number) =>
    setCfg((p) => (p ? { ...p, [key]: { ...p[key], count } } : p));

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const { landing } = await updateLanding(cfg);
      setSaved(landing);
      setCfg(landing);
      toast.success('Началната страница е обновена');
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
      <h2 className="text-[16px] font-extrabold">Начална страница</h2>
      <p className="mt-1 text-[13px] leading-snug text-ff-muted">
        Избери кои блокове да се показват на началната страница на магазина и колко неща да
        стоят във всеки. Останалите секции (заглавие, локация, бюлетин) остават непроменени.
      </p>

      {loading || !cfg ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {ROWS.map((row) => {
            const block = cfg[row.key];
            const farmersBlocked = row.key === 'farmers' && !multiFarmer;
            const on = block.show && !farmersBlocked;
            const opts = row.allowAll ? [0, ...range1to12] : range1to12;
            return (
              <div
                key={row.key}
                className={cn(
                  'rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3',
                  farmersBlocked && 'opacity-60',
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14.5px] font-extrabold text-ff-ink">{row.title}</div>
                    <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">
                      {farmersBlocked ? 'Само при мулти-фермер режим.' : row.desc}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={on}
                    disabled={farmersBlocked}
                    onChange={(v) => setShow(row.key, v)}
                  />
                </div>

                <div
                  className={cn(
                    'mt-3 flex items-center gap-2 transition-opacity',
                    (!on || farmersBlocked) && 'pointer-events-none opacity-45',
                  )}
                >
                  <label className="text-[12.5px] font-bold text-ff-ink-2">Брой:</label>
                  <select
                    value={block.count}
                    disabled={!on || farmersBlocked}
                    onChange={(e) => setCount(row.key, Number(e.target.value))}
                    className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13.5px] font-bold text-ff-ink"
                  >
                    {opts.map((n) => (
                      <option key={n} value={n}>
                        {n === 0 ? 'Всички' : n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => setCfg(saved)} />}
    </section>
  );
}
