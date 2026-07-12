'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { MapPin, MapPinOff, Check, FlaskConical, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProducerMapPoint, ProducersMapResult } from '@/lib/api-client';

/** Loaded once by the browser build, baked in at image-build time (see
 *  `.github/workflows/deploy.yml` — FF_MAPS_BROWSER_KEY). Empty in local dev
 *  and in any build that doesn't pass it, in which case the page falls back
 *  to the table below. No `@types/google.maps` — this app doesn't depend on
 *  the Maps JS package, so `window.google` is typed loosely. */
declare global {
  interface Window {
    google?: any;
  }
}

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const BG_CENTER = { lat: 42.7, lng: 25.5 };
const BG_ZOOM = 7;
const SCRIPT_ID = 'ff-google-maps-js';

/** Loads the Google Maps JS API exactly once per page — safe to call from
 *  multiple mounts (React strict-mode double-effect, HMR) since it checks
 *  both `window.google.maps` and an in-flight `<script>` tag before
 *  injecting a new one. */
function loadGoogleMaps(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve();
      return;
    }
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Google Maps script failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=bg&region=BG`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google Maps script failed to load'));
    document.head.appendChild(script);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Imperative Maps init — one marker per located producer, click → info window
 *  with name / tenant / city / tier. Plain `Marker`/`InfoWindow` (no Advanced
 *  Markers, which need a Map ID we don't have configured for this app). */
function initMap(el: HTMLDivElement, points: ProducerMapPoint[]) {
  const g = window.google;
  const map = new g.maps.Map(el, {
    center: BG_CENTER,
    zoom: BG_ZOOM,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });
  if (!points.length) return map;

  const bounds = new g.maps.LatLngBounds();
  const infoWindow = new g.maps.InfoWindow();

  points.forEach((p) => {
    const position = { lat: p.lat as number, lng: p.lng as number };
    bounds.extend(position);
    const marker = new g.maps.Marker({ position, map, title: p.name });
    marker.addListener('click', () => {
      infoWindow.setContent(
        `<div style="font-family:inherit;min-width:170px;padding:2px 0">
           <div style="font-weight:700;font-size:13.5px;color:#1a1a1a">${escapeHtml(p.name)}</div>
           <div style="font-size:12.5px;color:#555;margin-top:2px">${escapeHtml(p.tenantName)}</div>
           <div style="font-size:12px;color:#888;margin-top:2px">${escapeHtml(p.city ?? 'няма град')} · тиър ${p.tier}</div>
         </div>`,
      );
      infoWindow.open(map, marker);
    });
  });

  if (points.length === 1) {
    map.setCenter(bounds.getCenter());
    map.setZoom(12);
  } else {
    map.fitBounds(bounds, 48);
  }
  return map;
}

function TierBadge({ tier, tint }: { tier: number; tint: string | null }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-bold text-white"
      style={{ backgroundColor: tint ?? '#6b7280' }}
    >
      тиър {tier}
    </span>
  );
}

export function ProducersMapClient({ initial }: { initial: ProducersMapResult }) {
  const { producers, withLocation, withoutLocation, mapsEnabled } = initial;
  const located = producers.filter((p): p is ProducerMapPoint & { lat: number; lng: number } => p.lat != null && p.lng != null);
  const canRenderMap = mapsEnabled && !!MAPS_KEY && located.length > 0;

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const [mapState, setMapState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!canRenderMap) return;
    let cancelled = false;
    setMapState('loading');
    loadGoogleMaps(MAPS_KEY)
      .then(() => {
        if (cancelled || !mapElRef.current) return;
        initMap(mapElRef.current, located);
        setMapState('ready');
      })
      .catch(() => {
        if (!cancelled) setMapState('error');
      });
    return () => {
      cancelled = true;
    };
    // Re-init only when the point set actually changes (SSR data is fixed per
    // page load, so in practice this runs once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRenderMap]);

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Карта на производители</h1>
          <p className="mt-0.5 text-[13.5px] text-ff-muted">
            За логистика · {producers.length} общо · {withLocation} с локация
            {withoutLocation > 0 && ` · ${withoutLocation} производителя без локация`}
          </p>
        </div>
      </div>

      {canRenderMap ? (
        <div className="mt-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <div className="relative h-[480px] w-full">
            <div ref={mapElRef} className="absolute inset-0" />
            {mapState !== 'ready' && (
              <div className="absolute inset-0 grid place-items-center bg-ff-surface-2">
                <p className="text-[13.5px] font-semibold text-ff-muted">
                  {mapState === 'error' ? 'Картата не успя да се зареди.' : 'Зареждане на картата…'}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-ff-border bg-ff-surface-2 p-4 shadow-ff-sm">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ff-surface text-ff-muted-2">
            <MapPinOff size={19} />
          </span>
          <p className="text-[13.5px] text-ff-muted">
            {!mapsEnabled || !MAPS_KEY
              ? 'Google Maps не е конфигуриран за тази среда — по-долу е списъкът с всички производители.'
              : 'Няма производители с геолокация все още — по-долу е списъкът с всички.'}
          </p>
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {['Производител', 'Ферма', 'Град', 'Тиър', 'Локация'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-4 py-3 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {producers.map((p) => {
                const hasLocation = p.lat != null && p.lng != null;
                return (
                  <tr key={p.id} className="border-b border-ff-border-2 align-top last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        href={`/producers/${p.id}`}
                        className="inline-flex items-center gap-1 text-[13.5px] font-bold text-ff-ink no-underline hover:text-ff-green-700 hover:underline"
                      >
                        {p.name}
                        <ChevronRight size={14} className="text-ff-muted-2" />
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[13px] font-bold text-ff-green-700">{p.tenantName}</span>
                      {p.isDemo && (
                        <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-ff-demo-soft px-2 py-0.5 text-[11px] font-bold text-ff-demo">
                          <FlaskConical size={10} /> ДЕМО
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ff-ink-2">{p.city ?? '—'}</td>
                    <td className="px-4 py-3">
                      <TierBadge tier={p.tier} tint={p.tint} />
                    </td>
                    <td className="px-4 py-3">
                      {hasLocation ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-50 px-2 py-0.5 text-[11.5px] font-bold text-ff-green-700">
                          <Check size={11} /> на картата
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-ff-surface-2 px-2 py-0.5 text-[11.5px] font-bold text-ff-muted-2">
                          <MapPin size={11} /> без локация
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {producers.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-ff-muted">Все още няма производители.</p>
        )}
      </div>
    </div>
  );
}
