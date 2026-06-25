'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Truck, Plug, CheckCircle2, XCircle } from 'lucide-react';
import {
  ApiError, getAccountStatus, getEcontConfig, getSpeedyConfig, saveEcontCredentials, saveSpeedyCredentials,
  type EcontConfig, type SpeedyConfig,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const inp = 'h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[14px] outline-none focus:border-ff-green-500';
const lbl = 'mb-1 block text-[12.5px] font-bold text-ff-muted';
const card = 'rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm';

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

export function SettingsClient() {
  const [econt, setEcont] = useState<EcontConfig | null>(null);
  const [speedy, setSpeedy] = useState<SpeedyConfig | null>(null);
  const [active, setActive] = useState<boolean | null>(null);

  const [econtForm, setEcontForm] = useState({ env: 'demo', username: '', password: '' });
  const [speedyForm, setSpeedyForm] = useState({ env: 'prod', userName: '', password: '', clientSystemId: '', defaultServiceId: '' });

  const [savingE, setSavingE] = useState(false);
  const [savingS, setSavingS] = useState(false);

  useEffect(() => {
    getAccountStatus()
      .then((s) => setActive(s.active))
      .catch(() => setActive(null));
    getEcontConfig()
      .then((c) => {
        setEcont(c);
        setEcontForm((f) => ({ ...f, env: c.env ?? 'demo', username: c.username ?? '' }));
      })
      .catch((e) => toast.error(`Econt: ${errMsg(e)}`));
    getSpeedyConfig()
      .then((c) => {
        setSpeedy(c);
        setSpeedyForm((f) => ({
          ...f,
          env: c.env ?? 'prod',
          userName: c.userName ?? '',
          clientSystemId: c.clientSystemId != null ? String(c.clientSystemId) : '',
          defaultServiceId: c.defaultServiceId != null ? String(c.defaultServiceId) : '',
        }));
      })
      .catch((e) => toast.error(`Speedy: ${errMsg(e)}`));
  }, []);

  async function saveEcont(e: React.FormEvent) {
    e.preventDefault();
    setSavingE(true);
    try {
      await saveEcontCredentials({
        env: econtForm.env as 'demo' | 'prod',
        username: econtForm.username.trim(),
        password: econtForm.password,
      });
      toast.success('Econt е свързан');
      setEcontForm((f) => ({ ...f, password: '' }));
      setEcont(await getEcontConfig());
    } catch (err) { toast.error(errMsg(err)); } finally { setSavingE(false); }
  }

  async function saveSpeedy(e: React.FormEvent) {
    e.preventDefault();
    setSavingS(true);
    try {
      await saveSpeedyCredentials({
        env: speedyForm.env as 'demo' | 'prod',
        userName: speedyForm.userName.trim(),
        password: speedyForm.password,
        ...(speedyForm.clientSystemId.trim() ? { clientSystemId: Number(speedyForm.clientSystemId) } : {}),
        ...(speedyForm.defaultServiceId.trim() ? { defaultServiceId: Number(speedyForm.defaultServiceId) } : {}),
      });
      toast.success('Speedy е свързан');
      setSpeedyForm((f) => ({ ...f, password: '' }));
      setSpeedy(await getSpeedyConfig());
    } catch (err) { toast.error(errMsg(err)); } finally { setSavingS(false); }
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
        Свържи куриерските си акаунти. Активирането на услугата се управлява от администратор.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
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

          <div className="mt-4 space-y-3">
            <div>
              <label className={lbl} htmlFor="econt-env">Среда</label>
              <select id="econt-env" className={inp} value={econtForm.env} onChange={(e) => setEcontForm({ ...econtForm, env: e.target.value })}>
                <option value="demo">Демо</option>
                <option value="prod">Реална</option>
              </select>
            </div>
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
        </form>

        {/* ---- Speedy ---- */}
        <form onSubmit={saveSpeedy} className={card}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="grid h-9 w-9 place-items-center rounded-[10px] bg-ff-green-50 text-ff-green-700">
                <Truck size={19} />
              </div>
              <h2 className="font-display text-[18px] font-extrabold">Speedy</h2>
            </div>
            <StatusBadge configured={!!speedy?.configured} />
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <label className={lbl} htmlFor="speedy-env">Среда</label>
              <select id="speedy-env" className={inp} value={speedyForm.env} onChange={(e) => setSpeedyForm({ ...speedyForm, env: e.target.value })}>
                <option value="prod">Реална</option>
                <option value="demo">Демо</option>
              </select>
            </div>
            <div>
              <label className={lbl} htmlFor="speedy-user">Потребител</label>
              <input id="speedy-user" className={inp} autoComplete="off" value={speedyForm.userName} onChange={(e) => setSpeedyForm({ ...speedyForm, userName: e.target.value })} />
            </div>
            <div>
              <label className={lbl} htmlFor="speedy-pass">Парола</label>
              <input id="speedy-pass" type="password" className={inp} autoComplete="new-password" placeholder={speedy?.configured ? 'Въведи нова, за да смениш' : ''} value={speedyForm.password} onChange={(e) => setSpeedyForm({ ...speedyForm, password: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl} htmlFor="speedy-csid">Client System ID</label>
                <input id="speedy-csid" type="number" inputMode="numeric" className={inp} placeholder="по избор" value={speedyForm.clientSystemId} onChange={(e) => setSpeedyForm({ ...speedyForm, clientSystemId: e.target.value })} />
              </div>
              <div>
                <label className={lbl} htmlFor="speedy-svc">Услуга по подр.</label>
                <input id="speedy-svc" type="number" inputMode="numeric" className={inp} placeholder="по избор" value={speedyForm.defaultServiceId} onChange={(e) => setSpeedyForm({ ...speedyForm, defaultServiceId: e.target.value })} />
              </div>
            </div>
          </div>

          <button type="submit" disabled={savingS || !speedyForm.userName.trim() || !speedyForm.password} className={btn + ' mt-4 w-full'}>
            <Plug size={16} /> {savingS ? 'Запазвам…' : 'Запази'}
          </button>
        </form>
      </div>
    </div>
  );
}
