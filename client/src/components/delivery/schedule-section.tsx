'use client';

import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Button } from '@/components/ui/button';
import { WEEKDAYS } from '@/lib/delivery-data';
import type { DeliveryConfig } from '@/lib/types';
import { DSection, DLabel, Stepper, fieldCls } from './ui';

type Mut = (fn: (d: DeliveryConfig) => void) => void;

const MONTHS = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
const fmtDate = (iso: string) => {
  const [y, m, dd] = iso.split('-');
  return `${+dd} ${MONTHS[+m - 1]} ${y}`;
};

export function ScheduleSection({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const s = cfg.schedule;
  const [newDate, setNewDate] = React.useState('');

  const toggleDay = (i: number) =>
    mut((d) => {
      const w = d.schedule.weekdays;
      const idx = w.indexOf(i);
      if (idx >= 0) w.splice(idx, 1);
      else w.push(i);
    });

  const addBlackout = () => {
    if (!newDate) return;
    mut((d) => {
      if (!d.schedule.blackout.includes(newDate)) d.schedule.blackout.push(newDate);
      d.schedule.blackout.sort();
    });
    setNewDate('');
  };

  return (
    <DSection
      title="График и наличност"
      helper="Кога приемаш и обработваш поръчки за доставка."
      info={
        <>
          Тук казваш <b>в кои дни работиш</b> с доставки. „Час на прекъсване“ значи: ако клиент поръча
          след този час, поръчката тръгва на следващия работен ден. Блокирай дати, в които почиваш
          (празници, отпуска).
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        <DLabel label="Работни дни">
          <div className="flex flex-wrap gap-[7px]">
            {WEEKDAYS.map((d) => {
              const on = s.weekdays.includes(d.i);
              return (
                <button
                  key={d.i}
                  type="button"
                  onClick={() => toggleDay(d.i)}
                  className={cn(
                    'h-10 w-[46px] rounded-[10px] border text-[13.5px] font-extrabold transition-colors',
                    on
                      ? 'border-ff-green-700 bg-ff-green-700 text-white'
                      : 'border-ff-border bg-ff-surface-2 text-ff-ink-2 hover:bg-ff-green-50',
                  )}
                >
                  {d.l}
                </button>
              );
            })}
          </div>
        </DLabel>

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          <DLabel label="Час на прекъсване (cutoff)" hint="Поръчки след този час тръгват на следващия ден.">
            <input
              type="time"
              value={s.cutoffTime}
              onChange={(e) => mut((d) => (d.schedule.cutoffTime = e.target.value))}
              className={fieldCls}
            />
          </DLabel>
          <DLabel label="Срок за обработка (дни)">
            <Stepper value={s.leadDays} onChange={(v) => mut((d) => (d.schedule.leadDays = v))} min={0} max={14} />
          </DLabel>
          <DLabel label="Макс. поръчки на ден">
            <Stepper value={s.maxPerDay} onChange={(v) => mut((d) => (d.schedule.maxPerDay = v))} min={1} max={500} />
          </DLabel>
          <div className="flex items-center justify-between px-0.5">
            <div>
              <div className="text-[13.5px] font-bold text-ff-ink">Доставка в същия ден</div>
              <div className="mt-0.5 text-[12px] text-ff-muted">Преди cutoff часа</div>
            </div>
            <ToggleSwitch checked={s.sameDay} onChange={(v) => mut((d) => (d.schedule.sameDay = v))} />
          </div>
        </div>

        <DLabel label="Блокирани дати" hint="Дни, в които не се доставя (напр. празници).">
          <div className="flex flex-wrap items-center gap-2">
            {s.blackout.length === 0 && (
              <span className="text-[13px] text-ff-muted">Няма блокирани дати.</span>
            )}
            {s.blackout.map((iso) => (
              <span
                key={iso}
                className="inline-flex items-center gap-1.5 rounded-full border border-ff-border bg-ff-surface-2 py-1.5 pl-3 pr-2 text-[13px] font-bold text-ff-ink-2"
              >
                {fmtDate(iso)}
                <button
                  type="button"
                  onClick={() =>
                    mut((d) => (d.schedule.blackout = d.schedule.blackout.filter((x) => x !== iso)))
                  }
                  aria-label="Премахни"
                  className="grid h-5 w-5 place-items-center rounded-full bg-ff-border-2 text-ff-muted hover:text-ff-red"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className={cn(fieldCls, 'w-auto px-2.5 py-1.5')}
              />
              <Button variant="soft" size="sm" onClick={addBlackout}>
                <Plus size={15} /> Добави
              </Button>
            </span>
          </div>
        </DLabel>
      </div>
    </DSection>
  );
}
