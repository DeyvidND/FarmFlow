'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2, Truck, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getTransportPresets, saveTransportPresets } from '@/lib/api-client';
import type { TransportPreset } from '@/lib/types';

/** The В.Транспорт identity fields a preset carries (times stay per-day). */
const PRESET_FIELDS = [
  ['vehicle', 'Возило'],
  ['plate', 'Рег. №'],
  ['driverName', 'Шофьор'],
  ['startPlace', 'Тръгва от'],
] as const;

type PresetField = (typeof PRESET_FIELDS)[number][0];

/** One-line display label for a preset in the select / manage list. */
function presetLabel(p: TransportPreset): string {
  return [p.vehicle, p.plate, p.driverName].filter(Boolean).join(' · ') || p.startPlace || '—';
}

/**
 * „Запазени транспорти" for the consolidated protocol's В.Транспорт form
 * (2026-07-23): a select that fills the form from a saved transport, plus a
 * manage modal that adds/deletes presets — so the operator stops retyping the
 * same vehicle/driver on every обобщен протокол. `current` lets „Запази
 * текущия" turn what's already typed into a preset in one tap. The server
 * stores the WHOLE list (tenants.settings.transportPresets) — every save
 * sends the full array.
 */
export function TransportPresetPicker({
  current,
  onApply,
  disabled,
}: {
  current: Pick<TransportPreset, PresetField>;
  onApply: (preset: TransportPreset) => void;
  disabled?: boolean;
}) {
  const [presets, setPresets] = useState<TransportPreset[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<PresetField, string>>({
    vehicle: '',
    plate: '',
    driverName: '',
    startPlace: '',
  });

  useEffect(() => {
    let alive = true;
    getTransportPresets()
      .then((list) => {
        if (alive) setPresets(list);
      })
      .catch(() => {
        if (alive) setPresets([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function persist(next: TransportPreset[]): Promise<void> {
    setSaving(true);
    try {
      const stored = await saveTransportPresets(next);
      setPresets(stored);
    } catch {
      toast.error('Транспортите не бяха запазени');
    } finally {
      setSaving(false);
    }
  }

  /** Save what's already typed in the В form as a new preset. */
  async function saveCurrent() {
    const entry: TransportPreset = { id: '' };
    for (const [f] of PRESET_FIELDS) {
      const v = current[f]?.trim();
      if (v) entry[f] = v;
    }
    if (!entry.vehicle && !entry.plate && !entry.driverName && !entry.startPlace) {
      toast.error('Формата за транспорт е празна — няма какво да се запази');
      return;
    }
    await persist([...(presets ?? []), entry]);
    toast.success('Транспортът е запазен');
  }

  async function addDraft() {
    const entry: TransportPreset = { id: '' };
    for (const [f] of PRESET_FIELDS) {
      const v = draft[f].trim();
      if (v) entry[f] = v;
    }
    if (!entry.vehicle && !entry.plate && !entry.driverName && !entry.startPlace) return;
    await persist([...(presets ?? []), entry]);
    setDraft({ vehicle: '', plate: '', driverName: '', startPlace: '' });
  }

  async function remove(id: string) {
    await persist((presets ?? []).filter((p) => p.id !== id));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Truck size={15} className="shrink-0 text-ff-muted" />
      <select
        className="min-w-0 flex-1 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-semibold"
        value=""
        disabled={disabled || !presets?.length}
        aria-label="Избери запазен транспорт"
        onChange={(e) => {
          const preset = presets?.find((p) => p.id === e.target.value);
          if (preset) onApply(preset);
        }}
      >
        <option value="">
          {presets == null
            ? 'Зареждане…'
            : presets.length
              ? 'Избери запазен транспорт…'
              : 'Няма запазени транспорти'}
        </option>
        {(presets ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {presetLabel(p)}
          </option>
        ))}
      </select>
      <Button variant="ghost" size="sm" disabled={disabled || saving} onClick={() => void saveCurrent()}>
        Запази текущия
      </Button>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        Транспорти
      </Button>

      {open && (
        <div
          className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Запазени транспорти"
          >
            <div className="flex items-center justify-between border-b border-ff-border-2 px-5 py-3">
              <h3 className="text-[14px] font-extrabold">Запазени транспорти</h3>
              <button aria-label="Затвори" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              {(presets ?? []).length === 0 && (
                <p className="py-3 text-[13px] text-ff-muted">Нямаш запазени транспорти още.</p>
              )}
              {(presets ?? []).map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 border-b border-ff-border-2 py-2.5 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-bold">{presetLabel(p)}</div>
                    {p.startPlace && (
                      <div className="truncate text-[12px] text-ff-muted">Тръгва от: {p.startPlace}</div>
                    )}
                  </div>
                  <button
                    aria-label={`Изтрий ${presetLabel(p)}`}
                    className="shrink-0 text-ff-muted hover:text-ff-red"
                    disabled={saving}
                    onClick={() => void remove(p.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}

              <div className="mt-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
                <div className="mb-2 text-[12.5px] font-extrabold text-ff-muted">Нов транспорт</div>
                <div className="grid grid-cols-2 gap-2">
                  {PRESET_FIELDS.map(([f, label]) => (
                    <label key={f} className="text-[12px] font-semibold text-ff-muted">
                      {label}
                      <input
                        className="mt-1 block w-full rounded-lg border border-ff-border px-2.5 py-1.5 text-[13px]"
                        value={draft[f]}
                        onChange={(e) => setDraft({ ...draft, [f]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  disabled={saving}
                  onClick={() => void addDraft()}
                >
                  <Plus size={14} /> Добави
                </Button>
              </div>
            </div>

            <div className="border-t border-ff-border-2 px-5 py-3">
              <Button variant="primary" className="w-full" onClick={() => setOpen(false)}>
                Готово
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
