'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { UploadCloud, FileDown, Download, FileSpreadsheet, ListChecks, Scale, HelpCircle, Copy, Check, ExternalLink, X, Sparkles, ShieldCheck, ShieldAlert, ShieldX, Loader2, Clock, CloudOff, Info } from 'lucide-react';
import {
  ApiError, uploadBatch, patchRow, deleteRow, commitBatch, downloadLabels, templateUrl, compareShipment, riskCheckBulk,
  type ImportRow, type QuoteResult, type RiskBulkEntry, type RiskBulkMeta,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const priceEur = (st: number | null | undefined) => (st == null ? '—' : `${(st / 100).toFixed(2)} €`);

/** Strip all non-digit characters and return the last 9 digits (Bulgarian mobile suffix). */
function last9digits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-9);
}

const RISK_VERDICT = {
  ok: { label: 'Чисто', icon: ShieldCheck, cls: 'bg-ff-green-50 text-ff-green-700 border-ff-green-500' },
  caution: { label: 'Внимание', icon: ShieldAlert, cls: 'bg-ff-amber-softer text-ff-amber-600 border-ff-amber-600' },
  high: { label: 'Висок риск', icon: ShieldX, cls: 'bg-[#FBE9E7] text-ff-red border-ff-red' },
} as const;

/** Non-verdict status pills — visually distinct from the 3 risk verdicts (neutral palette, not green/amber/red). */
const RISK_STATUS = {
  rate_limited: {
    label: 'Изчакай',
    icon: Clock,
    cls: 'bg-zinc-100 text-zinc-500 border-zinc-300',
    tooltip: 'Лимит на Nekorekten — опитай пак след малко',
  },
  unavailable: {
    label: 'Няма връзка',
    icon: CloudOff,
    cls: 'bg-slate-100 text-slate-400 border-slate-300',
    tooltip: 'Nekorekten временно недостъпен',
  },
} as const;

const STEPS = [
  { icon: Download, title: 'Свали шаблона', desc: 'Готов Excel/CSV с правилните колони.' },
  { icon: UploadCloud, title: 'Качи файла', desc: 'Само файлът — без настройки. Системата чете редовете.' },
  { icon: ListChecks, title: 'Поправи редовете', desc: 'Маркираните в жълто/червено се редактират на място.' },
  { icon: Scale, title: 'Сравни и създай', desc: 'Избери най-евтиния куриер за всеки ред и създай пратките.' },
] as const;

