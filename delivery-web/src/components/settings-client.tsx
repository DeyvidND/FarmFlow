'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Truck, Zap, Plug, CheckCircle2, XCircle, AlertTriangle, Check, Sparkles, MapPin } from 'lucide-react';
import {
  ApiError, getAccountStatus, getEcontConfig, getSpeedyConfig, saveEcontCredentials, saveSpeedyCredentials,
  disconnectEcont, disconnectSpeedy,
  type EcontConfig, type SpeedyConfig,
} from '@/lib/api-client';
import { getImportPrefs, setImportPref, type ImportPrefs } from '@/lib/import-prefs';
import { cn } from '@/lib/utils';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const inp = 'h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[14px] outline-none focus:border-ff-green-500';
const lbl = 'mb-1 block text-[12.5px] font-bold text-ff-muted';
const card = 'rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-5 shadow-ff-sm';

function StatusBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-green-50 px-2.5 py-1 text-[12px] font-bold text-ff-green-700">
      <CheckCircle2 size={14} /> Свързан
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-badge-bg px-2.5 py-1 text-[12px] font-bold text-ff-badge-ink">
      <XCircle size={14} /> Не е свързан
    </span>
  );
}

/** Read-only environment line. The environment is set by the administrator (a demo
 *  account uses the demo environment), so the operator only sees it — never picks it. */
function EnvRow({ isDemo }: { isDemo: boolean | null }) {
  if (isDemo === null) return null;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface-2 px-3.5 py-2.5">
      <span className="text-[12.5px] font-bold text-ff-muted">Среда:</span>
      {isDemo ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-amber-softer px-2.5 py-0.5 text-[12px] font-bold text-ff-amber-600">Демо (тестова)</span>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-green-50 px-2.5 py-0.5 text-[12px] font-bold text-ff-green-700">Реална</span>
      )}
      <span className="ml-auto text-[11px] text-ff-muted">Управлява се от администратор</span>
    </div>
  );
}

type Section = 'carriers' | 'checks' | 'password';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'carriers', label: 'Куриерски акаунти' },
  { id: 'checks', label: 'Проверки при внос' },
  { id: 'password', label: 'Смяна на парола' },
];

/** A row with an icon, title, helper text and an on/off switch on the right. */
function ToggleRow({
  icon: Icon, title, desc, checked, onChange,
}: { icon: typeof Sparkles; title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3.5 rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-green-50 text-ff-green-700">
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px] font-extrabold text-ff-ink">{title}</div>
        <p className="mt-0.5 text-[13px] leading-snug text-ff-ink-2">{desc}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-ff-green-600' : 'bg-ff-border',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-ff-sm transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
    </div>
  );
}

