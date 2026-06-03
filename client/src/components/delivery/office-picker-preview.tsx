'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ECONT_OFFICES } from '@/lib/delivery-data';
import { DSection, fieldCls } from './ui';

export function OfficePickerPreview() {
  const offices = ECONT_OFFICES;
  const [q, setQ] = React.useState('Варна');
  const [picked, setPicked] = React.useState(offices[0]?.code ?? '');
  const filtered = offices.filter(
    (o) =>
      o.cityName.toLowerCase().includes(q.toLowerCase()) ||
      o.name.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <DSection
      title="Преглед: избор на офис"
      helper="Така изглежда изборът на офис за клиента при поръчка."
      info={
        <>
          Това е само <b>за твоя информация</b> — показва как клиентът избира офис на Еконт, когато
          прави поръчка. Нищо не се променя оттук.
        </>
      }
    >
      <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
        {/* office list */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-ff-border bg-ff-surface-2">
          <div className="border-b border-ff-border-2 bg-ff-surface p-3">
            <div className="relative">
              <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-ff-muted" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Търси град…"
                className={cn(fieldCls, 'pl-9')}
              />
            </div>
          </div>
          <div className="max-h-[320px] flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="p-5 text-center text-[13px] text-ff-muted">Няма офиси за „{q}“.</div>
            )}
            {filtered.map((o) => {
              const on = picked === o.code;
              return (
                <button
                  key={o.code}
                  type="button"
                  onClick={() => setPicked(o.code)}
                  className={cn(
                    'flex w-full gap-3 border-b border-ff-border-2 px-3.5 py-3 text-left transition-colors',
                    on ? 'bg-ff-green-50' : 'hover:bg-ff-surface',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2',
                      on ? 'border-ff-green-600' : 'border-ff-muted-2',
                    )}
                  >
                    {on && <span className="h-[9px] w-[9px] rounded-full bg-ff-green-600" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-extrabold text-ff-ink">{o.name}</div>
                    <div className="mt-px text-[12.5px] text-ff-ink-2">{o.address}</div>
                    <div className="mt-1 text-[12px] text-ff-muted">{o.workingHours}</div>
                  </div>
                  {o.dist && (
                    <span className="shrink-0 text-[12px] font-bold text-ff-muted">{o.dist}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* map placeholder */}
        <div className="relative min-h-[300px] overflow-hidden rounded-xl border border-ff-border bg-[#E9E7DF]">
          <svg width="100%" height="100%" className="absolute inset-0">
            <defs>
              <pattern id="ff-dgrid" width="42" height="42" patternUnits="userSpaceOnUse">
                <path d="M42 0H0V42" fill="none" stroke="#D8D5CA" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#ff-dgrid)" />
            <path d="M-20 90 Q 180 60 380 140 T 800 180" fill="none" stroke="#D2CFC3" strokeWidth="10" strokeLinecap="round" />
            <path d="M120 -20 Q 170 180 120 420 T 240 800" fill="none" stroke="#D2CFC3" strokeWidth="8" strokeLinecap="round" />
          </svg>
          <span className="absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-full">
            <span className="block h-[30px] w-[30px] rotate-45 rounded-[50%_50%_50%_2px] bg-ff-green-700 shadow-[0_4px_10px_rgba(0,0,0,0.25)]" />
          </span>
          <div className="absolute bottom-3 left-3 select-none text-[18px] font-bold text-[#9A9788]">
            Google Maps
          </div>
          <div className="absolute right-3 top-3 rounded-[9px] bg-white/85 px-2.5 py-1.5 text-[12px] font-bold text-ff-ink-2 shadow-ff-sm">
            Така изглежда изборът за клиента
          </div>
        </div>
      </div>
    </DSection>
  );
}
