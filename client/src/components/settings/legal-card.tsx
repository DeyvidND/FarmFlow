'use client';

/**
 * Settings → легални данни на оператора. Shown as the „Приел"/„Предал" party on
 * приемо-предавателни протоколи и разписки (handover-protocol feature). Mirrors the
 * farmer legal-identity card's fields; writes to tenants.settings.legal.
 */
import * as React from 'react';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { SaveBar } from '@/components/panels/panel-ui';
import { SignaturePadField } from '@/components/handover/signature-pad-field';
import {
  ApiError,
  getOperatorSignature,
  getTenantLegal,
  updateOperatorSignature,
  updateTenantLegal,
} from '@/lib/api-client';
import type { LegalIdentity } from '@/lib/types';
import { buildLegalPayload, isLegalDirty, type LegalFormFields, type LegalKind } from '@/lib/legal-identity';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const field =
  'w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[16px] sm:text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

type Kind = LegalKind;

export function LegalCard() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<LegalIdentity | null>(null);
  const [kind, setKind] = React.useState<Kind>('');
  const [name, setName] = React.useState('');
  const [eik, setEik] = React.useState('');
  const [vatNumber, setVatNumber] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [regNo, setRegNo] = React.useState('');

  React.useEffect(() => {
    let active = true;
    getTenantLegal()
      .then((legal) => {
        if (!active) return;
        setSaved(legal ?? {});
        setKind((legal?.kind as Kind) ?? '');
        setName(legal?.name ?? '');
        setEik(legal?.eik ?? '');
        setVatNumber(legal?.vatNumber ?? '');
        setAddress(legal?.address ?? '');
        setRegNo(legal?.regNo ?? '');
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // Reusable operator signature for handover protocols — own endpoint, loaded
  // independently of the legal fields above (no id needed: current tenant).
  const [sig, setSig] = React.useState<string | null>(null);
  const [sigLoaded, setSigLoaded] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    getOperatorSignature()
      .then((r) => active && setSig(r.signaturePng))
      .catch(() => {})
      .finally(() => active && setSigLoaded(true));
    return () => {
      active = false;
    };
  }, []);

  async function saveSig(png: string | null) {
    const prev = sig;
    setSig(png);
    try {
      await updateOperatorSignature(png);
      toast.success('Подписът е запазен');
    } catch (e) {
      setSig(prev); // don't let the UI claim "saved" when the write failed
      toast.error(errMsg(e));
    }
  }

  // Sends ONLY the identifier matching the chosen kind. One input backs two
  // states here too, so without the filter a физическо лице could ship a value
  // in both `eik` and `regNo` and the protocol would print the wrong one —
  // see buildLegalPayload.
  const fields: LegalFormFields = { kind, name, eik, vatNumber, address, regNo };
  const current: LegalIdentity = buildLegalPayload(fields);
  // `isLegalDirty` normalises BOTH sides through buildLegalPayload and compares
  // field by field. The previous inline check stringified two literals whose key
  // orders disagreed, so an untouched identity with an address AND an ЕИК always
  // read as dirty — and since the SaveBar renders only while dirty, it never went
  // away after a save. See the regression tests in lib/legal-identity.test.ts.
  const dirty = isLegalDirty(fields, saved);

  const save = async () => {
    setSaving(true);
    try {
      const legal = await updateTenantLegal(current);
      setSaved(legal);
      toast.success('Данните са обновени');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setKind((saved?.kind as Kind) ?? '');
    setName(saved?.name ?? '');
    setEik(saved?.eik ?? '');
    setVatNumber(saved?.vatNumber ?? '');
    setAddress(saved?.address ?? '');
    setRegNo(saved?.regNo ?? '');
  };

  return (
    <section className={cn('rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm', dirty && 'mb-16')}>
      <div className="flex items-center gap-1.5 text-[16px] font-extrabold">
        <FileText size={17} /> Легални данни
      </div>
      <p className="mt-1 text-[13px] leading-snug text-ff-muted">
        Данни на оператора — показват се като насрещна страна на приемо-предавателните
        протоколи и разписките за доставка.
      </p>

      {loading ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          <label className={labelCls}>
            Вид оператор
            <select
              value={kind}
              onChange={(e) => {
                const next = e.target.value as Kind;
                setKind(next);
                // Drop the identifier that no longer applies, so a value the
                // operator can no longer SEE can't survive in state.
                if (next === 'individual') {
                  setEik('');
                  setVatNumber('');
                } else {
                  setRegNo('');
                }
              }}
              className={field}
            >
              <option value="">— избери —</option>
              <option value="individual">Физическо лице</option>
              <option value="sole_trader">ЕТ (едноличен търговец)</option>
              <option value="company">Фирма (ЕООД / ООД / АД)</option>
            </select>
          </label>
          <label className={labelCls}>
            Юридическо / фирмено име
            <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
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
            Адрес на управление / кореспонденция
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={field} />
          </label>
          {saved?.confirmedAt && (
            <p className="text-[11px] font-semibold text-ff-muted">
              Последно потвърдено: {new Date(saved.confirmedAt).toLocaleDateString('bg-BG')}
            </p>
          )}
        </div>
      )}

      <div className="mt-6 border-t border-ff-border-2 pt-5">
        <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
          <FileText size={14} /> Подпис за протоколи
        </div>
        <p className="mt-1.5 text-[12px] leading-snug text-ff-muted">
          Подпишете се веднъж — при предаване на продукция протоколът се подписва
          автоматично.
        </p>
        {sigLoaded && (
          <div className="mt-3">
            <SignaturePadField value={sig} onChange={saveSig} label="Подпис на оператора" />
          </div>
        )}
      </div>

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={discard} />}
    </section>
  );
}
