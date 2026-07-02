'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Search, ShieldCheck, ShieldAlert, ShieldX, Flag } from 'lucide-react';
import {
  ApiError, riskCheck, riskCandidates, riskReport,
  type RiskCheckResult, type RiskCandidate,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
// ActivationGuard 403s on risk endpoints → friendly nudge instead of a raw error.
const activationMsg = (e: unknown) =>
  e instanceof ApiError && e.status === 403
    ? 'Активирай услугата, за да ползваш проверка за риск'
    : errMsg(e);

const money = (st: number | null | undefined) => (st == null ? '—' : `${(st / 100).toFixed(2)} €`);
const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('bg-BG');
};

const VERDICT = {
  ok: { label: 'Чисто', icon: ShieldCheck, cls: 'bg-ff-green-50 text-ff-green-700 border-ff-green-500' },
  caution: { label: 'Внимание', icon: ShieldAlert, cls: 'bg-ff-amber-softer text-ff-amber-600 border-ff-amber-600' },
  high: { label: 'Висок риск', icon: ShieldX, cls: 'bg-[#FBE9E7] text-ff-red border-ff-red' },
} as const;

export function CodRiskClient() {
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<RiskCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const [candidates, setCandidates] = useState<RiskCandidate[]>([]);
  const [loadingCand, setLoadingCand] = useState(true);
  const [reportingId, setReportingId] = useState<string | null>(null);

  const loadCandidates = useCallback(async () => {
    setLoadingCand(true);
    try { setCandidates(await riskCandidates()); }
    catch (e) { toast.error(activationMsg(e)); } finally { setLoadingCand(false); }
  }, []);

  useEffect(() => { void loadCandidates(); }, [loadCandidates]);

  async function check() {
    const p = phone.trim();
    if (!p) return;
    setChecking(true);
    try { setResult(await riskCheck(p)); }
    catch (e) { setResult(null); toast.error(activationMsg(e)); } finally { setChecking(false); }
  }

  async function report(c: RiskCandidate) {
    setReportingId(c.shipmentId);
    try {
      await riskReport(c.shipmentId);
      toast.success('Докладвано успешно');
      await loadCandidates();
    } catch (e) { toast.error(activationMsg(e)); } finally { setReportingId(null); }
  }

  const inp = 'h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[14px] outline-none focus:border-ff-green-500';
  const btn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60';
  const verdict = result ? VERDICT[result.verdict] : null;

  return (
    <div className="animate-ff-fade-up">
      <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Проверка на клиент</h1>
      <p className="mt-1 text-[13.5px] text-ff-muted">Провери телефона на клиента преди да пуснеш пратка с наложен платеж.</p>

      {/* verdict legend — what each result means */}
      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        {([
          [VERDICT.ok, 'Няма сигнали — безопасно за наложен платеж.'],
          [VERDICT.caution, 'Има единичен сигнал — провери преди да пуснеш.'],
          [VERDICT.high, 'Множество сигнали — препоръчва се предплащане.'],
        ] as const).map(([v, desc]) => (
          <div key={v.label} className={`flex items-start gap-2.5 rounded-xl border bg-ff-surface p-3 shadow-ff-sm ${v.cls.split(' ').find((c) => c.startsWith('border-')) ?? ''}`}>
            <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${v.cls}`}>
              <v.icon size={17} />
            </div>
            <div>
              <div className="text-[13.5px] font-extrabold text-ff-ink">{v.label}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-ff-muted">{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* phone check */}
      <div className="mt-4 rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
        <form
          className="flex flex-wrap items-center gap-2.5"
          onSubmit={(e) => { e.preventDefault(); void check(); }}
        >
          <input
            className={inp + ' max-w-[280px] flex-1'}
            type="tel"
            inputMode="tel"
            placeholder="Телефон (напр. 0888123456)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button type="submit" disabled={checking || !phone.trim()} className={btn}>
            <Search size={16} /> {checking ? 'Проверявам…' : 'Провери'}
          </button>
        </form>

        {result && verdict && (
          <div className="mt-4 animate-ff-fade">
            <div className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[15px] font-extrabold ${verdict.cls}`}>
              <verdict.icon size={20} /> {verdict.label}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[12.5px] font-bold">
              <span className="inline-flex items-center gap-1 rounded-full bg-ff-badge-bg px-2.5 py-1 text-ff-badge-ink">
                Наши сигнали: {result.strikes}
              </span>
              <span
                className="inline-flex items-center gap-1 rounded-full bg-ff-badge-bg px-2.5 py-1 text-ff-badge-ink"
                title="Регистър „Некоректен клиент“ (nekorekten.com) — външна база с неполучени/върнати пратки."
              >
                Некоректен: {result.nekorektenCount}
              </span>
              {result.phone && (
                <span className="inline-flex items-center gap-1 rounded-full bg-ff-badge-bg px-2.5 py-1 text-ff-badge-ink">
                  Търсен номер: {result.phone}
                </span>
              )}
            </div>
            {!result.nekorektenConfigured && (
              <p className="mt-2 text-[12.5px] text-ff-muted">Регистърът „Некоректен“ (nekorekten.com) не е свързан — показваме само нашата вътрешна база.</p>
            )}
            {result.phone === null && (
              <p className="mt-2 text-[12.5px] text-ff-muted">Невалиден телефонен номер — въведи български номер, напр. 0888123456.</p>
            )}

            {result.reports.length > 0 ? (
              <ul className="mt-4 flex flex-col gap-2">
                {result.reports.map((r, i) => (
                  <li key={i} className="rounded-lg border border-ff-border-2 bg-ff-surface-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.source === 'nekorekten' ? 'bg-ff-amber-softer text-ff-amber-600' : 'bg-ff-badge-bg text-ff-badge-ink'}`}>
                        {r.source === 'nekorekten' ? 'Некоректен' : 'наша база'}
                      </span>
                      <span className="text-[12px] text-ff-muted">{fmtDate(r.date)}</span>
                    </div>
                    <p className="mt-1.5 text-[13px] text-ff-ink-2">{r.description ?? '—'}</p>
                    {r.amountStotinki != null && (
                      <p className="mt-1 ff-fig text-[12.5px] text-ff-muted">Сума: {money(r.amountStotinki)}</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              result.phone !== null && (
                <p className="mt-4 text-[13px] text-ff-muted">Няма записи за този номер.</p>
              )
            )}
          </div>
        )}
      </div>

      {/* candidates */}
      <h2 className="mt-8 font-display text-[18px] font-extrabold tracking-[-0.01em]">За докладване</h2>
      <p className="mt-1 text-[13px] text-ff-muted">Върнати/отказани пратки с наложен платеж, които може да докладваш.</p>

      {loadingCand ? (
        <p className="mt-4 text-[14px] text-ff-muted">Зареждам…</p>
      ) : candidates.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-ff-border bg-ff-surface px-4 py-10 text-center">
          <p className="text-[14px] font-bold text-ff-ink-2">Няма пратки за докладване</p>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {candidates.map((c) => (
            <div key={c.shipmentId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ff-border bg-ff-surface p-3.5 shadow-ff-sm">
              <div className="min-w-0">
                <div className="truncate text-[14.5px] font-bold text-ff-ink">{c.receiverName || 'Без име'}</div>
                <div className="mt-0.5 text-[13px] text-ff-muted">
                  {c.phone || 'няма телефон'} · <span className="ff-fig">{money(c.codAmountStotinki)}</span>
                </div>
              </div>
              <button
                onClick={() => report(c)}
                disabled={reportingId === c.shipmentId}
                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[13.5px] font-bold text-ff-red hover:bg-[#FBE9E7] disabled:opacity-60"
              >
                <Flag size={16} /> {reportingId === c.shipmentId ? 'Докладвам…' : 'Докладвай'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
