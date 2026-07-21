'use client';

/**
 * Farmer self-service Settings → „Моят профил": a producer sub-account's OWN
 * протокол identity (legal data + contact line) and reusable signature. Mirrors
 * LegalCard (the operator's equivalent), but scoped to `farmers/me` (own row
 * only — no id to tamper with) and with the phone/email line the handover
 * протокол also prints. The display `name` stays operator-owned; shown here as
 * read-only context.
 */
import * as React from 'react';
import { UserRound, PenLine } from 'lucide-react';
import { toast } from 'sonner';
import { SignaturePadField } from '@/components/handover/signature-pad-field';
import {
  ApiError,
  getMyFarmerProfile,
  getMyFarmerSignature,
  updateMyFarmerProfile,
  updateMyFarmerSignature,
} from '@/lib/api-client';

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[16px] sm:text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

type Kind = '' | 'individual' | 'sole_trader' | 'company';

export function MyFarmerProfileCard() {
  const [loading, setLoading] = React.useState(true);
  // A failed load must NOT fall through to an empty form: „Запази" sends the whole
  // legal block, so saving blank fields would wipe data the farmer never saw.
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [displayName, setDisplayName] = React.useState('');

  const [kind, setKind] = React.useState<Kind>('');
  const [legalName, setLegalName] = React.useState('');
  const [eik, setEik] = React.useState('');
  const [vatNumber, setVatNumber] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [regNo, setRegNo] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');

  React.useEffect(() => {
    let active = true;
    getMyFarmerProfile()
      .then((f) => {
        if (!active) return;
        setDisplayName(f.name ?? '');
        setKind((f.legal?.kind as Kind) ?? '');
        setLegalName(f.legal?.name ?? '');
        setEik(f.legal?.eik ?? '');
        setVatNumber(f.legal?.vatNumber ?? '');
        setAddress(f.legal?.address ?? '');
        setRegNo(f.legal?.regNo ?? '');
        setPhone(f.phone ?? '');
        setEmail(f.email ?? '');
      })
      .catch((e) => {
        if (!active) return;
        const m = errMsg(e, 'Неуспешно зареждане на профила');
        setLoadError(m);
        toast.error(m);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // Reusable signature for handover protocols — own endpoint, loaded independently
  // of the profile fields above (no id needed: the caller's own farmer row).
  const [sig, setSig] = React.useState<string | null>(null);
  const [sigLoaded, setSigLoaded] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    getMyFarmerSignature()
      .then((r) => active && setSig(r.signaturePng))
      .catch(() => {})
      .finally(() => active && setSigLoaded(true));
    return () => {
      active = false;
    };
  }, []);

  async function saveSig(png: string | null) {
    const prev = sig;
    setSig(png); // optimistic — signature-pad-field already reflects the new value
    try {
      await updateMyFarmerSignature(png);
      toast.success('Подписът е запазен');
    } catch (e) {
      setSig(prev); // don't let the UI claim "saved" when the write failed
      toast.error(errMsg(e, 'Подписът не беше записан'));
    }
  }

  async function save() {
    setSaving(true);
    try {
      const legal = {
        kind: kind || undefined,
        name: legalName.trim() || undefined,
        eik: eik.trim() || undefined,
        vatNumber: vatNumber.trim() || undefined,
        address: address.trim() || undefined,
        regNo: regNo.trim() || undefined,
      };
      await updateMyFarmerProfile({
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        legal,
      });
      toast.success('Профилът е запазен');
    } catch (e) {
      toast.error(errMsg(e, 'Профилът не беше записан'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-4 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
      <div className="flex items-center gap-1.5 text-[16px] font-extrabold">
        <UserRound size={17} /> Моят профил
      </div>
      <p className="mt-1 text-[13px] leading-snug text-ff-muted">
        Тези данни и подписът ти се отпечатват на приемо-предавателните протоколи.
      </p>

      {loading ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : loadError ? (
        <div className="mt-5 flex flex-col items-start gap-2">
          <p className="text-[13.5px] font-semibold text-ff-red">{loadError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex min-h-[44px] items-center rounded-sm border border-ff-border px-4 text-[14px] font-bold text-ff-ink-2"
          >
            Опитай пак
          </button>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          {displayName && (
            <p className="text-[12.5px] text-ff-muted">
              Име във витрината: <span className="font-bold text-ff-ink-2">{displayName}</span>{' '}
              (управлява се от оператора)
            </p>
          )}
          <label className={labelCls}>
            Вид производител
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={field}>
              <option value="">— избери —</option>
              <option value="individual">Физическо лице</option>
              <option value="sole_trader">ЕТ (едноличен търговец)</option>
              <option value="company">Фирма (ЕООД / ООД / АД)</option>
            </select>
          </label>
          <label className={labelCls}>
            Юридическо / фирмено име
            <input value={legalName} onChange={(e) => setLegalName(e.target.value)} className={field} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              {kind === 'individual' ? 'Рег. №' : 'ЕИК / БУЛСТАТ'}
              <input
                value={kind === 'individual' ? regNo : eik}
                onChange={(e) => (kind === 'individual' ? setRegNo(e.target.value) : setEik(e.target.value))}
                inputMode="numeric"
                className={field}
              />
            </label>
            <label className={labelCls}>
              ДДС № (по избор)
              <input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} className={field} />
            </label>
          </div>
          <label className={labelCls}>
            Адрес
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={field} />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              Телефон
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                className={field}
              />
            </label>
            <label className={labelCls}>
              Имейл
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                inputMode="email"
                type="email"
                className={field}
              />
            </label>
          </div>

          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-sm bg-ff-green-700 px-4 py-2.5 text-[15px] font-bold text-white transition-colors hover:bg-ff-green-800 disabled:opacity-60"
          >
            {saving ? 'Записване…' : 'Запази'}
          </button>
        </div>
      )}

      <div className="mt-6 border-t border-ff-border-2 pt-5">
        <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
          <PenLine size={14} /> Подпис за протоколи
        </div>
        <p className="mt-1.5 text-[12px] leading-snug text-ff-muted">
          Подпиши се веднъж — при предаване на продукция протоколът се подписва
          автоматично с този подпис.
        </p>
        {sigLoaded && (
          <div className="mt-3">
            <SignaturePadField value={sig} onChange={saveSig} label="Моят подпис" />
          </div>
        )}
      </div>
    </section>
  );
}
