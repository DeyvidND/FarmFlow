'use client';

/**
 * Settings → начална страница. Lets the farm choose which of the three dynamic
 * home blocks (категории / фермери / най-актуални) appear on the storefront home.
 * Each block runs in one of two modes:
 *   • Автоматично — show the first/newest N items (a «Брой» dropdown), and
 *   • Избери ръчно — hand-pick exactly which items show (a checklist).
 * Plus a curated reviews block. Stored in settings.landing via PATCH
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
  listFarmers,
  listSubcategories,
  listProductOptions,
  type LandingConfig,
} from '@/lib/api-client';
import type { AdminReview } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

type BlockKey = 'categories' | 'farmers' | 'latest';
type PickKind = 'subcategories' | 'farmers' | 'products';
type PickItem = { id: string; name: string };

const ROWS: {
  key: BlockKey;
  title: string;
  desc: string;
  /** Categories allow «Всички» (count 0); farmers/latest are >= 1. */
  allowAll: boolean;
  pickKind: PickKind;
  pickLabel: string;
  pickEmpty: string;
}[] = [
  {
    key: 'categories',
    title: 'Категории',
    desc: 'Категориите в магазина (напр. Зеленчуци, Млечни). Клиентът избира категория и отива право в нея.',
    allowAll: true,
    pickKind: 'subcategories',
    pickLabel: 'Кои категории да се показват',
    pickEmpty: 'Няма категории за избор. Добави ги от „Категории“.',
  },
  {
    key: 'farmers',
    title: 'Фермери',
    desc: 'Показва производителите, чиято стока продаваш — снимка и кратко описание. Клиентът вижда кой стои зад продуктите.',
    allowAll: false,
    pickKind: 'farmers',
    pickLabel: 'Кои фермери да се показват',
    pickEmpty: 'Няма фермери за избор. Добави ги от „Фермери“.',
  },
  {
    key: 'latest',
    title: 'Най-актуални',
    desc: 'Лента с продукти на видно място горе на началната страница — клиентите ги виждат веднага.',
    allowAll: false,
    pickKind: 'products',
    pickLabel: 'Кои продукти да се показват',
    pickEmpty: 'Няма продукти за избор. Добави ги от „Продукти“.',
  },
];

const range1to12 = Array.from({ length: 12 }, (_, i) => i + 1);
const MAX_PICKS = 12;

const same = (a: LandingConfig, b: LandingConfig) => JSON.stringify(a) === JSON.stringify(b);

