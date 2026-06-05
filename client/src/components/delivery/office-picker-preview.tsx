'use client';

import * as React from 'react';
import { APIProvider, Map, AdvancedMarker, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { MapPin, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listEcontOffices } from '@/lib/api-client';
import type { EcontCity, EcontOfficeLive } from '@/lib/types';
import { DSection, CityAutocomplete } from './ui';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
// Reserved demo map id — renders AdvancedMarkers without cloud map styling.
const MAP_ID = 'DEMO_MAP_ID';

/**
 * Live Econt office map. The farm picks a town and sees the real Econt offices
 * there on a Google map — the same offices a customer chooses from at checkout.
 * Pulls live nomenclature (requires a connected Econt account).
 */
export function OfficePickerPreview({ configured }: { configured: boolean }) {
  const [city, setCity] = React.useState<EcontCity | null>(null);
  const [offices, setOffices] = React.useState<EcontOfficeLive[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [picked, setPicked] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!city) {
      setOffices([]);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    listEcontOffices(city.id)
      .then((r) => {
        if (!active) return;
        setOffices(r);
        setPicked(r[0]?.code ?? '');
      })
      .catch((e: unknown) => {
        if (!active) return;
        setOffices([]);
        setErr(e instanceof Error ? e.message : 'Неуспешно зареждане на офисите');
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [city]);

  const located = offices.filter((o) => o.lat != null && o.lng != null);
  const pickedOffice = offices.find((o) => o.code === picked) ?? null;

  return (
    <DSection
      title="Офиси на Еконт на картата"
      helper="Избери град и виж реалните офиси на Еконт там — същите, които клиентът избира при поръчка."
      info={
        <>
          Тук проверяваш <b>дали клиентите ти имат удобен офис наблизо</b>. Данните идват на живо от
          Еконт — нищо не се настройва оттук.
        </>
      }
    >
      {!configured ? (
        <Note>Свържи и провери Еконт акаунта по-горе, за да заредиш офисите на картата.</Note>
      ) : (
        <>
          <div className="mb-4 max-w-[360px]">
            <CityAutocomplete value={city?.name ?? ''} placeholder="Избери град…" onPick={setCity} />
          </div>

          <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
            {/* office list */}
            <div className="flex max-h-[360px] min-h-[320px] flex-col overflow-y-auto rounded-xl border border-ff-border bg-ff-surface-2">
              {!city ? (
                <Empty msg="Избери град горе, за да заредиш офисите." />
              ) : loading ? (
                <Empty msg="Зареждане на офиси…" />
              ) : err ? (
                <Empty msg={err} />
              ) : offices.length === 0 ? (
                <Empty msg={`Няма офиси на Еконт в „${city.name}“.`} />
              ) : (
                offices.map((o) => (
                  <button
                    key={o.code}
                    type="button"
                    onClick={() => setPicked(o.code)}
                    className={cn(
                      'flex w-full gap-3 border-b border-ff-border-2 px-3.5 py-3 text-left transition-colors',
                      picked === o.code ? 'bg-ff-green-50' : 'hover:bg-ff-surface',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2',
                        picked === o.code ? 'border-ff-green-600' : 'border-ff-muted-2',
                      )}
                    >
                      {picked === o.code && <span className="h-[9px] w-[9px] rounded-full bg-ff-green-600" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-extrabold text-ff-ink">{o.name}</div>
                      {o.address && <div className="mt-px text-[12.5px] text-ff-ink-2">{o.address}</div>}
                      {o.hours && <div className="mt-1 text-[12px] text-ff-muted">{o.hours}</div>}
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* map */}
            <div className="relative min-h-[320px] overflow-hidden rounded-xl border border-ff-border bg-[#E9E7DF]">
              {MAPS_KEY && located.length > 0 ? (
                <APIProvider apiKey={MAPS_KEY} language="bg" region="BG">
                  <Map
                    mapId={MAP_ID}
                    defaultCenter={{ lat: located[0].lat as number, lng: located[0].lng as number }}
                    defaultZoom={12}
                    gestureHandling="greedy"
                    disableDefaultUI={false}
                    style={{ width: '100%', height: '100%' }}
                  >
                    <FitBounds offices={located} />
                    <PanTo office={pickedOffice} />
                    {located.map((o) => (
                      <AdvancedMarker
                        key={o.code}
                        position={{ lat: o.lat as number, lng: o.lng as number }}
                        title={o.name}
                        onClick={() => setPicked(o.code)}
                      >
                        <OfficePin active={picked === o.code} />
                      </AdvancedMarker>
                    ))}
                  </Map>
                </APIProvider>
              ) : (
                <MapEmpty
                  text={
                    !MAPS_KEY
                      ? 'Липсва Google Maps ключ'
                      : !city
                        ? 'Избери град, за да видиш офисите'
                        : loading
                          ? 'Зареждане…'
                          : 'Няма координати за офисите в този град'
                  }
                />
              )}
            </div>
          </div>
        </>
      )}
    </DSection>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="grid flex-1 place-items-center p-5 text-center text-[13px] text-ff-muted">{msg}</div>;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-ff-border-2 bg-ff-surface-2 px-4 py-3.5 text-[13.5px] text-ff-ink-2">
      <Link2 size={18} className="shrink-0 text-ff-green-600" />
      {children}
    </div>
  );
}

function MapEmpty({ text }: { text: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-2 text-ff-muted">
        <MapPin size={26} />
        <span className="text-[13px] font-semibold">{text}</span>
      </div>
    </div>
  );
}

/** Teardrop office pin (amber when selected). */
function OfficePin({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'grid h-[26px] w-[26px] place-items-center rounded-[50%_50%_50%_2px] shadow-[0_4px_10px_rgba(0,0,0,0.25)]',
        active ? 'bg-ff-amber' : 'bg-ff-green-700',
      )}
      style={{ transform: 'rotate(45deg)' }}
    >
      <span style={{ transform: 'rotate(-45deg)' }} className={cn('h-[8px] w-[8px] rounded-full', active ? 'bg-[#3a2a08]' : 'bg-white')} />
    </span>
  );
}

/** Fit the viewport to all located offices. */
function FitBounds({ offices }: { offices: EcontOfficeLive[] }) {
  const map = useMap();
  const core = useMapsLibrary('core');
  React.useEffect(() => {
    if (!map || !core || offices.length === 0) return;
    if (offices.length === 1) {
      map.setCenter({ lat: offices[0].lat as number, lng: offices[0].lng as number });
      map.setZoom(14);
      return;
    }
    const bounds = new core.LatLngBounds();
    offices.forEach((o) => bounds.extend({ lat: o.lat as number, lng: o.lng as number }));
    map.fitBounds(bounds, 56);
  }, [map, core, offices]);
  return null;
}

/** Pan to the office picked in the list. */
function PanTo({ office }: { office: EcontOfficeLive | null }) {
  const map = useMap();
  React.useEffect(() => {
    if (!map || !office || office.lat == null || office.lng == null) return;
    map.panTo({ lat: office.lat, lng: office.lng });
  }, [map, office]);
  return null;
}