export function ImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [ai, setAi] = useState('');
  const [busy, setBusy] = useState(false);
  // Per-row cheapest-quote results (carrier prices), keyed by row id.
  const [quotes, setQuotes] = useState<Record<string, QuoteResult>>({});
  const [comparing, setComparing] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  // Risk check state: map of last-9-digits → bulk entry, plus loading flag and summary.
  const [riskMap, setRiskMap] = useState<Record<string, RiskBulkEntry>>({});
  const [checkingRisk, setCheckingRisk] = useState(false);
  const [riskSummary, setRiskSummary] = useState<{ high: number; checked: number } | null>(null);
  const [riskMeta, setRiskMeta] = useState<RiskBulkMeta | null>(null);
  // Live countdown (seconds) for per-minute rate limit.
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start/restart countdown timer when a per-minute rate limit is hit.
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (riskMeta?.limit === 'minute' && riskMeta.retryAfterSeconds > 0) {
      setCountdown(riskMeta.retryAfterSeconds);
      countdownRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            countdownRef.current = null;
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      setCountdown(0);
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riskMeta]);

  const count = (s: string) => rows.filter((r) => r.validationStatus === s).length;

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      // Carrier/currency/weight are no longer chosen up front — upload just the file.
      const data = await uploadBatch(file);
      setBatchId(data.batch.id);
      setRows(data.rows);
      setQuotes({});
      setAi(data.batch.aiReport?.aiAvailable ? '' : 'AI проверка недостъпна — само базова проверка.');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  async function save(r: ImportRow) {
    if (!batchId) return;
    try {
      const updated = await patchRow(batchId, r.id, {
        receiverName: r.receiverName, receiverPhone: r.receiverPhone, deliveryMode: r.deliveryMode,
        city: r.city, office: r.office, address: r.address, weightGrams: r.weightGrams,
        codAmountStotinki: r.codAmountStotinki, carrier: r.carrier,
      });
      // Merge only server-authoritative fields onto the LATEST local row so an
      // in-flight edit to another field (made while this save was pending) is kept.
      setRows((p) => p.map((x) => (x.id === r.id
        ? { ...x, validationStatus: updated.validationStatus, validation: updated.validation, shipmentId: updated.shipmentId }
        : x)));
    } catch (e) { toast.error(errMsg(e)); }
  }

  async function del(r: ImportRow) {
    if (!batchId) return;
    try { await deleteRow(batchId, r.id); setRows((p) => p.filter((x) => x.id !== r.id)); }
    catch (e) { toast.error(errMsg(e)); }
  }

  // Price both carriers for every committable row, then auto-pick the cheaper one.
  // Runs with a tiny concurrency pool to stay under the compare throttle (30/min).
  async function compareAll() {
    const targets = rows.filter((r) => r.validationStatus !== 'error' && r.city && r.deliveryMode && !r.shipmentId);
    if (!targets.length) { toast.error('Няма редове за сравнение — провери град и режим.'); return; }
    setComparing(true);
    const found: Record<string, QuoteResult> = {};
    const picks: Array<{ row: ImportRow; carrier: 'econt' | 'speedy' }> = [];
    let failed = 0;
    const queue = [...targets];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          const q = await compareShipment({
            destinationCity: r.city!, deliveryMode: r.deliveryMode!,
            weightGrams: r.weightGrams ?? undefined,
          });
          found[r.id] = q;
          if (q.cheapest && q.cheapest !== r.carrier) picks.push({ row: r, carrier: q.cheapest });
        } catch { failed++; }
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
      setQuotes((p) => ({ ...p, ...found }));
      // Optimistically reflect the cheaper carrier locally, then persist each pick.
      if (picks.length) {
        setRows((prev) => prev.map((x) => {
          const pick = picks.find((p) => p.row.id === x.id);
          return pick ? { ...x, carrier: pick.carrier } : x;
        }));
        for (const { row, carrier } of picks) await save({ ...row, carrier });
      }
      const done = Object.keys(found).length;
      toast.success(`Сравнени ${done} ${done === 1 ? 'ред' : 'реда'}${picks.length ? ` · ${picks.length} сменени на по-евтин` : ''}`);
      if (failed) toast.error(`${failed} реда не успяха да се сравнят.`);
    } finally { setComparing(false); }
  }

  async function checkAllRisk() {
    const phones = rows.map((r) => r.receiverPhone).filter((p): p is string => !!p?.trim());
    if (!phones.length) { toast.error('Няма телефонни номера за проверка.'); return; }
    setCheckingRisk(true);
    try {
      const { results, meta } = await riskCheckBulk(phones);
      // Build a lookup keyed by the last 9 digits of the normalized phone.
      const map: Record<string, RiskBulkEntry> = {};
      for (const entry of results) {
        const key = last9digits(entry.normalized || entry.phone);
        if (key) map[key] = entry;
      }
      setRiskMap(map);
      setRiskMeta(meta);
      const highCount = results.filter((e) => e.verdict === 'high').length;
      // checked = phones that got a real verdict (total minus rate-limited)
      setRiskSummary({ high: highCount, checked: meta.checked });
      if (meta.rateLimited > 0) {
        toast.warning(`Проверени ${meta.checked} — ${meta.rateLimited} изчакват лимита`);
      } else {
        toast.success(`Проверени ${meta.checked} номера${highCount ? ` · ${highCount} с висок риск` : ''}`);
      }
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 403
        ? 'Активирай услугата, за да ползваш проверка за риск'
        : errMsg(e);
      toast.error(msg);
    } finally { setCheckingRisk(false); }
  }

  async function commit() {
    if (!batchId) return;
    setBusy(true);
    try {
      const res = await commitBatch(batchId);
      const created = res.results.filter((x) => x.status === 'created').length;
      toast.success(`Създадени ${created} пратки`);
      if (res.failed) toast.error(`${res.failed} реда не успяха — виж „Проблеми".`);
      const { getBatch } = await import('@/lib/api-client');
      setRows((await getBatch(batchId)).rows);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  const labelIds = (carrier: 'econt' | 'speedy') => rows.filter((r) => r.shipmentId && r.carrier === carrier).map((r) => r.shipmentId!) as string[];

  async function labels(carrier: 'econt' | 'speedy') {
    try { await downloadLabels(carrier, labelIds(carrier)); }
    catch (e) { toast.error(errMsg(e)); }
  }

  function patch(r: ImportRow, k: keyof ImportRow, v: unknown) {
    setRows((p) => p.map((x) => (x.id === r.id ? { ...x, [k]: v } : x)));
  }

  // Price a single carrier from a row's quote result (null = unavailable / not priced).
  const carrierPrice = (q: QuoteResult | undefined, c: 'econt' | 'speedy') => {
    const entry = q?.quotes.find((x) => x.carrier === c);
    return entry && entry.available ? entry.priceStotinki : null;
  };

  const inp = 'w-full rounded-lg border border-ff-border bg-ff-surface px-2 py-1.5 text-[13.5px] outline-none focus:border-ff-green-500';
  const rowBg = (s: string) => (s === 'ok' ? 'bg-ff-green-50' : s === 'warn' ? 'bg-ff-amber-softer' : 'bg-[#FBE9E7]');
  const primaryBtn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60';
  const outlineBtn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-4 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2';

  // Per-row carrier price comparison, shown once "Сравни куриери" has run.
  const PriceCell = ({ r }: { r: ImportRow }) => {
    const q = quotes[r.id];
    if (!q) return <span className="text-ff-muted">—</span>;
    return (
      <div className="flex flex-col gap-0.5 text-[11.5px] leading-tight ff-fig">
        <span className={r.carrier === 'econt' ? 'font-extrabold text-ff-green-700' : 'text-ff-muted'}>Еконт {priceEur(carrierPrice(q, 'econt'))}</span>
        <span className={r.carrier === 'speedy' ? 'font-extrabold text-ff-green-700' : 'text-ff-muted'}>Спиди {priceEur(carrierPrice(q, 'speedy'))}</span>
      </div>
    );
  };

  // Risk badge shown per row after bulk check has run.
  // Handles 3 risk verdicts + 2 non-verdict status states (rate_limited / unavailable).
  const RiskBadge = ({ r }: { r: ImportRow }) => {
    const key = r.receiverPhone ? last9digits(r.receiverPhone) : '';
    const entry = key ? riskMap[key] : undefined;
    if (!entry) return null;

    // Non-verdict status states use a neutral colour palette (not green/amber/red).
    if (entry.status === 'rate_limited' || entry.status === 'unavailable') {
      const s = RISK_STATUS[entry.status];
      return (
        <span
          title={s.tooltip}
          className={`inline-flex min-w-[72px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${s.cls}`}
        >
          <s.icon size={11} /> {s.label}
        </span>
      );
    }

    // Verdict states (ok / caution / high).
    const v = RISK_VERDICT[entry.verdict];
    return (
      <span className={`inline-flex min-w-[72px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${v.cls}`}>
        <v.icon size={11} /> {v.label}
      </span>
    );
  };

  return (
    <div className="animate-ff-fade-up">
      <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Масов внос на пратки</h1>
      <p className="mt-1 text-[13.5px] text-ff-muted">Качи Excel или CSV с поръчки. Куриерът се избира накрая — по най-добра цена.</p>

      {/* guide — hidden once a file is loaded into the editor */}
      {rows.length === 0 && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex items-start gap-3 rounded-xl border border-ff-border bg-ff-surface p-3.5 shadow-ff-sm">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[14px] font-extrabold text-white">{i + 1}</div>
              <div>
                <div className="flex items-center gap-1.5 text-[13.5px] font-bold text-ff-ink">
                  <s.icon size={15} className="text-ff-green-600" /> {s.title}
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-ff-muted">{s.desc}</div>
                {i === 0 && (
                  <button
                    type="button"
                    onClick={() => setShowGuide(true)}
                    className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-bold text-ff-green-700 hover:underline"
                  >
                    <HelpCircle size={13} /> Как да структурирам файла?
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* upload card — file only */}
      {rows.length === 0 && (
        <div className="mt-5 rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-4 shadow-ff-sm">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ff-border bg-ff-surface-2 px-4 py-8 text-center transition-colors hover:border-ff-green-500 hover:bg-ff-green-50">
            <UploadCloud size={28} className="text-ff-muted-2" />
            <div className="text-[14px] font-bold text-ff-ink-2">{file ? file.name : 'Избери Excel или CSV файл'}</div>
            <div className="text-[12px] text-ff-muted">{file ? 'Натисни „Качи и провери", за да продължиш' : 'Поддържани формати: .xlsx, .csv'}</div>
            <input className="hidden" type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <button onClick={upload} disabled={!file || busy} className={primaryBtn}>
              <UploadCloud size={16} /> {busy ? 'Качвам…' : 'Качи и провери'}
            </button>
            <a href={templateUrl} className={outlineBtn}>
              <FileDown size={16} /> Свали шаблон
            </a>
          </div>
        </div>
      )}
      {ai && rows.length === 0 && <p className="mt-2 text-[12.5px] text-ff-amber-600">{ai}</p>}

      {rows.length > 0 && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-ff-border bg-ff-surface p-3 shadow-ff-sm">
            <span className="mr-1 ff-fig text-[12.5px] font-bold text-ff-ink-2">{rows.length} реда</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-green-50 px-2.5 py-1 text-[12.5px] font-bold text-ff-green-700"><span className="h-2 w-2 rounded-full bg-ff-green-500" /> Готови {count('ok')}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-amber-softer px-2.5 py-1 text-[12.5px] font-bold text-ff-amber-600"><span className="h-2 w-2 rounded-full bg-ff-amber" /> Внимание {count('warn')}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FBE9E7] px-2.5 py-1 text-[12.5px] font-bold text-ff-red"><span className="h-2 w-2 rounded-full bg-ff-red" /> Грешка {count('error')}</span>
            <button onClick={() => void compareAll()} disabled={comparing || busy} className="ml-auto inline-flex h-10 items-center gap-2 rounded-xl border border-ff-green-600 bg-ff-green-50 px-3.5 text-[13px] font-bold text-ff-green-700 hover:bg-ff-green-100 disabled:opacity-60">
              <Scale size={15} /> {comparing ? 'Сравнявам…' : 'Сравни куриери'}
            </button>
            <button onClick={commit} disabled={busy || comparing} className="inline-flex h-10 items-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60">{busy ? 'Създавам…' : 'Създай пратки'}</button>
            {labelIds('econt').length > 0 && <button onClick={() => void labels('econt')} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"><FileDown size={15} /> Етикети (Econt)</button>}
            {labelIds('speedy').length > 0 && <button onClick={() => void labels('speedy')} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"><FileDown size={15} /> Етикети (Speedy)</button>}
          </div>
          <p className="mt-2 text-[12px] text-ff-muted">„Сравни куриери" пита Еконт и Спиди за цена на всеки ред и слага по-евтиния — после може ръчно да смениш куриера в колоната.</p>

          {/* Nekorekten bulk risk check bar */}
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => void checkAllRisk()}
              disabled={checkingRisk || busy || (countdown > 0)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-ff-amber-600 bg-ff-amber-softer px-3.5 text-[13px] font-bold text-ff-amber-600 hover:bg-ff-amber-100 disabled:opacity-60"
            >
              {checkingRisk ? <Loader2 size={15} className="animate-spin" /> : countdown > 0 ? <Clock size={15} /> : <ShieldCheck size={15} />}
              {checkingRisk ? 'Проверявам…' : countdown > 0 ? `Изчакай ~${countdown}с` : 'Провери всички в Nekorekten'}
            </button>
            <a
              href="https://nekorekten.com/bg/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12.5px] text-ff-muted hover:text-ff-ink-2 hover:underline"
            >
              или провери ръчно на nekorekten.com/bg ↗
            </a>
            {riskSummary && (
              <span className={`ml-auto text-[12.5px] font-bold ${riskSummary.high > 0 ? 'text-ff-red' : 'text-ff-green-700'}`}>
                {riskSummary.high} високорискови от {riskSummary.checked} проверени
                {riskMeta && riskMeta.rateLimited > 0 && (
                  <span className="ml-1.5 font-normal text-zinc-500">· {riskMeta.rateLimited} изчакват</span>
                )}
              </span>
            )}
          </div>

          {/* Rate-limit banner — shown when some phones were skipped due to Nekorekten limits */}
          {riskMeta && riskMeta.rateLimited > 0 && (
            <div className="mt-2.5 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px]">
              <span className="mt-0.5 shrink-0 text-amber-500">
                {riskMeta.limit === 'minute' ? <Clock size={16} /> : <Info size={16} />}
              </span>
              <div className="min-w-0 flex-1 leading-snug text-amber-800">
                {riskMeta.limit === 'minute' ? (
                  <>
                    <span className="font-bold">Проверени {riskMeta.checked} от {riskMeta.checked + riskMeta.rateLimited}.</span>
                    {' '}Достигнат лимитът на Nekorekten (безплатен план: 5/мин, 30/ден).
                    {' '}Останалите <span className="font-bold">{riskMeta.rateLimited}</span> —{' '}
                    {countdown > 0
                      ? <>опитай пак след <span className="tabular-nums font-bold">~{countdown}с</span>.</>
                      : <button
                          type="button"
                          onClick={() => void checkAllRisk()}
                          disabled={checkingRisk}
                          className="font-bold underline hover:no-underline disabled:opacity-60"
                        >
                          Провери отново
                        </button>
                    }
                  </>
                ) : (
                  <>
                    <span className="font-bold">Достигнат дневният лимит на Nekorekten (30/ден).</span>
                    {' '}Опитай пак утре.
                  </>
                )}
              </div>
              {riskMeta.limit === 'minute' && countdown > 0 && (
                <button
                  type="button"
                  onClick={() => void checkAllRisk()}
                  disabled={checkingRisk || countdown > 0}
                  className="ml-auto shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[12px] font-bold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                >
                  Провери отново
                </button>
              )}
              {riskMeta.limit === 'day' && (
                <button
                  type="button"
                  disabled
                  className="ml-auto shrink-0 rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-[12px] font-bold text-amber-400 opacity-50 cursor-not-allowed"
                >
                  Провери отново
                </button>
              )}
            </div>
          )}

          {/* desktop table */}
          <div className="mt-3 overflow-x-auto rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:hidden">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {['#', 'Получател', 'Телефон', 'Реж.', 'Град', 'Офис/Адрес', 'Тегло(г)', 'НП(ст.)', 'Цена', 'Куриер', 'Риск', 'Проблеми', ''].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-ff-border-2 last:border-0 ${rowBg(r.validationStatus)}`}>
                    <td className="px-3 py-2">{r.rowIndex}</td>
                    <td className="px-3 py-2"><input className={inp} value={r.receiverName ?? ''} onChange={(e) => patch(r, 'receiverName', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><input className={inp} value={r.receiverPhone ?? ''} onChange={(e) => patch(r, 'receiverPhone', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><select className={inp} value={r.deliveryMode ?? 'office'} onChange={(e) => { patch(r, 'deliveryMode', e.target.value); }} onBlur={() => save(r)}><option value="office">офис</option><option value="address">адрес</option></select></td>
                    <td className="px-3 py-2"><input className={inp} value={r.city ?? ''} onChange={(e) => patch(r, 'city', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2">
                      {r.deliveryMode === 'office'
                        ? <input className={inp} placeholder="Офис" value={r.office ?? ''} onChange={(e) => patch(r, 'office', e.target.value)} onBlur={() => save(r)} />
                        : <input className={inp} placeholder="Адрес" value={r.address ?? ''} onChange={(e) => patch(r, 'address', e.target.value)} onBlur={() => save(r)} />}
                    </td>
                    <td className="px-3 py-2"><input className={inp} type="number" value={r.weightGrams ?? ''} onChange={(e) => patch(r, 'weightGrams', e.target.value === '' ? null : Number(e.target.value))} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><input className={inp} type="number" value={r.codAmountStotinki ?? ''} onChange={(e) => patch(r, 'codAmountStotinki', e.target.value === '' ? null : Number(e.target.value))} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><PriceCell r={r} /></td>
                    <td className="px-3 py-2"><select className={inp} value={r.carrier} onChange={(e) => { patch(r, 'carrier', e.target.value); }} onBlur={() => save(r)}><option value="econt">Econt</option><option value="speedy">Speedy</option></select></td>
                    <td className="px-3 py-2"><RiskBadge r={r} /></td>
                    <td className="px-3 py-2 text-[12px] text-ff-muted">{(r.validation?.issues ?? []).map((i) => i.message).join('; ')}</td>
                    <td className="px-3 py-2"><button onClick={() => del(r)} className="rounded-lg border border-[#e0a0a0] px-2 py-1 text-[12px] font-bold text-ff-red hover:bg-[#FBE9E7]">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* mobile cards */}
          <div className="mt-3 hidden flex-col gap-3 max-[900px]:flex">
            {rows.map((r) => (
              <div key={r.id} className={`rounded-xl border-2 p-3 ${rowBg(r.validationStatus)} ${r.validationStatus === 'ok' ? 'border-[#a5d6a7]' : r.validationStatus === 'warn' ? 'border-[#ffe082]' : 'border-[#ef9a9a]'}`}>
                {([
                  ['Получател', 'receiverName', 'text'], ['Телефон', 'receiverPhone', 'tel'], ['Град', 'city', 'text'],
                  [r.deliveryMode === 'office' ? 'Офис' : 'Адрес', r.deliveryMode === 'office' ? 'office' : 'address', 'text'],
                  ['Тегло (г)', 'weightGrams', 'number'], ['НП (ст.)', 'codAmountStotinki', 'number'],
                ] as const).map(([label, key, type]) => (
                  <label key={key} className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                    <span className="text-[12px] font-bold text-ff-muted">{label}</span>
                    <input className={inp} type={type} value={(r[key as keyof ImportRow] as string | number | null) ?? ''}
                      onChange={(e) => patch(r, key as keyof ImportRow, type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
                      onBlur={() => save(r)} />
                  </label>
                ))}
                <label className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                  <span className="text-[12px] font-bold text-ff-muted">Режим</span>
                  <select className={inp} value={r.deliveryMode ?? 'office'} onChange={(e) => patch(r, 'deliveryMode', e.target.value)} onBlur={() => save(r)}><option value="office">офис</option><option value="address">адрес</option></select>
                </label>
                <label className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                  <span className="text-[12px] font-bold text-ff-muted">Куриер</span>
                  <select className={inp} value={r.carrier} onChange={(e) => patch(r, 'carrier', e.target.value)} onBlur={() => save(r)}><option value="econt">Econt</option><option value="speedy">Speedy</option></select>
                </label>
                {quotes[r.id] && (
                  <div className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                    <span className="text-[12px] font-bold text-ff-muted">Цена</span>
                    <PriceCell r={r} />
                  </div>
                )}
                {(r.validation?.issues ?? []).length > 0 && <p className="text-[12px] text-ff-red">{(r.validation?.issues ?? []).map((i) => i.message).join('; ')}</p>}
                <RiskBadge r={r} />
                <button onClick={() => del(r)} className="mt-1 w-full rounded-lg border border-[#e0a0a0] py-2 text-[12.5px] font-bold text-ff-red hover:bg-[#FBE9E7]">✕ Изтрий</button>
              </div>
            ))}
          </div>
        </>
      )}

      {showGuide && <FileGuideModal onClose={() => setShowGuide(false)} />}
    </div>
  );
}

/** The exact template columns, mirrored from the server's /import/template.xlsx
 *  generator and the parser's HEADER_ALIASES — keep in sync if those change. */
const COLUMNS: Array<{ name: string; rule: string }> = [
  { name: 'Получател', rule: 'име на клиента (задължително)' },
  { name: 'Телефон', rule: 'български номер, напр. 0888123456 (задължително)' },
  { name: 'Доставка', rule: 'само „офис" или „адрес"' },
  { name: 'Град', rule: 'град на получателя, напр. Бургас' },
  { name: 'Офис', rule: 'име/код на офиса — само ако Доставка = офис, иначе празно' },
  { name: 'Адрес', rule: 'улица и номер — само ако Доставка = адрес, иначе празно' },
  { name: 'Тегло (кг)', rule: 'число в килограми, напр. 2 или 1.5 (празно = 1 кг)' },
  { name: 'Съдържание', rule: 'какво има в пратката, напр. Зеленчуци' },
  { name: 'Наложен платеж', rule: 'сума в евро (EUR) за събиране; празно = без наложен платеж' },
  { name: 'Обявена стойност', rule: 'застрахователна стойност в евро (по желание)' },
  { name: 'Куриер', rule: '„Econt" или „Speedy"; празно = системата избира най-евтиния' },
];

const CHATGPT_PROMPT = `Помогни ми да направя Excel (.xlsx) файл за масов внос на пратки в куриерска система.

Файлът трябва да има ТОЧНО тези колони на първия ред (заглавия), в този ред:
Получател | Телефон | Доставка | Град | Офис | Адрес | Тегло (кг) | Съдържание | Наложен платеж | Обявена стойност | Куриер

Правила за всяка колона:
- Получател: име на клиента (задължително)
- Телефон: български номер, напр. 0888123456 (задължително)
- Доставка: само „офис" или „адрес"
- Град: град на получателя (напр. Бургас)
- Офис: име или код на офиса — попълва се САМО ако Доставка = офис, иначе остави празно
- Адрес: улица и номер — попълва се САМО ако Доставка = адрес, иначе остави празно
- Тегло (кг): число в килограми, напр. 2 или 1.5 (празно = 1 кг)
- Съдържание: какво има в пратката (напр. Зеленчуци)
- Наложен платеж: сума в ЕВРО (EUR) за събиране от клиента; празно = без наложен платеж
- Обявена стойност: застрахователна стойност в евро (по желание, може празно)
- Куриер: „Econt" или „Speedy"; ако не си сигурен — остави празно

Дай ми готов файл за изтегляне (.xlsx) с тези колони и редове по моите данни долу.
Не променяй имената на колоните и не добавяй други колони.

Моите пратки (залепи или опиши тук):
[ТУК ЗАЛЕПИ ДАННИТЕ СИ]`;

/** Modal: how to structure the import file + a copy-ready ChatGPT prompt + link,
 *  so a non-technical operator can have ChatGPT build the file and just upload it. */
function FileGuideModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  function copyPrompt() {
    navigator.clipboard.writeText(CHATGPT_PROMPT)
      .then(() => { setCopied(true); toast.success('Промптът е копиран'); setTimeout(() => setCopied(false), 2500); })
      .catch(() => toast.error('Копирането се провали'));
  }
  return (
    <>
      <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.45)]" onClick={onClose} />
      <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[620px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
        <div className="flex items-start gap-3 border-b border-ff-border px-6 pb-4 pt-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ff-green-50 text-ff-green-700"><FileSpreadsheet size={21} /></span>
          <div className="min-w-0">
            <h2 className="font-display text-[19px] font-extrabold tracking-[-0.015em] text-ff-ink">Как да структурирам файла</h2>
            <p className="mt-0.5 text-[12.5px] text-ff-muted">Една колона за всяко поле. Или остави ChatGPT да го направи вместо теб.</p>
          </div>
          <button onClick={onClose} aria-label="Затвори" className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="overflow-hidden rounded-xl border border-ff-border">
            <table className="w-full border-collapse text-left text-[12.5px]">
              <thead><tr className="border-b border-ff-border bg-ff-surface-2">
                <th className="px-3 py-2 font-bold uppercase tracking-[0.03em] text-ff-muted">Колона</th>
                <th className="px-3 py-2 font-bold uppercase tracking-[0.03em] text-ff-muted">Какво съдържа</th>
              </tr></thead>
              <tbody>
                {COLUMNS.map((c) => (
                  <tr key={c.name} className="border-b border-ff-border-2 last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 font-bold text-ff-ink">{c.name}</td>
                    <td className="px-3 py-2 text-ff-ink-2">{c.rule}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 rounded-xl border border-ff-green-100 bg-ff-green-50 p-4">
            <div className="flex items-center gap-2 text-[13.5px] font-extrabold text-ff-ink">
              <Sparkles size={16} className="text-ff-green-700" /> Най-лесно: остави ChatGPT да направи файла
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ff-ink-2">
              1. Копирай промпта долу. 2. Отвори ChatGPT и го залепи. 3. Добави данните за пратките. 4. Свали готовия файл и го качи тук.
            </p>
            <div className="mt-3 max-h-[180px] overflow-y-auto rounded-lg border border-ff-border bg-ff-surface p-3 font-mono text-[11.5px] leading-relaxed text-ff-ink-2 whitespace-pre-wrap">{CHATGPT_PROMPT}</div>
            <div className="mt-3 flex flex-wrap gap-2.5">
              <button onClick={copyPrompt} className="inline-flex items-center gap-1.5 rounded-xl bg-ff-green-700 px-3.5 py-2 text-[13px] font-bold text-white hover:brightness-95">
                {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Копирано' : 'Копирай промпта'}
              </button>
              <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">
                <ExternalLink size={15} /> Отвори ChatGPT
              </a>
            </div>
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
            <Download size={16} className="mt-0.5 shrink-0 text-ff-green-700" />
            <p className="text-[12.5px] leading-relaxed text-ff-ink-2">Предпочиташ празен шаблон? Затвори това и натисни <b>„Свали шаблон"</b> — готов Excel със същите колони и два примерни реда.</p>
          </div>
        </div>
      </div>
    </>
  );
}