export function LandingCard() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [multiFarmer, setMultiFarmer] = React.useState(true);
  const [saved, setSaved] = React.useState<LandingConfig | null>(null);
  const [cfg, setCfg] = React.useState<LandingConfig | null>(null);
  const [pubReviews, setPubReviews] = React.useState<AdminReview[]>([]);

  // Pick-lists for manual mode, lazily fetched the first time a block needs one.
  // `undefined` = not loaded yet, `[]` = loaded but empty.
  const [options, setOptions] = React.useState<Partial<Record<PickKind, PickItem[]>>>({});
  const loadingKinds = React.useRef<Set<PickKind>>(new Set());

  const ensureOptions = React.useCallback((kind: PickKind) => {
    if (loadingKinds.current.has(kind)) return;
    setOptions((prev) => {
      if (prev[kind] !== undefined) return prev; // already loaded
      loadingKinds.current.add(kind);
      const req =
        kind === 'subcategories'
          ? listSubcategories()
          : kind === 'farmers'
            ? listFarmers()
            : listProductOptions();
      req
        .then((items: { id: string; name: string }[]) =>
          setOptions((o) => ({ ...o, [kind]: items.map((it) => ({ id: it.id, name: it.name })) })),
        )
        .catch(() => setOptions((o) => ({ ...o, [kind]: [] })));
      return prev;
    });
  }, []);

  React.useEffect(() => {
    let active = true;
    Promise.all([getLanding(), getTenant(), listReviews('published')])
      .then(([l, t, rv]) => {
        if (!active) return;
        setSaved(l.landing);
        setCfg(l.landing);
        setMultiFarmer(Boolean(t.multiFarmer));
        setPubReviews(rv.items);
        // Preload pick-lists for any block already in manual mode.
        ROWS.forEach((r) => {
          if (l.landing[r.key].mode === 'manual') ensureOptions(r.pickKind);
        });
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [ensureOptions]);

  const dirty = !!cfg && !!saved && !same(cfg, saved);

  const setShow = (key: BlockKey, show: boolean) =>
    setCfg((p) => (p ? { ...p, [key]: { ...p[key], show } } : p));
  const setCount = (key: BlockKey, count: number) =>
    setCfg((p) => (p ? { ...p, [key]: { ...p[key], count } } : p));
  const setMode = (key: BlockKey, mode: 'auto' | 'manual') => {
    setCfg((p) => (p ? { ...p, [key]: { ...p[key], mode } } : p));
    if (mode === 'manual') {
      const row = ROWS.find((r) => r.key === key);
      if (row) ensureOptions(row.pickKind);
    }
  };
  const togglePick = (key: BlockKey, id: string) =>
    setCfg((p) => {
      if (!p) return p;
      const cur = p[key].ids;
      const ids = cur.includes(id)
        ? cur.filter((x) => x !== id)
        : cur.length < MAX_PICKS
          ? [...cur, id]
          : cur;
      return { ...p, [key]: { ...p[key], ids } };
    });

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
        Избери кои блокове да се показват на началната страница на магазина. За всеки
        блок може да оставиш магазина да реди автоматично, или сам да избереш кои неща да
        стоят. Останалите секции (заглавие, локация, бюлетин) остават непроменени.
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
            const items = options[row.pickKind];
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
                          <Link href="/settings?config=features" className="font-bold text-ff-green-700 hover:underline">
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
                    'mt-3 transition-opacity',
                    (!on || farmersBlocked) && 'pointer-events-none opacity-45',
                  )}
                >
                  {/* mode toggle: auto (count) vs manual (pick) */}
                  <div className="inline-flex rounded-lg border border-ff-border bg-ff-surface p-0.5 text-[12.5px] font-bold">
                    <ModeButton
                      active={block.mode !== 'manual'}
                      onClick={() => setMode(row.key, 'auto')}
                    >
                      Автоматично
                    </ModeButton>
                    <ModeButton
                      active={block.mode === 'manual'}
                      onClick={() => setMode(row.key, 'manual')}
                    >
                      Избери ръчно
                    </ModeButton>
                  </div>

                  {block.mode === 'manual' ? (
                    <div className="mt-3">
                      <div className="mb-1.5 text-[12.5px] font-bold text-ff-ink-2">
                        {row.pickLabel}{' '}
                        <span className="font-extrabold text-ff-muted">
                          ({block.ids.length}/{MAX_PICKS})
                        </span>
                      </div>
                      <PickList
                        items={items}
                        picked={block.ids}
                        onToggle={(id) => togglePick(row.key, id)}
                        emptyHint={row.pickEmpty}
                      />
                      {items && items.length > 0 && block.ids.length === 0 && (
                        <div className="mt-1.5 text-[12px] font-semibold text-ff-amber-600">
                          Не си избрал нищо — блокът ще е празен на сайта.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center gap-2">
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
                  )}
                </div>
              </div>
            );
          })}

          {/* Reviews — pick specific published reviews to feature on the home page.
              Hidden entirely when the shop has no published reviews: the storefront
              block can't render without picks, so the option would be dead weight. */}
          {pubReviews.length > 0 && (
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
          )}
        </div>
      )}

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => setCfg(saved)} />}
    </section>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-2.5 py-1 transition-colors',
        active ? 'bg-ff-green-700 text-white' : 'text-ff-ink-2 hover:bg-ff-surface-2',
      )}
    >
      {children}
    </button>
  );
}

/** Generic checklist for hand-picking items (subcategories / farmers / products).
 *  `items === undefined` → still loading. Picked order is the caller's. */
function PickList({
  items,
  picked,
  onToggle,
  emptyHint,
}: {
  items: PickItem[] | undefined;
  picked: string[];
  onToggle: (id: string) => void;
  emptyHint: string;
}) {
  if (items === undefined) {
    return <div className="text-[12.5px] text-ff-muted">Зареждане…</div>;
  }
  if (items.length === 0) {
    return <div className="text-[12.5px] text-ff-muted">{emptyHint}</div>;
  }
  return (
    <div className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto">
      {items.map((it) => {
        const isPicked = picked.includes(it.id);
        const atCap = !isPicked && picked.length >= MAX_PICKS;
        return (
          <label
            key={it.id}
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-2',
              atCap && 'cursor-not-allowed opacity-45',
            )}
          >
            <input
              type="checkbox"
              className="shrink-0"
              checked={isPicked}
              disabled={atCap}
              onChange={() => onToggle(it.id)}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ff-ink">
              {it.name}
            </span>
          </label>
        );
      })}
    </div>
  );
}