function ChecksSection() {
  const [prefs, setPrefs] = useState<ImportPrefs>({ aiAudit: true, addressCheck: true });

  useEffect(() => { setPrefs(getImportPrefs()); }, []);

  function update(key: keyof ImportPrefs, value: boolean) {
    setImportPref(key, value);
    setPrefs((p) => ({ ...p, [key]: value }));
    toast.success(value ? 'Проверката е включена' : 'Проверката е изключена');
  }

  return (
    <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
      <h2 className="text-[16px] font-extrabold">Проверки при внос</h2>
      <p className="mt-1 mb-4 text-[13.5px] text-ff-muted">
        Изключи някоя проверка, ако искаш по-бърз внос. Прилага се при следващото качване на файл.
      </p>
      <div className="flex flex-col gap-3">
        <ToggleRow
          icon={Sparkles}
          title="Одит с ChatGPT"
          desc="ChatGPT преглежда редовете и маркира съмнителни имена, телефони и градове. Изисква интернет; малко по-бавно."
          checked={prefs.aiAudit}
          onChange={(v) => update('aiAudit', v)}
        />
        <ToggleRow
          icon={MapPin}
          title="Проверка на адреси"
          desc="Сверява адресите с Google и предлага поправка, ако адресът не се намира. Само за доставка „адрес“."
          checked={prefs.addressCheck}
          onChange={(v) => update('addressCheck', v)}
        />
      </div>
    </div>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const btn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setDone(false);

    if (next.length < 8) { setError('Новата парола трябва да е поне 8 символа'); return; }
    if (next !== confirm) { setError('Паролите не съвпадат'); return; }

    setLoading(true);
    try {
      const res = await fetch('/api/session/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = (data?.message as string | undefined) ?? 'Грешна текуща парола';
        setError(msg);
        return;
      }
      setCurrent(''); setNext(''); setConfirm('');
      setDone(true);
      toast.success('Паролата е сменена успешно');
    } catch {
      setError('Възникна грешка. Опитай отново.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
      <h2 className="mb-4 text-[16px] font-extrabold">Смяна на парола</h2>

      {done && (
        <div className="mb-4 flex items-center gap-2.5 rounded-[10px] border border-ff-green-100 bg-ff-green-50 px-4 py-3 text-[13.5px] font-semibold text-ff-green-800">
          <Check size={17} strokeWidth={2.6} className="shrink-0 text-ff-green-600" />
          Паролата е сменена успешно. Следващия път влез с новата парола.
        </div>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div>
          <label className={lbl} htmlFor="pw-current">Текуща парола</label>
          <input id="pw-current" type="password" className={inp} placeholder="••••••••" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className={lbl} htmlFor="pw-new">Нова парола</label>
          <input id="pw-new" type="password" className={inp} placeholder="••••••••" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div>
          <label className={lbl} htmlFor="pw-confirm">Потвърди нова парола</label>
          <input id="pw-confirm" type="password" className={inp} placeholder="••••••••" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        {error && <p className="text-[13px] font-semibold text-ff-red">{error}</p>}

        <button type="submit" disabled={loading} className={btn + ' mt-0.5 w-full'}>
          {loading ? 'Зареждане…' : 'Смени паролата'}
        </button>
      </form>
    </div>
  );
}

export function SettingsClient() {
  const [section, setSection] = useState<Section>('carriers');

  const [econt, setEcont] = useState<EcontConfig | null>(null);
  const [speedy, setSpeedy] = useState<SpeedyConfig | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  // Account-level demo flag (set by super-admin) — same for both carriers.
  const [isDemo, setIsDemo] = useState<boolean | null>(null);

  const [econtForm, setEcontForm] = useState({ username: '', password: '' });
  const [speedyForm, setSpeedyForm] = useState({ userName: '', password: '' });

  const [savingE, setSavingE] = useState(false);
  const [savingS, setSavingS] = useState(false);

  const [editE, setEditE] = useState(false);
  const [editS, setEditS] = useState(false);

  useEffect(() => {
    getAccountStatus()
      .then((s) => setActive(s.active))
      .catch(() => setActive(null));
    getEcontConfig()
      .then((c) => {
        setEcont(c);
        if (typeof c.isDemo === 'boolean') setIsDemo(c.isDemo);
        setEcontForm((f) => ({ ...f, username: c.username ?? '' }));
      })
      .catch((e) => toast.error(`Econt: ${errMsg(e)}`));
    getSpeedyConfig()
      .then((c) => {
        setSpeedy(c);
        if (typeof c.isDemo === 'boolean') setIsDemo(c.isDemo);
        setSpeedyForm((f) => ({
          ...f,
          userName: c.userName ?? '',
        }));
      })
      .catch((e) => toast.error(`Speedy: ${errMsg(e)}`));
  }, []);

  async function saveEcont(e: React.FormEvent) {
    e.preventDefault();
    setSavingE(true);
    try {
      const res = await saveEcontCredentials({
        username: econtForm.username.trim(),
        password: econtForm.password,
      });
      toast.success('Econt е свързан');
      setEcontForm((f) => ({ ...f, password: '' }));
      // Use the save response to flip the badge instead of re-fetching the whole
      // config (the mount-loaded fields are still valid; only `configured` changes).
      setEcont((c) => ({ ...(c ?? {}), configured: res.configured }));
      setEditE(false);
    } catch (err) { toast.error(errMsg(err)); } finally { setSavingE(false); }
  }

  async function saveSpeedy(e: React.FormEvent) {
    e.preventDefault();
    setSavingS(true);
    try {
      const res = await saveSpeedyCredentials({
        userName: speedyForm.userName.trim(),
        password: speedyForm.password,
      });
      toast.success('Speedy е свързан');
      setSpeedyForm((f) => ({ ...f, password: '' }));
      // Use the save response to flip the badge instead of re-fetching the whole config.
      setSpeedy((c) => ({ ...(c ?? {}), configured: res.configured }));
      setEditS(false);
    } catch (err) { toast.error(errMsg(err)); } finally { setSavingS(false); }
  }

  async function disconnectEcontFn() {
    if (!confirm('Да премахна ли връзката с Еконт? Данните на подателя се запазват.')) return;
    try {
      await disconnectEcont();
      setEcont((c) => ({ ...(c ?? {}), configured: false }));
      setEcontForm({ username: '', password: '' });
      setEditE(false);
      toast.success('Еконт е премахнат');
    } catch (e) { toast.error(errMsg(e)); }
  }

  async function disconnectSpeedyFn() {
    if (!confirm('Да премахна ли връзката със Speedy? Данните на подателя се запазват.')) return;
    try {
      await disconnectSpeedy();
      setSpeedy((c) => ({ ...(c ?? {}), configured: false }));
      setSpeedyForm({ userName: '', password: '' });
      setEditS(false);
      toast.success('Speedy е премахнат');
    } catch (e) { toast.error(errMsg(e)); }
  }

  const btn = 'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ff-green-700 px-4 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60';

  return (
    <div className="animate-ff-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Настройки</h1>
        {active !== null && (
          active ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ff-green-50 px-3 py-1 text-[12.5px] font-bold text-ff-green-700">
              <CheckCircle2 size={15} /> Услугата е активна
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FBE9E7] px-3 py-1 text-[12.5px] font-bold text-ff-red">
              <XCircle size={15} /> Услугата не е активна
            </span>
          )
        )}
      </div>
      <p className="mt-1 text-[13.5px] text-ff-muted">
        Управлявай настройките на профила си.
      </p>

      <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-start md:gap-6">
        {/* Left nav */}
        <nav className="flex flex-row gap-2 overflow-x-auto md:w-[210px] md:shrink-0 md:flex-col md:gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={cn(
                'whitespace-nowrap rounded-xl border px-4 py-2.5 text-left text-[13.5px] font-bold transition-colors',
                section === s.id
                  ? 'border-ff-green-700 bg-ff-green-50 text-ff-green-800'
                  : 'border-transparent bg-transparent text-ff-ink-2 hover:bg-ff-surface-2',
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div key={section} className="min-w-0 flex-1 animate-ff-fade-up">
          {section === 'carriers' && (
            <>
              {active === false && (
                <div className="mb-5 flex items-start gap-3 rounded-xl border border-[#e7c9a0] bg-ff-amber-softer p-4">
                  <AlertTriangle size={20} className="mt-0.5 shrink-0 text-ff-amber-600" />
                  <div>
                    <div className="text-[14px] font-bold text-ff-ink">Услугата още не е активна</div>
                    <p className="mt-0.5 text-[13px] leading-snug text-ff-ink-2">
                      Свържи куриерските акаунти по-долу. Активирането се прави от администратор — щом услугата е активна, ще можеш да създаваш пратки и да ползваш проверка на клиент.
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {/* ---- Econt ---- */}
                <form onSubmit={saveEcont} className={card}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="grid h-9 w-9 place-items-center rounded-[10px] bg-ff-green-50 text-ff-green-700">
                        <Truck size={19} />
                      </div>
                      <h2 className="font-display text-[18px] font-extrabold">Econt</h2>
                    </div>
                    <StatusBadge configured={!!econt?.configured} />
                  </div>

                  {econt?.configured && !editE ? (
                    <div className="mt-4">
                      <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-green-700">
                        <CheckCircle2 size={16} /> Свързан{econt?.username ? <span className="text-ff-ink-2 font-semibold"> · потребител {econt.username}</span> : null}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button type="button" onClick={() => setEditE(true)} className="rounded-xl border border-ff-border px-4 py-2 text-[13px] font-bold">Промени</button>
                        <button type="button" onClick={disconnectEcontFn} className="rounded-xl border border-[#e7b8b0] px-4 py-2 text-[13px] font-bold text-ff-red">Премахни</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 space-y-3">
                        <EnvRow isDemo={isDemo} />
                        <div>
                          <label className={lbl} htmlFor="econt-user">Потребител</label>
                          <input id="econt-user" className={inp} autoComplete="off" value={econtForm.username} onChange={(e) => setEcontForm({ ...econtForm, username: e.target.value })} />
                        </div>
                        <div>
                          <label className={lbl} htmlFor="econt-pass">Парола</label>
                          <input id="econt-pass" type="password" className={inp} autoComplete="new-password" placeholder={econt?.configured ? 'Въведи нова, за да смениш' : ''} value={econtForm.password} onChange={(e) => setEcontForm({ ...econtForm, password: e.target.value })} />
                        </div>
                      </div>
                      <button type="submit" disabled={savingE || !econtForm.username.trim() || !econtForm.password} className={btn + ' mt-4 w-full'}>
                        <Plug size={16} /> {savingE ? 'Запазвам…' : 'Запази'}
                      </button>
                    </>
                  )}
                </form>

                {/* ---- Speedy ---- */}
                <form onSubmit={saveSpeedy} className={card}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="grid h-9 w-9 place-items-center rounded-[10px] bg-ff-amber-softer text-ff-amber-600">
                        <Zap size={19} />
                      </div>
                      <h2 className="font-display text-[18px] font-extrabold">Speedy</h2>
                    </div>
                    <StatusBadge configured={!!speedy?.configured} />
                  </div>

                  {speedy?.configured && !editS ? (
                    <div className="mt-4">
                      <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-green-700">
                        <CheckCircle2 size={16} /> Свързан{speedy?.userName ? <span className="text-ff-ink-2 font-semibold"> · потребител {speedy.userName}</span> : null}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button type="button" onClick={() => setEditS(true)} className="rounded-xl border border-ff-border px-4 py-2 text-[13px] font-bold">Промени</button>
                        <button type="button" onClick={disconnectSpeedyFn} className="rounded-xl border border-[#e7b8b0] px-4 py-2 text-[13px] font-bold text-ff-red">Премахни</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 space-y-3">
                        <EnvRow isDemo={isDemo} />
                        <div>
                          <label className={lbl} htmlFor="speedy-user">Потребител</label>
                          <input id="speedy-user" className={inp} autoComplete="off" value={speedyForm.userName} onChange={(e) => setSpeedyForm({ ...speedyForm, userName: e.target.value })} />
                        </div>
                        <div>
                          <label className={lbl} htmlFor="speedy-pass">Парола</label>
                          <input id="speedy-pass" type="password" className={inp} autoComplete="new-password" placeholder={speedy?.configured ? 'Въведи нова, за да смениш' : ''} value={speedyForm.password} onChange={(e) => setSpeedyForm({ ...speedyForm, password: e.target.value })} />
                        </div>
                      </div>
                      <button type="submit" disabled={savingS || !speedyForm.userName.trim() || !speedyForm.password} className={btn + ' mt-4 w-full'}>
                        <Plug size={16} /> {savingS ? 'Запазвам…' : 'Запази'}
                      </button>
                    </>
                  )}
                </form>
              </div>
            </>
          )}

          {section === 'checks' && <ChecksSection />}

          {section === 'password' && <PasswordSection />}
        </div>
      </div>
    </div>
  );
}
