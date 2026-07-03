'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { labelFor } from '@/components/stats/trend-chart';
import type { AnalyticsPoint, StatsBucket } from '@/lib/types';

const H = 240;
const PAD = { t: 14, r: 10, b: 40, l: 10 }; // extra bottom padding for the purchase bars
const BAR_H = 22; // fixed strip height for the purchase bars, below the line chart

/** Dual-scale trend: the toggled metric (visitors/pageViews) as a green
 *  area+line on its own scale, purchases as small dark bars along the
 *  baseline on an INDEPENDENT scale — so a handful of purchases doesn't
 *  visually vanish next to a much larger visitor count on a shared axis. */
export function AnalyticsTrendChart({
  points,
  bucket,
  metric,
}: {
  points: AnalyticsPoint[];
  bucket: StatsBucket;
  metric: 'visitors' | 'pageViews';
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

  const vals = useMemo(() => points.map((p) => p[metric]), [points, metric]);
  const purchaseVals = useMemo(() => points.map((p) => p.purchases), [points]);

  const innerW = Math.max(1, w - PAD.l - PAD.r);
  const lineH = H - PAD.t - PAD.b;
  const n = points.length;
  const maxV = Math.max(1, ...vals);
  const maxP = Math.max(1, ...purchaseVals);
  const stepX = n > 1 ? innerW / (n - 1) : 0;
  const x = (i: number) => PAD.l + (n > 1 ? i * stepX : innerW / 2);
  const y = (v: number) => PAD.t + (1 - v / maxV) * lineH;
  const baseY = PAD.t + lineH;
  const barY = baseY + 10;
  const barWidth = n > 1 ? Math.max(2, Math.min(18, stepX * 0.5)) : 18;

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

  const tickEvery = Math.max(1, Math.ceil(n / 6));

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const i = n > 1 ? Math.round((px - PAD.l) / stepX) : 0;
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  const hv = hover != null ? vals[hover] : null;
  const hp = hover != null ? purchaseVals[hover] : null;
  const svgH = H + BAR_H + 14;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${w} ${svgH}`}
        width="100%"
        height={svgH}
        className="block touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="ff-analytics-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ff-green-500)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--ff-green-500)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map((f) => {
          const gy = PAD.t + f * lineH;
          return (
            <line key={f} x1={PAD.l} x2={w - PAD.r} y1={gy} y2={gy} stroke="var(--ff-border-2)" strokeWidth={1} />
          );
        })}
        <text x={PAD.l + 2} y={PAD.t - 3} fontSize="11" fontWeight={700} fill="var(--ff-muted-2)">
          {maxV}
        </text>

        {areaPath && <path d={areaPath} fill="url(#ff-analytics-fill)" />}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke="var(--ff-green-600)"
            strokeWidth={2.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* purchase bars, independent scale */}
        {points.map((p, i) => {
          const h = maxP > 0 ? Math.max(p.purchases > 0 ? 2 : 0, (p.purchases / maxP) * BAR_H) : 0;
          return (
            <rect
              key={p.t}
              x={x(i) - barWidth / 2}
              y={barY + (BAR_H - h)}
              width={barWidth}
              height={h}
              rx={1.5}
              fill="var(--ff-ink-2)"
              opacity={0.75}
            />
          );
        })}

        {/* x-axis labels */}
        {points.map((p, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text
              key={p.t}
              x={x(i)}
              y={barY + BAR_H + 13}
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
              y2={barY + BAR_H}
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
          style={{ left: `${(x(hover) / w) * 100}%`, top: 6 }}
        >
          <div className="text-[11px] font-semibold text-ff-muted">{labelFor(points[hover].t, bucket)}</div>
          <div className="ff-fig text-[14px] font-extrabold text-ff-ink">
            {hv} {metric === 'visitors' ? 'посетители' : 'прегледи'}
          </div>
          <div className="ff-fig text-[12px] font-bold text-ff-ink-2">{hp} покупки</div>
        </div>
      )}
    </div>
  );
}
