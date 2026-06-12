'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Users, Tags, Newspaper, Star, LayoutGrid, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ApiError, updateTenant } from '@/lib/api-client';
import { CardGroup, ToggleCard, SaveBar } from './panel-ui';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** The four storefront-feature flags this panel owns. */
export interface FeatureFlags {
  multiFarmer: boolean;
  multiSubcat: boolean;
  articlesEnabled: boolean;
  reviewsEnabled: boolean;
}

export function FeaturesPanel({ initial }: { initial: FeatureFlags }) {
  const router = useRouter();
  const [saved, setSaved] = React.useState<FeatureFlags>(initial);
  const [val, setVal] = React.useState<FeatureFlags>(initial);
  const [saving, setSaving] = React.useState(false);

  const dirty = JSON.stringify(val) !== JSON.stringify(saved);
  const set = (k: keyof FeatureFlags, v: boolean) => setVal((p) => ({ ...p, [k]: v }));

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
          onToggle={(v) => set('multiFarmer', v)}
          configLink={{ href: '/farmers', label: 'Управлявай фермерите' }}
        />
        <ToggleCard
          icon={Tags}
          title="Подкатегории"
          desc="Групирай продуктите в раздели (напр. „Млечни“, „Зеленчуци“). Без това всичко е в общ списък."
          on={val.multiSubcat}
          onToggle={(v) => set('multiSubcat', v)}
          configLink={{ href: '/subcategories', label: 'Управлявай подкатегориите' }}
        />
      </CardGroup>

      <CardGroup icon={MessageSquare} title="Съдържание" desc="Допълнителни секции в магазина.">
        <ToggleCard
          icon={Newspaper}
          title="Статии"
          desc="Блог/новини секция — рецепти, истории от фермата. Изключи, ако не пишеш статии."
          on={val.articlesEnabled}
          onToggle={(v) => set('articlesEnabled', v)}
          configLink={{ href: '/articles', label: 'Управлявай статиите' }}
        />
        <ToggleCard
          icon={Star}
          title="Отзиви"
          desc="Клиентите оставят оценки и мнения в магазина. Изключи, за да скриеш секцията с отзиви."
          on={val.reviewsEnabled}
          onToggle={(v) => set('reviewsEnabled', v)}
          configLink={{ href: '/reviews', label: 'Управлявай отзивите' }}
        />
      </CardGroup>

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => setVal(saved)} />}
    </div>
  );
}
