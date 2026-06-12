'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { eur } from '@/lib/utils';
import type { TimeseriesBucket, TimeseriesPoint } from '@/lib/api-client';

const H = 240; // chart height (px)
const PAD = { t: 14, r: 10, b: 24, l: 10 };

const BG_MONTHS = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];

/** Bucket key → short axis/tooltip label. */
function labelFor(t: string, bucket: TimeseriesBucket): string {
  if (bucket === 'month') {
    const [y, m] = t.split('-');
    return `${BG_MONTHS[Number(m) - 1]} ${y.slice(2)}`;
  }
  // day / week keys are 'YYYY-MM-DD'
  const [, m, d] = t.split('-');
  return `${d}.${m}`;
}

export function TrendChart({
  points,
  bucket,
  metric,
}: {
  points: TimeseriesPoint[];
  bucket: TimeseriesBucket;
  metric: 'orders' | 'revenue';
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vals = useMemo(
    () => points.map((p) => (metric === 'orders' ? p.orders : p.revenueStotinki)),
    [points, metric],
  );

  const fmt = (v: number) => (metric === 'orders' ? String(v) : eur(v));

  const innerW = Math.max(1, w - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;
  const n = points.length;
  const maxV = Math.max(1, ...vals); // never divide by zero; flat-zero series → baseline
  const stepX = n > 1 ? innerW / (n - 1) : 0;
  const x = (i: number) => PAD.l + (n > 1 ? i * stepX : innerW / 2);
  const y = (v: number) => PAD.t + (1 - v / maxV) * innerH;
  const baseY = PAD.t + innerH;

  const linePath = useMemo(() => {
    if (n === 0) return '';
    return vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, w, n, maxV]);

  const areaPath = useMemo(() => {
    if (n === 0) return '';
    return `M${x(0).toFixed(1)},${baseY} ${vals
      .map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ')} L${x(n - 1).toFixed(1)},${baseY} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, w, n, maxV]);

  // X labels: ~6 evenly spaced ticks.
  const tickEvery = Math.max(1, Math.ceil(n / 6));
  const total = useMemo(() => vals.reduce((a, b) => a + b, 0), [vals]);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w; // back to viewBox units
    const i = n > 1 ? Math.round((px - PAD.l) / stepX) : 0;
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  const hv = hover != null ? vals[hover] : null;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${w} ${H}`}
        width="100%"
        height={H}
        className="block touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="ff-trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ff-green-500)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--ff-green-500)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* horizontal gridlines + max label */}
        {[0, 0.5, 1].map((f) => {
          const gy = PAD.t + f * innerH;
          return (
            <line
              key={f}
              x1={PAD.l}
              x2={w - PAD.r}
              y1={gy}
              y2={gy}
              stroke="var(--ff-border-2)"
              strokeWidth={1}
            />
          );
        })}
        <text x={PAD.l + 2} y={PAD.t - 3} fontSize="11" fontWeight={700} fill="var(--ff-muted-2)">
          {fmt(maxV)}
        </text>

        {areaPath && <path d={areaPath} fill="url(#ff-trend-fill)" />}
        {linePath && (
          <path d={linePath} fill="none" stroke="var(--ff-green-600)" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
        )}

        {/* x-axis labels */}
        {points.map((p, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text
              key={p.t}
              x={x(i)}
              y={H - 7}
              fontSize="10.5"
              fontWeight={600}
              textAnchor="middle"
              fill="var(--ff-muted)"
            >
              {labelFor(p.t, bucket)}
            </text>
          ) : null,
        )}

        {/* hover guide + dot */}
        {hover != null && hv != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.t}
              y2={baseY}
              stroke="var(--ff-green-600)"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
            />
            <circle cx={x(hover)} cy={y(hv)} r={4.5} fill="var(--ff-green-700)" stroke="#fff" strokeWidth={2} />
          </>
        )}
      </svg>

      {/* tooltip */}
      {hover != null && hv != null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-center shadow-ff-md"
          style={{
            left: `${(x(hover) / w) * 100}%`,
            top: 6,
          }}
        >
          <div className="text-[11px] font-semibold text-ff-muted">{labelFor(points[hover].t, bucket)}</div>
          <div className="ff-fig text-[14px] font-extrabold text-ff-ink">{fmt(hv)}</div>
        </div>
      )}

      <div className="mt-1 text-[12px] text-ff-muted">
        Общо за периода: <span className="ff-fig font-bold text-ff-ink-2">{fmt(total)}</span>
      </div>
    </div>
  );
}
