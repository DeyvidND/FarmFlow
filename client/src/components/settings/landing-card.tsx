'use client';

/**
 * Settings → начална страница. Lets the farm choose which of the three dynamic
 * home blocks (категории / фермери / най-актуални) appear on the storefront home
 * and how many items each shows. Stored in settings.landing via PATCH
 * /tenants/me/landing; the chaika storefront reads the resolved config.
 */
import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SaveBar } from '@/components/panels/panel-ui';
import {
  ApiError,
  getLanding,
  updateLanding,
  getTenant,
  listReviews,
  type LandingConfig,
} from '@/lib/api-client';
import type { AdminReview } from '@/lib/types';

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
  const [pubReviews, setPubReviews] = React.useState<AdminReview[]>([]);

  React.useEffect(() => {
    let active = true;
    Promise.all([getLanding(), getTenant(), listReviews('published')])
      .then(([l, t, rv]) => {
        if (!active) return;
        setSaved(l.landing);
        setCfg(l.landing);
        setMultiFarmer(Boolean(t.multiFarmer));
        setPubReviews(rv.items);
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

  const MAX_REVIEW_PICKS = 12;
  const setReviewsShow = (show: boolean) =>
    setCfg((p) => (p ? { ...p, reviews: { ...p.reviews, show } } : p));
  const toggleReview = (id: string) =>
    setCfg((p) => {
      if (!p) return p;
      const ids = p.reviews.ids.includes(id)
        ? p.reviews.ids.filter((x) => x !== id)
        : p.reviews.ids.length < MAX_REVIEW_PICKS
          ? [...p.reviews.ids, id]
          : p.reviews.ids;
      return { ...p, reviews: { ...p.reviews, ids } };
    });

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
                      {farmersBlocked ? (
                        <>
                          Включва се само при мулти-фермер режим.{' '}
                          <Link href="/features" className="font-bold text-ff-green-700 hover:underline">
                            Включи „Фермери“ →
                          </Link>
                        </>
                      ) : (
                        row.desc
                      )}
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

          {/* Reviews — pick specific published reviews to feature on the home page */}
          <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-extrabold text-ff-ink">Отзиви</div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">
                  Избери кои отзиви на клиенти да се показват на началната страница.
                </div>
              </div>
              <ToggleSwitch checked={cfg.reviews.show} onChange={setReviewsShow} />
            </div>

            {cfg.reviews.show && (
              <div className="mt-3">
                {pubReviews.length === 0 ? (
                  <div className="text-[12.5px] text-ff-muted">
                    Няма публикувани отзиви за избор. Публикувай отзиви от „Отзиви“.
                  </div>
                ) : (
                  <>
                    <div className="mb-2 text-[12px] font-bold text-ff-ink-2">
                      Избрани: {cfg.reviews.ids.length}/{MAX_REVIEW_PICKS}
                    </div>
                    <div className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto">
                      {pubReviews.map((r) => {
                        const picked = cfg.reviews.ids.includes(r.id);
                        const atCap = !picked && cfg.reviews.ids.length >= MAX_REVIEW_PICKS;
                        return (
                          <label
                            key={r.id}
                            className={cn(
                              'flex cursor-pointer items-start gap-2.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-2',
                              atCap && 'cursor-not-allowed opacity-45',
                            )}
                          >
                            <input
                              type="checkbox"
                              className="mt-1 shrink-0"
                              checked={picked}
                              disabled={atCap}
                              onChange={() => toggleReview(r.id)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-[13px] font-bold text-ff-ink">
                                {'★'.repeat(r.rating)} · {r.authorName}
                                {r.authorLocation ? `, ${r.authorLocation}` : ''}
                              </div>
                              <div className="truncate text-[12.5px] text-ff-muted">{r.body}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => setCfg(saved)} />}
    </section>
  );
}
