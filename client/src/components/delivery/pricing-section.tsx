'use client';

import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DeliveryConfig } from '@/lib/types';
import { DSection, DLabel, Segmented, LvInput, Collapsible, fieldCls } from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;

const lvText = (s: number) => (s / 100).toFixed(2).replace('.', ',');
const addRowCls =
  'mt-3 inline-flex items-center gap-1.5 rounded-[9px] border-[1.5px] border-dashed border-ff-border px-3.5 py-2 text-[13px] font-bold text-ff-green-700 transition-colors hover:border-ff-green-500 hover:bg-ff-green-50';
const delBtnCls =
  'grid h-[38px] w-[38px] place-items-center rounded-sm border border-ff-border bg-ff-surface-2 text-ff-muted hover:text-ff-red';

export function PricingSection({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const p = cfg.pricing;
  return (
    <DSection
      title="Правила за цена (по желание)"
      helper="Цени в € (EUR), без ДДС. Обикновено цените на методите горе стигат — отвори това само за по-специални правила."
      info={
        <>
          Цената на всеки начин на доставка се задава горе, в „Методи на доставка“. Тук са{' '}
          <b>общи правила</b>: праг за безплатна доставка, обща такса за опаковка и таблица за цена
          според теглото (ползва се, когато метод е на „Според теглото“).
        </>
      }
    >
      <Collapsible
        title="Покажи правилата за цена"
        hint="Праг за безплатна доставка, цена според теглото или по град."
      >
      <div className="flex flex-col gap-[18px]">
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
          <LvInput
            label="Праг за безплатна доставка"
            value={p.freeThresholdStotinki}
            onChange={(v) => mut((d) => (d.pricing.freeThresholdStotinki = v))}
          />
          <LvInput
            label="Такса за опаковка"
            value={p.packagingFeeStotinki ?? 0}
            onChange={(v) => mut((d) => (d.pricing.packagingFeeStotinki = v))}
          />
        </div>

        <DLabel label="Как се смята цената">
          <Segmented
            value={p.model}
            onChange={(v) => mut((d) => (d.pricing.model = v))}
            options={[
              { value: 'flat', label: 'Една цена' },
              { value: 'byWeight', label: 'Според теглото' },
              { value: 'byZone', label: 'Различни градове' },
            ]}
          />
        </DLabel>

        {p.model === 'flat' && (
          <div className="max-w-[220px]">
            <LvInput
              label="Фиксирана цена"
              value={p.flatFeeStotinki ?? 0}
              onChange={(v) => mut((d) => (d.pricing.flatFeeStotinki = v))}
            />
          </div>
        )}

        {p.model === 'byWeight' && <TierTable cfg={cfg} mut={mut} />}
        {p.model === 'byZone' && <ZoneTable cfg={cfg} mut={mut} />}
      </div>
      </Collapsible>
    </DSection>
  );
}

function TierTable({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const tiers = cfg.pricing.weightTiers ?? [];
  return (
    <div>
      <div className="grid grid-cols-[1fr_1fr_40px] gap-2.5 px-0.5 pb-2 text-[11.5px] font-extrabold uppercase tracking-[0.03em] text-ff-muted">
        <span>До тегло (кг)</span>
        <span>Цена</span>
        <span />
      </div>
      <div className="flex flex-col gap-2">
        {tiers.map((t, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_40px] items-center gap-2.5">
            <input
              value={t.uptoKg}
              inputMode="decimal"
              onChange={(e) =>
                mut((d) => (d.pricing.weightTiers![i].uptoKg = parseFloat(e.target.value) || 0))
              }
              className={fieldCls}
            />
            <div className="relative">
              <input
                value={lvText(t.feeStotinki)}
                inputMode="decimal"
                onChange={(e) => {
                  const n = parseFloat(e.target.value.replace(',', '.'));
                  mut((d) => (d.pricing.weightTiers![i].feeStotinki = isNaN(n) ? 0 : Math.round(n * 100)));
                }}
                className={cn(fieldCls, 'pr-8')}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] font-bold text-ff-muted">
                €
              </span>
            </div>
            <button
              type="button"
              aria-label="Премахни праг"
              onClick={() => mut((d) => d.pricing.weightTiers!.splice(i, 1))}
              className={delBtnCls}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          mut((d) => {
            if (!d.pricing.weightTiers) d.pricing.weightTiers = [];
            d.pricing.weightTiers.push({ uptoKg: 0, feeStotinki: 0 });
          })
        }
        className={addRowCls}
      >
        <Plus size={15} /> Добави праг
      </button>
    </div>
  );
}

function ZoneTable({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const zones = cfg.pricing.zones ?? [];
  return (
    <div>
      <div className="grid grid-cols-[1.6fr_1fr_40px] gap-2.5 px-0.5 pb-2 text-[11.5px] font-extrabold uppercase tracking-[0.03em] text-ff-muted">
        <span>Град / Регион</span>
        <span>Цена</span>
        <span />
      </div>
      <div className="flex flex-col gap-2">
        {zones.map((z, i) => (
          <div key={i} className="grid grid-cols-[1.6fr_1fr_40px] items-center gap-2.5">
            <input
              value={z.region}
              onChange={(e) => mut((d) => (d.pricing.zones![i].region = e.target.value))}
              className={fieldCls}
            />
            <div className="relative">
              <input
                value={lvText(z.feeStotinki)}
                inputMode="decimal"
                onChange={(e) => {
                  const n = parseFloat(e.target.value.replace(',', '.'));
                  mut((d) => (d.pricing.zones![i].feeStotinki = isNaN(n) ? 0 : Math.round(n * 100)));
                }}
                className={cn(fieldCls, 'pr-8')}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] font-bold text-ff-muted">
                €
              </span>
            </div>
            <button
              type="button"
              aria-label="Премахни зона"
              onClick={() => mut((d) => d.pricing.zones!.splice(i, 1))}
              className={delBtnCls}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          mut((d) => {
            if (!d.pricing.zones) d.pricing.zones = [];
            d.pricing.zones.push({ region: '', feeStotinki: 0 });
          })
        }
        className={addRowCls}
      >
        <Plus size={15} /> Добави зона
      </button>
    </div>
  );
}
