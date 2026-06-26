'use client';

import { useState, useEffect, useRef, Fragment } from 'react';
import { toast } from 'sonner';
import { UploadCloud, FileDown, Download, FileSpreadsheet, ListChecks, Scale, HelpCircle, Copy, Check, ExternalLink, X, Sparkles, ShieldCheck, ShieldAlert, ShieldX, Loader2, Clock, CloudOff, Info, Truck, Zap, ArrowRight } from 'lucide-react';
import {
  ApiError, uploadBatch, patchRow, deleteRow, commitBatch, downloadLabels, templateUrl, compareShipment, riskCheckBulk,
  type ImportRow, type QuoteResult, type RiskBulkEntry, type RiskBulkMeta,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const priceEur = (st: number | null | undefined) => (st == null ? '—' : `${(st / 100).toFixed(2)} €`);

/** Drop trailing zeros from a number for display in an editable field (2 → "2", 1.5 → "1.5"). */
const trimNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));

/** Strip all non-digit characters and return the last 9 digits (Bulgarian mobile suffix). */
function last9digits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-9);
}

/** Weight field shown to the farmer in KILOGRAMS, stored as grams. Keeps its own text
 *  state so decimals type smoothly ("2." → "2.5" → "2.58"); commits grams on blur. */
function KgInput({ grams, onCommit, className }: { grams: number | null; onCommit: (g: number | null) => void; className: string }) {
  const [t, setT] = useState(grams == null ? '' : trimNum(grams / 1000));
  useEffect(() => { setT(grams == null ? '' : trimNum(grams / 1000)); }, [grams]);
  return (
    <input
      className={className} inputMode="decimal" placeholder="кг"
      value={t}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => { const n = parseFloat(t.replace(',', '.')); onCommit(t.trim() === '' || isNaN(n) ? null : Math.round(n * 1000)); }}
    />
  );
}

/** COD field shown in EUROS, stored as euro-cents. Same smooth-decimal behaviour as KgInput. */
function EurInput({ cents, onCommit, className }: { cents: number | null; onCommit: (c: number | null) => void; className: string }) {
  const [t, setT] = useState(cents == null ? '' : trimNum(cents / 100));
  useEffect(() => { setT(cents == null ? '' : trimNum(cents / 100)); }, [cents]);
  return (
    <input
      className={className} inputMode="decimal" placeholder="€"
      value={t}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => { const n = parseFloat(t.replace(',', '.')); onCommit(t.trim() === '' || isNaN(n) ? null : Math.round(n * 100)); }}
    />
  );
}

/** Looks like a single-line field but grows vertically to fit long content
 *  (names, addresses) so nothing is clipped in the table. No external dependency. */
function AutoTextarea({ value, onChange, onBlur, className, placeholder }: {
  value: string; onChange: (v: string) => void; onBlur: () => void; className: string; placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(fit, [value]);
  return (
    <textarea
      ref={ref} rows={1} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
      className={`resize-none overflow-hidden ${className}`}
    />
  );
}

const CARRIER_META = {
  econt: { label: 'Еконт', icon: Truck },
  speedy: { label: 'Спиди', icon: Zap },
} as const;

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
  { icon: Scale, title: 'Потвърди поръчки', desc: 'Един бутон — системата сравнява Еконт и Спиди и праща с по-евтиния.' },
] as const;

/** Per-carrier batch totals computed inside the confirm modal. */
interface BatchCompare {
  loading: boolean;
  count: number;                          // committable rows
  econt: { total: number; unavail: number };
  speedy: { total: number; unavail: number };
  recommend: 'econt' | 'speedy' | null;
  chosen: 'econt' | 'speedy' | null;
  failed: number;
}

