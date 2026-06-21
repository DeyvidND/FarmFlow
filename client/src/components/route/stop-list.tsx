'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Crosshair,
  Mail,
  MapPin,
  Navigation,
  Phone,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { setStopLocation } from '@/lib/api-client';
import { cn, hhmm } from '@/lib/utils';
import type { RouteStop } from '@/lib/types';

interface StopListProps {
  stops: RouteStop[];
  activeId: string | null;
  onPick: (id: string) => void;
  onOpenMaps: (stop: RouteStop) => void;
  onCall: (stop: RouteStop) => void;
  onEmail: (stop: RouteStop) => void;
  /** A stop's location was fixed — re-fetch the route. */
  onFixed: () => void;
  /** The stop currently waiting for a map click to drop a manual pin. */
  placingId: string | null;
  /** Enter "click the map to place this stop" mode. */
  onStartPlace: (id: string) => void;
  /** Leave map-placing mode. */
  onCancelPlace: () => void;
}

/** A stop is "on the map" only when it has been geocoded (has both coords). */
const isLocated = (s: RouteStop) => s.lat != null && s.lng != null;

/** Copy-to-clipboard contact value with a brief "copied" tick + toast. */
function CopyLine({
  icon,
  value,
  href,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  href: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} копиран`);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error('Копирането не успя');
    }
  };
  return (
    <div className="flex items-center gap-[5px] text-[13px] text-ff-ink-2">
      <span className="shrink-0 text-ff-muted">{icon}</span>
      {/* the value itself is a tap-to-call / tap-to-mail link AND selectable text */}
      <a
        href={href}
        onClick={(e) => e.stopPropagation()}
        className="truncate font-semibold text-ff-green-800 hover:underline"
        title={value}
      >
        {value}
      </a>
      <button
        onClick={copy}
        title={`Копирай ${label.toLowerCase()}`}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ff-muted transition hover:bg-ff-surface-2 hover:text-ff-ink-2"
      >
        {copied ? <Check size={13} className="text-ff-green-700" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

/**
 * Inline fixer for a stop with no map pin. The farmer either types a corrected
 * address (re-geocoded server-side) or drops a manual pin by clicking the map.
 * The original (not-found) address is shown so they know what failed.
 */
function FixLocation({
  stop,
  placing,
  onFixed,
  onStartPlace,
  onCancelPlace,
}: {
  stop: RouteStop;
  placing: boolean;
  onFixed: () => void;
  onStartPlace: () => void;
  onCancelPlace: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [addr, setAddr] = useState(stop.address ?? '');
  const [saving, setSaving] = useState(false);

  // When map-placing is active, surface the live instruction even if the panel
  // wasn't expanded (the farmer started placing from elsewhere).
  const expanded = open || placing;

  async function findByAddress(e: React.MouseEvent) {
    e.stopPropagation();
    const query = addr.trim();
    if (!query) {
      toast.error('Въведи адрес');
      return;
    }
    setSaving(true);
    try {
      await setStopLocation(stop.id, { address: query });
      toast.success('Адресът е намерен и поставен на картата');
      setOpen(false);
      onFixed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Адресът не е намерен');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
      {!expanded ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ff-amber-soft bg-ff-amber-softer px-2.5 py-1.5 text-[12px] font-bold text-ff-amber-600 transition hover:brightness-95"
        >
          <Crosshair size={13} /> Намери / постави на картата
        </button>
      ) : (
        <div className="rounded-lg border border-ff-border bg-ff-surface-2 p-2.5">
          <div className="mb-1.5 text-[11.5px] text-ff-muted">
            Търсен адрес: <span className="font-semibold text-ff-ink-2">{stop.address ?? '—'}</span>
          </div>

          {placing ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-bold text-ff-amber-600">
                Кликни на картата, за да поставиш пина.
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCancelPlace();
                }}
                className="inline-flex items-center gap-1 rounded-md border border-ff-border bg-ff-surface px-2 py-1 text-[12px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2"
              >
                <X size={12} /> Отказ
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  value={addr}
                  onChange={(e) => setAddr(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="по-точен адрес"
                  className="min-w-0 flex-1 rounded-md border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-ff-green-500"
                />
                <button
                  onClick={findByAddress}
                  disabled={saving}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-ff-green-100 px-2.5 py-1.5 text-[12.5px] font-bold text-ff-green-800 transition hover:brightness-95 disabled:opacity-50"
                >
                  <Search size={13} /> {saving ? 'Търси…' : 'Намери'}
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartPlace();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-ff-border bg-ff-surface px-2 py-1 text-[12px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2"
                >
                  <Crosshair size={12} /> Постави на картата
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                  }}
                  className="text-[12px] font-bold text-ff-muted transition hover:text-ff-ink-2"
                >
                  Затвори
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function StopList({
  stops,
  activeId,
  onPick,
  onOpenMaps,
  onCall,
  onEmail,
  onFixed,
  placingId,
  onStartPlace,
  onCancelPlace,
}: StopListProps) {
  if (stops.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-14 text-center text-ff-muted">
        <div className="mb-3 grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-ff-green-50 text-ff-green-600">
          <Navigation size={26} />
        </div>
        <div className="text-[15px] font-bold text-ff-ink-2">Няма спирки за този ден</div>
        <div className="mt-0.5 text-[13.5px]">Потвърдените поръчки с доставка до адрес се появяват тук.</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {stops.map((s, i) => {
        const on = activeId === s.id;
        const slot = s.slotFrom && s.slotTo ? `${hhmm(s.slotFrom)} – ${hhmm(s.slotTo)}` : null;
        const located = isLocated(s);
        return (
          <div
            key={s.id}
            onClick={() => onPick(s.id)}
            data-on={on}
            className={cn(
              'flex cursor-pointer gap-[13px] border-b border-ff-border-2 px-[18px] py-3.5 transition-colors',
              on ? 'bg-ff-green-50' : 'hover:bg-ff-surface-2',
            )}
          >
            {/* number bead + connector */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13.5px] font-extrabold',
                  on ? 'bg-ff-green-700 text-white' : 'bg-ff-green-100 text-ff-green-800',
                )}
              >
                {i + 1}
              </span>
              {i < stops.length - 1 && <span className="mt-1 min-h-[14px] w-0.5 flex-1 bg-ff-border" />}
            </div>

            {/* details */}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[14.5px] font-bold">{s.customer ?? 'Клиент'}</div>
                <div className="flex shrink-0 gap-[7px]">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenMaps(s);
                    }}
                    title="Отвори в Google Maps"
                    className="grid h-8 w-8 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                  >
                    <Navigation size={16} />
                  </button>
                  {/* Call shows ONLY when there's a phone — no dead button */}
                  {s.phone && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCall(s);
                      }}
                      title={`Обади се на ${s.phone}`}
                      className="grid h-8 w-8 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                    >
                      <Phone size={16} />
                    </button>
                  )}
                  {s.email && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onEmail(s);
                      }}
                      title={`Имейл до ${s.email}`}
                      className="grid h-8 w-8 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                    >
                      <Mail size={16} />
                    </button>
                  )}
                </div>
              </div>

              {/* address + "not on the map" guard flag for un-geocoded stops */}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ff-ink-2">
                <span className="flex min-w-0 items-center gap-[5px]">
                  <MapPin size={14} className="shrink-0" />
                  <span className="truncate">{s.address ?? 'Няма адрес'}</span>
                </span>
                {s.note && (
                  <span className="w-full pl-[19px] text-[12px] text-ff-muted">{s.note}</span>
                )}
                {!located && (
                  <span
                    title="Адресът не е намерен на картата — няма пин. Провери адреса или се обади на клиента."
                    className="inline-flex items-center gap-1 rounded-md border border-ff-amber-soft bg-ff-amber-softer px-1.5 py-0.5 text-[11px] font-bold text-ff-amber-600"
                  >
                    <AlertTriangle size={11} /> не е на картата
                  </span>
                )}
              </div>

              {/* full reachable contact info — visible & copyable, not just icons */}
              <div className="mt-1.5 flex flex-col gap-1">
                {s.phone ? (
                  <CopyLine
                    icon={<Phone size={13} />}
                    value={s.phone}
                    href={`tel:${s.phone.replace(/\s+/g, '')}`}
                    label="Телефон"
                  />
                ) : (
                  <div className="flex items-center gap-[5px] text-[12.5px] text-ff-muted">
                    <Phone size={13} /> няма телефон
                  </div>
                )}
                {s.email ? (
                  <CopyLine
                    icon={<Mail size={13} />}
                    value={s.email}
                    href={`mailto:${s.email}`}
                    label="Имейл"
                  />
                ) : (
                  <div className="flex items-center gap-[5px] text-[12.5px] text-ff-muted">
                    <Mail size={13} /> няма имейл
                  </div>
                )}
              </div>

              {/* un-geocoded stop → let the farmer fix it (re-geocode or pin) */}
              {!located && (
                <FixLocation
                  stop={s}
                  placing={placingId === s.id}
                  onFixed={onFixed}
                  onStartPlace={() => onStartPlace(s.id)}
                  onCancelPlace={onCancelPlace}
                />
              )}

              <div className="mt-1.5 text-[12.5px] text-ff-muted">
                {s.summary}
                {slot && (
                  <>
                    {' · '}
                    <span className="font-semibold">{slot}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
