'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Phone,
  MessageCircle,
  TrendingUp,
  Activity,
  CheckCircle2,
} from 'lucide-react';
import { TrendChart } from '@/components/trend-chart';
import {
  getInsightsTimeseries,
  type PlatformInsights,
  type PlatformTimeseries,
  type TimeseriesRange,
  type AdoptionRow,
  type FarmSignals,
} from '@/lib/api-client';

const RANGES: { key: TimeseriesRange; label: string }[] = [
  { key: '7d', label: '7д' },
  { key: '30d', label: '30д' },
  { key: '90d', label: '3м' },
  { key: '1y', label: '1г' },
  { key: 'all', label: 'Всичко' },
];

/** BG phone → viber deep-link number (international, digits only). Best-effort:
 *  0XXXXXXXXX → 359XXXXXXXXX; already-international kept as-is. */
function viberNumber(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits.slice(1);
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `359${digits.slice(1)}`;
  return digits;
}

function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-xl border border-ff-border bg-ff-surface p-0.5 shadow-ff-sm">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-bold transition-colors ${
            value === o.key ? 'bg-ff-green-700 text-[#EAF1E4]' : 'text-ff-ink-2 hover:bg-ff-surface-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FarmAttentionCard({ f }: { f: FarmSignals }) {
  const vb = f.phone ? viberNumber(f.phone) : null;
  const accent = f.maxSeverity >= 80 ? 'bg-ff-amber' : f.maxSeverity >= 60 ? 'bg-ff-amber-600' : 'bg-ff-muted-2';
  return (
    <div className="relative overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${accent}`} />
      <div className="flex flex-col gap-3 p-4 pl-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[15.5px] font-extrabold">{f.name}</div>
          <div className="text-xs text-ff-muted-2">/{f.slug}</div>
          <ul className="mt-2.5 flex flex-col gap-2">
            {f.signals.map((s) => (
              <li key={s.key} className="flex items-start gap-2">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-ff-amber-600" />
                <div className="leading-tight">
                  <div className="text-[13.5px] font-semibold text-ff-ink">{s.label}</div>
                  <div className="text-[12.5px] text-ff-muted">→ {s.action}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        {f.phone && (
          <div className="flex shrink-0 items-center gap-2">
            {vb && (
              <a
                href={`viber://chat?number=%2B${vb}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-700 px-3 py-2 text-[12.5px] font-bold text-[#EAF1E4] hover:bg-ff-green-800"
              >
                <MessageCircle size={15} /> Viber
              </a>
            )}
            <a
              href={`tel:${f.phone}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
            >
              <Phone size={15} /> {f.phone}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function AdoptionBar({ r }: { r: AdoptionRow }) {
  const low = r.pct < 34;
  return (
    <div className="flex items-center gap-3">
      <div className="w-[150px] shrink-0 text-[13.5px] font-semibold text-ff-ink-2 max-sm:w-[110px]">
        {r.label}
      </div>
      <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-ff-surface-2">
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${low ? 'bg-ff-amber' : 'bg-ff-green-500'}`}
          style={{ width: `${Math.max(r.pct, r.count > 0 ? 4 : 0)}%` }}
        />
      </div>
      <div className="w-[92px] shrink-0 text-right text-[12.5px] text-ff-muted">
        <span className="ff-fig font-bold text-ff-ink-2">{r.pct}%</span>{' '}
        <span className="ff-fig">({r.count}/{r.total})</span>
      </div>
    </div>
  );
}

export function InsightsClient({ initial }: { initial: PlatformInsights | null }) {
  const [range, setRange] = useState<TimeseriesRange>('30d');
  const [metric, setMetric] = useState<'orders' | 'revenue'>('orders');
  const [tenantId, setTenantId] = useState<string>('');
  const [series, setSeries] = useState<PlatformTimeseries | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getInsightsTimeseries(range, tenantId || undefined)
      .then((s) => {
        if (live) setSeries(s);
      })
      .catch((e) => {
        if (live) toast.error(e?.message ?? 'Грешка при зареждане на графиката');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [range, tenantId]);

  const farmName = useMemo(
    () => initial?.farms.find((f) => f.id === tenantId)?.name,
    [initial, tenantId],
  );

  if (!initial) {
    return (
      <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-sm text-ff-muted shadow-ff-sm">
        Неуспешно зареждане на анализа. Опитай да презаредиш страницата.
      </div>
    );
  }

  const { signals, adoption, totalFarms } = initial;

  return (
    <div className="animate-ff-fade-up flex flex-col gap-7">
      <div>
        <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Анализ</h1>
        <p className="mt-0.5 text-[13.5px] text-ff-muted">
          Кой фермер има нужда от помощ, кои функции се ползват и как вървят поръчките.
        </p>
      </div>

      {/* ── Block 1: farms that need attention ── */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle size={18} className="text-ff-amber-600" />
          <h2 className="font-display text-[17px] font-extrabold">Ферми за внимание</h2>
          {signals.length > 0 && (
            <span className="ff-fig rounded-full bg-ff-amber-soft px-2 py-0.5 text-[12px] font-bold text-ff-amber-600">
              {signals.length}
            </span>
          )}
        </div>
        {signals.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-ff-green-100 bg-ff-green-50 px-5 py-5 shadow-ff-sm">
            <CheckCircle2 size={22} className="text-ff-green-700" />
            <div className="text-[14px] font-semibold text-ff-green-800">
              Всичко изглежда наред — нито една ферма не подава сигнал в момента.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {signals.map((f) => (
              <FarmAttentionCard key={f.tenantId} f={f} />
            ))}
          </div>
        )}
      </section>

      {/* ── Block 2: feature adoption ── */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Activity size={18} className="text-ff-green-700" />
          <h2 className="font-display text-[17px] font-extrabold">Използване на функции</h2>
          <span className="text-[12.5px] text-ff-muted">от {totalFarms} ферми</span>
        </div>
        <div className="flex flex-col gap-3 rounded-xl border border-ff-border bg-ff-surface px-5 py-5 shadow-ff-sm">
          {adoption.map((r) => (
            <AdoptionBar key={r.key} r={r} />
          ))}
        </div>
      </section>

      {/* ── Block 3: trend chart ── */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <TrendingUp size={18} className="text-ff-green-700" />
          <h2 className="font-display text-[17px] font-extrabold">Тренд</h2>
        </div>
        <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Seg value={range} onChange={setRange} options={RANGES} />
              <Seg
                value={metric}
                onChange={setMetric}
                options={[
                  { key: 'orders', label: 'Поръчки' },
                  { key: 'revenue', label: 'Приход' },
                ]}
              />
            </div>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="h-10 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13.5px] font-semibold text-ff-ink-2 shadow-ff-sm outline-none focus:border-ff-green-500"
            >
              <option value="">Всички ферми</option>
              {initial.farms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>

          {tenantId && (
            <div className="mb-2 text-[12.5px] text-ff-muted">
              Показва: <span className="font-bold text-ff-ink-2">{farmName}</span>
            </div>
          )}

          <div className={loading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
            {series && series.points.length > 0 ? (
              <TrendChart points={series.points} bucket={series.bucket} metric={metric} />
            ) : (
              <div className="grid h-[240px] place-items-center text-sm text-ff-muted">
                {loading ? 'Зареждане…' : 'Няма данни за периода.'}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