export function ImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [ai, setAi] = useState('');
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  // Confirm-and-send flow: one modal compares both carriers for the whole batch.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cmp, setCmp] = useState<BatchCompare | null>(null);
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

  // Price a single carrier from a row's quote result (null = unavailable / not priced).
  const carrierPrice = (q: QuoteResult | undefined, c: 'econt' | 'speedy') => {
    const entry = q?.quotes.find((x) => x.carrier === c);
    return entry && entry.available ? entry.priceStotinki : null;
  };

  // Open the confirm modal and price the WHOLE batch with both carriers, so the operator
  // ships every order with the single cheaper courier. Runs a tiny concurrency pool to
  // stay under the compare throttle (30/min).
  async function openConfirm() {
    const targets = rows.filter((r) => r.validationStatus !== 'error' && r.city && r.deliveryMode);
    if (!targets.length) { toast.error('Няма готови поръчки за изпращане — поправи редовете в червено.'); return; }
    setCmp({ loading: true, count: targets.length, econt: { total: 0, unavail: 0 }, speedy: { total: 0, unavail: 0 }, recommend: null, chosen: null, failed: 0 });
    setConfirmOpen(true);

    let eSum = 0, eUn = 0, sSum = 0, sUn = 0, failed = 0;
    const queue = [...targets];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          const q = await compareShipment({ destinationCity: r.city!, deliveryMode: r.deliveryMode!, weightGrams: r.weightGrams ?? undefined });
          const ep = carrierPrice(q, 'econt');
          const sp = carrierPrice(q, 'speedy');
          if (ep == null) eUn++; else eSum += ep;
          if (sp == null) sUn++; else sSum += sp;
        } catch { failed++; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    // A carrier is "viable" for the batch only if it can serve EVERY row.
    const eViable = eUn === 0, sViable = sUn === 0;
    let recommend: 'econt' | 'speedy' | null;
    if (eViable && sViable) recommend = eSum <= sSum ? 'econt' : 'speedy';
    else if (eViable) recommend = 'econt';
    else if (sViable) recommend = 'speedy';
    else recommend = eSum <= sSum ? 'econt' : 'speedy'; // neither fully covers — least-bad
    setCmp({ loading: false, count: targets.length, econt: { total: eSum, unavail: eUn }, speedy: { total: sSum, unavail: sUn }, recommend, chosen: recommend, failed });
  }

  // Persist the chosen carrier on every committable row, then create all shipments.
  async function confirmSend() {
    if (!batchId || !cmp?.chosen) return;
    const chosen = cmp.chosen;
    setConfirmOpen(false);
    setBusy(true);
    try {
      const targets = rows.filter((r) => r.validationStatus !== 'error' && r.carrier !== chosen);
      await Promise.all(targets.map((r) => patchRow(batchId, r.id, { carrier: chosen })));
      setRows((p) => p.map((x) => (x.validationStatus !== 'error' ? { ...x, carrier: chosen } : x)));
      const res = await commitBatch(batchId);
      const created = res.results.filter((x) => x.status === 'created').length;
      toast.success(`Създадени ${created} ${created === 1 ? 'пратка' : 'пратки'} с ${CARRIER_META[chosen].label}`);
      if (res.failed) toast.error(`${res.failed} реда не успяха — виж „Проблеми".`);
      const { getBatch } = await import('@/lib/api-client');
      setRows((await getBatch(batchId)).rows);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
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

  const labelIds = (carrier: 'econt' | 'speedy') => rows.filter((r) => r.shipmentId && r.carrier === carrier).map((r) => r.shipmentId!) as string[];

  async function labels(carrier: 'econt' | 'speedy') {
    try { await downloadLabels(carrier, labelIds(carrier)); }
    catch (e) { toast.error(errMsg(e)); }
  }

  function patch(r: ImportRow, k: keyof ImportRow, v: unknown) {
    setRows((p) => p.map((x) => (x.id === r.id ? { ...x, [k]: v } : x)));
  }

  // Roomier, more legible fields — farmers, not power users.
  const inp = 'h-10 w-full min-w-0 rounded-lg border border-ff-border bg-ff-surface px-3 text-[14px] outline-none focus:border-ff-green-500';
  const inpNum = 'h-10 w-full min-w-0 rounded-lg border border-ff-border bg-ff-surface px-3 text-right text-[14px] tabular-nums outline-none focus:border-ff-green-500';
  // Auto-growing free-text fields (name, address) — wrap instead of clipping long values.
  const inpTa = 'block w-full min-w-0 rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] leading-snug outline-none focus:border-ff-green-500';
  const rowBg = (s: string) => (s === 'ok' ? 'bg-ff-green-50' : s === 'warn' ? 'bg-ff-amber-softer' : 'bg-[#FBE9E7]');
  const primaryBtn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60';
  const outlineBtn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-4 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2';

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
      <p className="mt-1 text-[13.5px] text-ff-muted">Качи Excel или CSV с поръчки. Накрая натисни „Потвърди поръчки" — куриерът се избира сам, по най-добра цена за цялата партида.</p>

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
            <button onClick={() => void openConfirm()} disabled={busy} className="ml-auto inline-flex h-11 items-center gap-2 rounded-xl bg-ff-green-700 px-5 text-[14px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />} {busy ? 'Създавам…' : 'Потвърди поръчки'}
            </button>
            {labelIds('econt').length > 0 && <button onClick={() => void labels('econt')} className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"><FileDown size={15} /> Етикети (Еконт)</button>}
            {labelIds('speedy').length > 0 && <button onClick={() => void labels('speedy')} className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-ff-border bg-ff-surface px-3 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"><FileDown size={15} /> Етикети (Спиди)</button>}
          </div>
          <p className="mt-2 text-[12px] text-ff-muted">„Потвърди поръчки" сравнява Еконт и Спиди и праща цялата партида с по-евтиния куриер — без да попълваш нищо ръчно.</p>

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

          {/* desktop table — fluid widths, long text wraps; problems shown as a full-width sub-row */}
          <div className="mt-3 overflow-x-auto rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:hidden">
            <table className="w-full border-collapse text-[14px]">
              <thead><tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {[
                  { h: '#', w: 'w-9' }, { h: 'Получател', w: 'min-w-[150px]' }, { h: 'Телефон', w: 'w-40' }, { h: 'Доставка', w: 'w-28' },
                  { h: 'Град', w: 'w-32' }, { h: 'Офис/Адрес', w: 'min-w-[180px]' }, { h: 'Тегло (кг)', w: 'w-20' }, { h: 'Платеж (€)', w: 'w-24' },
                  { h: 'Риск', w: 'w-28' }, { h: '', w: 'w-12' },
                ].map(({ h, w }) => (
                  <th key={h} className={`px-3 py-3 align-middle text-[11.5px] font-bold uppercase tracking-[0.03em] text-ff-muted ${w}`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const issues = (r.validation?.issues ?? []).map((i) => i.message).filter(Boolean);
                  return (
                    <Fragment key={r.id}>
                      <tr className={`${issues.length ? '' : 'border-b border-ff-border-2'} last:border-0 ${rowBg(r.validationStatus)}`}>
                        <td className="px-3 py-2.5 align-top text-ff-muted"><div className="flex h-10 items-center">{r.rowIndex}</div></td>
                        <td className="px-3 py-2.5 align-top"><AutoTextarea className={inpTa} value={r.receiverName ?? ''} onChange={(v) => patch(r, 'receiverName', v)} onBlur={() => save(r)} /></td>
                        <td className="px-3 py-2.5 align-top"><input className={inp} value={r.receiverPhone ?? ''} onChange={(e) => patch(r, 'receiverPhone', e.target.value)} onBlur={() => save(r)} /></td>
                        <td className="px-3 py-2.5 align-top"><select className={inp} value={r.deliveryMode ?? 'office'} onChange={(e) => { patch(r, 'deliveryMode', e.target.value); }} onBlur={() => save(r)}><option value="office">офис</option><option value="address">адрес</option></select></td>
                        <td className="px-3 py-2.5 align-top"><input className={inp} value={r.city ?? ''} onChange={(e) => patch(r, 'city', e.target.value)} onBlur={() => save(r)} /></td>
                        <td className="px-3 py-2.5 align-top">
                          {r.deliveryMode === 'office'
                            ? <AutoTextarea className={inpTa} placeholder="Офис" value={r.office ?? ''} onChange={(v) => patch(r, 'office', v)} onBlur={() => save(r)} />
                            : <AutoTextarea className={inpTa} placeholder="Адрес" value={r.address ?? ''} onChange={(v) => patch(r, 'address', v)} onBlur={() => save(r)} />}
                        </td>
                        <td className="px-3 py-2.5 align-top"><KgInput className={inpNum} grams={r.weightGrams} onCommit={(g) => { patch(r, 'weightGrams', g); save({ ...r, weightGrams: g }); }} /></td>
                        <td className="px-3 py-2.5 align-top"><EurInput className={inpNum} cents={r.codAmountStotinki} onCommit={(c) => { patch(r, 'codAmountStotinki', c); save({ ...r, codAmountStotinki: c }); }} /></td>
                        <td className="px-3 py-2.5 align-top"><div className="flex h-10 items-center"><RiskBadge r={r} /></div></td>
                        <td className="px-3 py-2.5 align-top"><div className="flex h-10 items-center"><button onClick={() => del(r)} className="grid h-9 w-9 place-items-center rounded-lg border border-[#e0a0a0] text-ff-red hover:bg-[#FBE9E7]" aria-label="Изтрий реда"><X size={15} /></button></div></td>
                      </tr>
                      {issues.length > 0 && (
                        <tr className={`border-b border-ff-border-2 last:border-0 ${rowBg(r.validationStatus)}`}>
                          <td />
                          <td colSpan={9} className={`px-3 pb-2.5 pt-0 text-[12.5px] leading-snug ${r.validationStatus === 'error' ? 'text-ff-red' : 'text-ff-amber-600'}`}>
                            <span className="font-bold">Проблеми:</span> {issues.join('; ')}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* mobile cards */}
          <div className="mt-3 hidden flex-col gap-3 max-[900px]:flex">
            {rows.map((r) => (
              <div key={r.id} className={`rounded-xl border-2 p-3.5 ${rowBg(r.validationStatus)} ${r.validationStatus === 'ok' ? 'border-[#a5d6a7]' : r.validationStatus === 'warn' ? 'border-[#ffe082]' : 'border-[#ef9a9a]'}`}>
                <label className="mb-2.5 grid grid-cols-[104px_1fr] items-start gap-2">
                  <span className="mt-2 text-[12.5px] font-bold text-ff-muted">Получател</span>
                  <AutoTextarea className={inpTa} value={r.receiverName ?? ''} onChange={(v) => patch(r, 'receiverName', v)} onBlur={() => save(r)} />
                </label>
                <label className="mb-2.5 grid grid-cols-[104px_1fr] items-center gap-2">
                  <span className="text-[12.5px] font-bold text-ff-muted">Телефон</span>
                  <input className={inp} type="tel" value={r.receiverPhone ?? ''} onChange={(e) => patch(r, 'receiverPhone', e.target.value)} onBlur={() => save(r)} />
                </label>
                <label className="mb-2.5 grid grid-cols-[104px_1fr] items-center gap-2">
                  <span className="text-[12.5px] font-bold text-ff-muted">Град</span>
                  <input className={inp} value={r.city ?? ''} onChange={(e) => patch(r, 'city', e.target.value)} onBlur={() => save(r)} />
                </label>
                <label className="mb-2.5 grid grid-cols-[104px_1fr] items-start gap-2">
                  <span className="mt-2 text-[12.5px] font-bold text-ff-muted">{r.deliveryMode === 'office' ? 'Офис' : 'Адрес'}</span>
                  {r.deliveryMode === 'office'
                    ? <AutoTextarea className={inpTa} value={r.office ?? ''} onChange={(v) => patch(r, 'office', v)} onBlur={() => save(r)} />
                    : <AutoTextarea className={inpTa} value={r.address ?? ''} onChange={(v) => patch(r, 'address', v)} onBlur={() => save(r)} />}
                </label>
                <label className="mb-2.5 grid grid-cols-[104px_1fr] items-center gap-2">
                  <span className="text-[12.5px] font-bold text-ff-muted">Доставка</span>
                  <select className={inp} value={r.deliveryMode ?? 'office'} onChange={(e) => patch(r, 'deliveryMode', e.target.value)} onBlur={() => save(r)}><option value="office">офис</option><option value="address">адрес</option></select>
                </label>
                <label className="mb-2.5 grid grid-cols-[104px_1fr] items-center gap-2">
                  <span className="text-[12.5px] font-bold text-ff-muted">Тегло (кг)</span>
                  <KgInput className={inpNum} grams={r.weightGrams} onCommit={(g) => { patch(r, 'weightGrams', g); save({ ...r, weightGrams: g }); }} />
                </label>
                <label className="mb-2.5 grid grid-cols-[104px_1fr] items-center gap-2">
                  <span className="text-[12.5px] font-bold text-ff-muted">Платеж (€)</span>
                  <EurInput className={inpNum} cents={r.codAmountStotinki} onCommit={(c) => { patch(r, 'codAmountStotinki', c); save({ ...r, codAmountStotinki: c }); }} />
                </label>
                {(r.validation?.issues ?? []).length > 0 && <p className="text-[12.5px] text-ff-red">{(r.validation?.issues ?? []).map((i) => i.message).join('; ')}</p>}
                <RiskBadge r={r} />
                <button onClick={() => del(r)} className="mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#e0a0a0] py-2 text-[12.5px] font-bold text-ff-red hover:bg-[#FBE9E7]"><X size={14} /> Изтрий</button>
              </div>
            ))}
          </div>
        </>
      )}

      {confirmOpen && cmp && (
        <ConfirmSendModal
          cmp={cmp}
          onChoose={(c) => setCmp((p) => (p ? { ...p, chosen: c } : p))}
          onConfirm={() => void confirmSend()}
          onClose={() => setConfirmOpen(false)}
        />
      )}
      {showGuide && <FileGuideModal onClose={() => setShowGuide(false)} />}
    </div>
  );
}

/** Confirm-and-send modal: compares both carriers for the whole batch and lets the
 *  operator ship every order with one (cheaper, pre-selected) courier. */
function ConfirmSendModal({
  cmp, onChoose, onConfirm, onClose,
}: {
  cmp: BatchCompare;
  onChoose: (c: 'econt' | 'speedy') => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const eViable = cmp.econt.unavail === 0;
  const sViable = cmp.speedy.unavail === 0;
  const savings = (!cmp.loading && eViable && sViable) ? Math.abs(cmp.econt.total - cmp.speedy.total) : 0;

  const Card = ({ c }: { c: 'econt' | 'speedy' }) => {
    const meta = CARRIER_META[c];
    const data = cmp[c];
    const viable = data.unavail === 0;
    const selected = cmp.chosen === c;
    const isRecommend = cmp.recommend === c;
    return (
      <button
        type="button"
        onClick={() => onChoose(c)}
        disabled={cmp.loading}
        className={`relative flex flex-1 flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-colors disabled:cursor-default
          ${selected ? 'border-ff-green-600 bg-ff-green-50' : 'border-ff-border bg-ff-surface hover:border-ff-green-300'}`}
      >
        {isRecommend && !cmp.loading && (
          <span className="absolute right-3 top-3 rounded-full bg-ff-green-700 px-2 py-0.5 text-[10.5px] font-extrabold uppercase tracking-wide text-white">Най-евтино</span>
        )}
        <span className="flex items-center gap-2 text-[15px] font-extrabold text-ff-ink">
          <meta.icon size={18} className="text-ff-green-700" /> {meta.label}
        </span>
        {cmp.loading ? (
          <span className="text-[13px] text-ff-muted">…</span>
        ) : (
          <>
            <span className="ff-fig text-[22px] font-extrabold tracking-[-0.01em] text-ff-ink">{priceEur(data.total)}</span>
            {viable
              ? <span className="text-[12px] text-ff-muted">за {cmp.count} {cmp.count === 1 ? 'пратка' : 'пратки'} · само доставка</span>
              : <span className="text-[12px] font-bold text-ff-amber-600">Не покрива {data.unavail} {data.unavail === 1 ? 'адрес' : 'адреса'}</span>}
          </>
        )}
      </button>
    );
  };

  return (
    <>
      <div className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.45)]" onClick={onClose} />
      <div className="animate-ff-pop fixed left-1/2 top-1/2 z-50 flex w-[540px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
        <div className="flex items-start gap-3 border-b border-ff-border px-6 pb-4 pt-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ff-green-50 text-ff-green-700"><Scale size={21} /></span>
          <div className="min-w-0">
            <h2 className="font-display text-[19px] font-extrabold tracking-[-0.015em] text-ff-ink">Потвърди поръчки</h2>
            <p className="mt-0.5 text-[12.5px] text-ff-muted">{cmp.count} {cmp.count === 1 ? 'поръчка' : 'поръчки'} · цялата партида тръгва с един куриер.</p>
          </div>
          <button onClick={onClose} aria-label="Затвори" className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2"><X size={18} /></button>
        </div>

        <div className="px-6 py-5">
          {cmp.loading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-ff-muted">
              <Loader2 size={26} className="animate-spin text-ff-green-700" />
              <span className="text-[13.5px] font-bold">Сравнявам цените на Еконт и Спиди…</span>
            </div>
          ) : (
            <>
              <div className="flex gap-3">
                <Card c="econt" />
                <Card c="speedy" />
              </div>
              {savings > 0 && cmp.recommend && (
                <p className="mt-3 text-center text-[13px] font-bold text-ff-green-700">
                  Спестяваш {priceEur(savings)} с {CARRIER_META[cmp.recommend].label}
                </p>
              )}
              {!eViable && !sViable && (
                <p className="mt-3 text-center text-[12.5px] font-bold text-ff-amber-600">
                  Нито един куриер не покрива всички адреси — провери градовете/офисите.
                </p>
              )}
              {cmp.failed > 0 && (
                <p className="mt-2 text-center text-[12px] text-ff-muted">{cmp.failed} реда не успяха да се остойностят.</p>
              )}
              <p className="mt-3 text-center text-[11.5px] text-ff-muted">Цената е само за доставка, без наложения платеж.</p>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-ff-border bg-ff-surface-2 px-6 py-4">
          <button onClick={onClose} className="inline-flex h-11 items-center justify-center rounded-xl border border-ff-border bg-ff-surface px-4 text-[13.5px] font-bold text-ff-ink-2 hover:bg-ff-surface">Отказ</button>
          <button
            onClick={onConfirm}
            disabled={cmp.loading || !cmp.chosen}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-5 text-[14px] font-bold text-white shadow-ff-sm hover:brightness-95 disabled:opacity-60"
          >
            <Truck size={16} />
            {cmp.chosen ? `Изпрати с ${CARRIER_META[cmp.chosen].label}` : 'Изпрати'}
          </button>
        </div>
      </div>
    </>
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
  { name: 'Куриер', rule: 'остави празно — системата избира най-евтиния за цялата партида' },
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
- Куриер: остави празно — системата избира най-евтиния

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
