'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Users, Tags, Newspaper, Star, LayoutGrid, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  ApiError,
  updateTenant,
  listFarmers,
  listSubcategories,
  listArticles,
  listReviews,
} from '@/lib/api-client';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CardGroup, ToggleCard, SaveBar } from './panel-ui';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** The storefront-feature flags this panel owns. */
export interface FeatureFlags {
  multiFarmer: boolean;
  multiSubcat: boolean;
  articlesEnabled: boolean;
  reviewsEnabled: boolean;
}

/**
 * Turning a section OFF when the farm already built content into it hides that
 * work from customers. Guard each flag with a confirm modal that fires only when
 * more than one item exists — `label` names the section, `noun` reads in
 * „Имаш {n} {noun}", `count` pulls the live total.
 */
const GUARDS: Record<
  keyof FeatureFlags,
  { label: string; noun: string; count: () => Promise<number> }
> = {
  multiFarmer: { label: 'Фермери', noun: 'фермери', count: () => listFarmers().then((x) => x.length) },
  multiSubcat: { label: 'Категории', noun: 'категории', count: () => listSubcategories().then((x) => x.length) },
  articlesEnabled: { label: 'Статии', noun: 'статии', count: () => listArticles().then((x) => x.items.length) },
  reviewsEnabled: { label: 'Отзиви', noun: 'отзива', count: () => listReviews().then((x) => x.items.length) },
};

export function FeaturesPanel({ initial }: { initial: FeatureFlags }) {
  const router = useRouter();
  const [saved, setSaved] = React.useState<FeatureFlags>(initial);
  const [val, setVal] = React.useState<FeatureFlags>(initial);
  const [saving, setSaving] = React.useState(false);
  // Live item counts per section (undefined = not loaded → fail open, no guard).
  const [counts, setCounts] = React.useState<Partial<Record<keyof FeatureFlags, number>>>({});
  // Which section is awaiting a turn-off confirmation (null = no modal).
  const [pending, setPending] = React.useState<keyof FeatureFlags | null>(null);

  React.useEffect(() => {
    let active = true;
    (Object.keys(GUARDS) as (keyof FeatureFlags)[]).forEach((k) => {
      GUARDS[k]
        .count()
        .then((n) => active && setCounts((c) => ({ ...c, [k]: n })))
        .catch(() => {});
    });
    return () => {
      active = false;
    };
  }, []);

  const dirty = JSON.stringify(val) !== JSON.stringify(saved);
  const set = (k: keyof FeatureFlags, v: boolean) => setVal((p) => ({ ...p, [k]: v }));
  // Gate a turn-off behind the confirm modal when the section has >1 item built.
  const requestToggle = (k: keyof FeatureFlags, v: boolean) => {
    if (!v && (counts[k] ?? 0) > 1) {
      setPending(k);
      return;
    }
    set(k, v);
  };

  const save = async () => {
    setSaving(true);
    try {
      await updateTenant(val);
      setSaved(val);
      router.refresh();
      toast.success('Настройките са запазени');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn('animate-ff-fade-up flex flex-col gap-4', dirty && 'pb-20')}>
      <div className="mb-1">
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ff-ink">
          Функции на магазина
        </h1>
        <p className="mt-0.5 text-[14px] text-ff-ink-2">
          Включи или изключи цели части от магазина. Изключеното не се показва на клиентите.
        </p>
      </div>

      <CardGroup icon={LayoutGrid} title="Каталог" desc="Как са подредени продуктите в магазина.">
        <ToggleCard
          icon={Users}
          title="Фермери"
          desc="Повече от един производител в магазина. Включи, ако продаваш стока от няколко ферми — клиентът вижда кой какво предлага."
          on={val.multiFarmer}
          onToggle={(v) => requestToggle('multiFarmer', v)}
          configLink={{ href: '/farmers', label: 'Управлявай фермерите' }}
        />
        <ToggleCard
          icon={Tags}
          title="Категории"
          desc="Групирай продуктите в категории (напр. „Млечни“, „Зеленчуци“). Без това всичко е в общ списък."
          on={val.multiSubcat}
          onToggle={(v) => requestToggle('multiSubcat', v)}
          configLink={{ href: '/subcategories', label: 'Управлявай категориите' }}
        />
      </CardGroup>

      <CardGroup icon={MessageSquare} title="Съдържание" desc="Допълнителни секции в магазина.">
        <ToggleCard
          icon={Newspaper}
          title="Статии"
          desc="Блог/новини секция — рецепти, истории от фермата. Изключи, ако не пишеш статии."
          on={val.articlesEnabled}
          onToggle={(v) => requestToggle('articlesEnabled', v)}
          configLink={{ href: '/articles', label: 'Управлявай статиите' }}
        />
        <ToggleCard
          icon={Star}
          title="Отзиви"
          desc="Клиентите оставят оценки и мнения в магазина. Изключи, за да скриеш секцията с отзиви."
          on={val.reviewsEnabled}
          onToggle={(v) => requestToggle('reviewsEnabled', v)}
          configLink={{ href: '/reviews', label: 'Управлявай отзивите' }}
        />
      </CardGroup>

      <p className="text-[12.5px] leading-snug text-ff-ink-2">
        Включеното тук става достъпно в магазина. Кои блокове да се показват на началната
        страница (и колко неща във всеки) се избира в{' '}
        <Link href="/settings?config=landing" className="font-bold text-ff-green-700 hover:underline">
          Настройки → Начална страница
        </Link>
        .
      </p>

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => setVal(saved)} />}

      {pending && (
        <ConfirmDialog
          title={`Изключване на „${GUARDS[pending].label}“?`}
          message={
            <>
              Имаш {counts[pending]} {GUARDS[pending].noun} в магазина. Ако изключиш тази секция,
              тя няма да се показва на клиентите. Може да я включиш пак по всяко време.
            </>
          }
          confirmLabel="Изключи"
          cancelLabel="Остави включено"
          onConfirm={() => {
            set(pending, false);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
