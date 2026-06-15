'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, Trash2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LocationPicker } from '@/components/maps/location-picker';
import {
  getSiteContact,
  updateSiteContact,
  getTenant,
  updateTenant,
  uploadFavicon,
  deleteFavicon,
  type SocialLink,
  type CustomField,
} from '@/lib/api-client';

const FAVICON_ACCEPT = 'image/png,image/x-icon,.ico,.png';

// Social networks the dropdown offers; the key drives the storefront icon, the
// name is the label shown both in the picker and (for known nets) on the site.
const NETWORKS: { key: string; name: string }[] = [
  { key: 'fb', name: 'Facebook' },
  { key: 'ig', name: 'Instagram' },
  { key: 'yt', name: 'YouTube' },
  { key: 'tt', name: 'TikTok' },
  { key: 'viber', name: 'Viber' },
  { key: 'telegram', name: 'Telegram' },
  { key: 'whatsapp', name: 'WhatsApp' },
  { key: 'x', name: 'X (Twitter)' },
  { key: 'other', name: 'Друго (линк)' },
];

const NETWORK_KEYS = new Set(NETWORKS.map((n) => n.key));

// Sample url per network. Links must be https web profiles (the API rejects
// tel:/viber: schemes) — click-to-call lives in the phone + custom fields.
const SOCIAL_PLACEHOLDER: Record<string, string> = {
  fb: 'https://facebook.com/твоята-страница',
  ig: 'https://instagram.com/твоя-профил',
  yt: 'https://youtube.com/@твоя-канал',
  tt: 'https://tiktok.com/@твоя-профил',
  viber: 'https://viber.me/…',
  telegram: 'https://t.me/твоя-профил',
  whatsapp: 'https://wa.me/3598…',
  x: 'https://x.com/твоя-профил',
  other: 'https://…',
};

/** Pick a network key for an older row that has only a url, so the dropdown
 *  pre-selects sensibly. Falls back to 'other'. */
function guessNetwork(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('facebook') || u.includes('fb.com') || u.includes('fb.me')) return 'fb';
  if (u.includes('instagram') || u.includes('instagr.am')) return 'ig';
  if (u.includes('youtube') || u.includes('youtu.be')) return 'yt';
  if (u.includes('tiktok')) return 'tt';
  if (u.includes('viber')) return 'viber';
  if (u.includes('t.me') || u.includes('telegram')) return 'telegram';
  if (u.includes('wa.me') || u.includes('whatsapp')) return 'whatsapp';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'x';
  return 'other';
}

type Form = {
  name: string;
  address: string;
  hours: string;
  tagline: string;
  phone: string;
  email: string;
  social: SocialLink[];
  custom: CustomField[];
  mapLat: string;
  mapLng: string;
  themeColor: string;
};

const EMPTY: Form = {
  name: '', address: '', hours: '', tagline: '', phone: '', email: '', social: [], custom: [], mapLat: '', mapLng: '', themeColor: '',
};

export default function ContactsPage() {
  const router = useRouter();
  const [form, setForm] = useState<Form>(EMPTY);
  const [favicon, setFavicon] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const iconRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The site name lives on the tenant row, contact/brand in settings — load both.
    Promise.all([getSiteContact(), getTenant()])
      .then(([res, tenant]) => {
        setForm({
          name: tenant.name ?? '',
          address: res.contact.address ?? '',
          hours: res.contact.hours ?? '',
          tagline: res.contact.tagline ?? '',
          phone: res.contact.phone ?? '',
          email: res.contact.email ?? '',
          social: (res.contact.social ?? []).map((s) => ({
            network: s.network && NETWORK_KEYS.has(s.network) ? s.network : guessNetwork(s.url),
            label: s.label ?? '',
            url: s.url ?? '',
          })),
          custom: res.contact.custom ?? [],
          mapLat: res.contact.mapLat ?? '',
          mapLng: res.contact.mapLng ?? '',
          themeColor: res.themeColor ?? '',
        });
        setFavicon(res.favicon?.url ?? null);
      })
      .catch(() => toast.error('Неуспешно зареждане'))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setSocial(i: number, patch: Partial<SocialLink>) {
    setForm((f) => ({
      ...f,
      social: f.social.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    }));
  }

  function addSocial() {
    setForm((f) =>
      f.social.length >= 8 ? f : { ...f, social: [...f.social, { network: 'fb', label: '', url: '' }] },
    );
  }

  function removeSocial(i: number) {
    setForm((f) => ({ ...f, social: f.social.filter((_, idx) => idx !== i) }));
  }

  function setCustom(i: number, patch: Partial<CustomField>) {
    setForm((f) => ({
      ...f,
      custom: f.custom.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    }));
  }

  function addCustom() {
    setForm((f) => (f.custom.length >= 12 ? f : { ...f, custom: [...f.custom, { label: '', value: '' }] }));
  }

  function removeCustom(i: number) {
    setForm((f) => ({ ...f, custom: f.custom.filter((_, idx) => idx !== i) }));
  }

  async function save() {
    // The site name is required (mirrors the server @MinLength(2)). Guard before
    // any write so a blank name can't 400 the name save while the contact save lands.
    const name = form.name.trim();
    if (name.length < 2) {
      toast.error('Името на сайта трябва да е поне 2 символа');
      return;
    }
    setSaving(true);
    try {
      await Promise.all([
        updateSiteContact({
          address: form.address,
          hours: form.hours,
          tagline: form.tagline,
          phone: form.phone,
          email: form.email,
          // Drop rows without a url — the API rejects non-url social links.
          social: form.social.filter((s) => s.url.trim()),
          // Drop rows without a value.
          custom: form.custom.filter((c) => c.value.trim()),
          mapLat: form.mapLat,
          mapLng: form.mapLng,
          themeColor: form.themeColor,
        }),
        updateTenant({ name }),
      ]);
      toast.success('Запазено');
      // The topbar name comes from the server-rendered admin layout — refresh so
      // the new site name shows without a manual reload.
      router.refresh();
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  async function pickIcon(file: File) {
    setIconBusy(true);
    try {
      const { url } = await uploadFavicon(file);
      setFavicon(url);
      toast.success('Иконата е качена');
    } catch {
      toast.error('Неуспешно качване');
    } finally {
      setIconBusy(false);
    }
  }

  async function removeIcon() {
    setIconBusy(true);
    try {
      await deleteFavicon();
      setFavicon(null);
      toast.success('Иконата е премахната');
    } catch {
      toast.error('Неуспешно изтриване');
    } finally {
      setIconBusy(false);
    }
  }

  if (loading) {
    return <p className="max-w-[900px] text-[14px] text-ff-muted">Зареждане…</p>;
  }

  const latNum = Number(form.mapLat);
  const lngNum = Number(form.mapLng);
  const lat = form.mapLat && Number.isFinite(latNum) ? latNum : null;
  const lng = form.mapLng && Number.isFinite(lngNum) ? lngNum : null;

  const card = 'rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm';
  const label = 'mb-1 block text-[13px] font-bold text-ff-ink';
  const input =
    'w-full rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] text-ff-ink outline-none focus:border-ff-green-600';

  return (
    <div className="max-w-[900px]">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Контакти</h1>
        <p className="text-[13.5px] text-ff-muted">
          Контактна информация, социални мрежи и локация — показват се в долната част и на
          страница „Контакти“ в магазина.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        {/* Контакти */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Информация за контакт</h2>
          <div className="flex flex-col gap-3">
            <div>
              <label className={label}>Име на сайта</label>
              <input className={input} value={form.name} onChange={(e) => set('name', e.target.value)}
                placeholder="Фермерски пазар „Чайка“" />
              <p className="mt-1 text-[12px] text-ff-muted">
                Показва се в заглавието на сайта, в раздела на браузъра и в администрацията.
              </p>
            </div>
            <div>
              <label className={label}>Адрес / място на пазара</label>
              <input className={input} value={form.address} onChange={(e) => set('address', e.target.value)}
                placeholder="кв. Чайка, бул. „Ал. Стамболийски“, Варна" />
            </div>
            <div>
              <label className={label}>Работно време</label>
              <input className={input} value={form.hours} onChange={(e) => set('hours', e.target.value)}
                placeholder="Всеки петък · 11:00–18:00" />
            </div>
            <div>
              <label className={label}>Телефон / Viber</label>
              <input
                type="tel"
                className={input}
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="+359 88 123 4567"
              />
              <p className="mt-1 text-[12px] text-ff-muted">
                Показва се във футъра и на страница „Контакти“ — клиентите могат да се обадят с
                едно докосване.
              </p>
            </div>
            <div>
              <label className={label}>Кратко описание (във футъра)</label>
              <textarea className={`${input} min-h-[80px]`} value={form.tagline}
                onChange={(e) => set('tagline', e.target.value)}
                placeholder="Местни стопани на едно място — пазарувай на живо или поръчай онлайн." />
            </div>
            <div>
              <label className={label}>Имейл за контакт</label>
              <input
                type="email"
                className={input}
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                placeholder="hello@example.com"
              />
            </div>
          </div>
        </section>

        {/* Социални мрежи */}
        <section className={card}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-extrabold">Социални мрежи</h2>
            <Button variant="soft" type="button" onClick={addSocial} disabled={form.social.length >= 8}
              className="gap-1.5 rounded-sm px-3 py-1.5 text-[13px]">
              <Plus size={15} /> Добави
            </Button>
          </div>
          {form.social.length === 0 ? (
            <p className="text-[13px] text-ff-muted">Няма добавени връзки.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {form.social.map((s, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select
                    className={`${input} max-w-[170px] cursor-pointer`}
                    value={NETWORK_KEYS.has(s.network) ? s.network : 'other'}
                    onChange={(e) => setSocial(i, { network: e.target.value })}
                  >
                    {NETWORKS.map((n) => (
                      <option key={n.key} value={n.key}>{n.name}</option>
                    ))}
                  </select>
                  {s.network === 'other' && (
                    <input className={`${input} max-w-[150px]`} value={s.label}
                      onChange={(e) => setSocial(i, { label: e.target.value })} placeholder="Име на връзката" />
                  )}
                  <input className={`${input} min-w-[200px] flex-1`} value={s.url}
                    onChange={(e) => setSocial(i, { url: e.target.value })}
                    placeholder={SOCIAL_PLACEHOLDER[s.network] ?? SOCIAL_PLACEHOLDER.other} />
                  <Button variant="ghost" type="button" onClick={() => removeSocial(i)}
                    title="Премахни" className="rounded-sm px-2.5 text-ff-red hover:bg-ff-red/10">
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[12px] text-ff-muted">
            Избери мрежата от падащото меню — иконата се поставя автоматично. Връзката трябва да
            е https:// уеб адрес (за Viber/WhatsApp ползвай viber.me / wa.me). „Друго“ показва
            обща икона.
          </p>
        </section>

        {/* Допълнителни контактни полета */}
        <section className={card}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-extrabold">Допълнителни полета</h2>
            <Button variant="soft" type="button" onClick={addCustom} disabled={form.custom.length >= 12}
              className="gap-1.5 rounded-sm px-3 py-1.5 text-[13px]">
              <Plus size={15} /> Добави
            </Button>
          </div>
          {form.custom.length === 0 ? (
            <p className="text-[13px] text-ff-muted">Няма допълнителни полета.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {form.custom.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input className={`${input} max-w-[200px]`} value={c.label}
                    onChange={(e) => setCustom(i, { label: e.target.value })}
                    placeholder="Етикет (напр. WhatsApp)" />
                  <input className={`${input} min-w-[200px] flex-1`} value={c.value}
                    onChange={(e) => setCustom(i, { value: e.target.value })}
                    placeholder="Стойност (напр. +359 88 …)" />
                  <Button variant="ghost" type="button" onClick={() => removeCustom(i)}
                    title="Премахни" className="rounded-sm px-2.5 text-ff-red hover:bg-ff-red/10">
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[12px] text-ff-muted">
            Каквото поиска фермата — втори телефон, WhatsApp, допълнителни часове… Показва се
            автоматично във футъра и на страница „Контакти“. Празните не се показват; телефон,
            имейл и линк стават кликаеми автоматично.
          </p>
        </section>

        {/* Локация */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Локация на картата</h2>
          <p className="mb-3 text-[13px] text-ff-muted">
            Кликни на картата, за да поставиш точката, или въведи координати ръчно.
          </p>
          <div className="mb-3">
            <LocationPicker lat={lat} lng={lng}
              onPick={(la, ln) => setForm((f) => ({ ...f, mapLat: la.toFixed(6), mapLng: ln.toFixed(6) }))} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className={label}>Ширина (lat)</label>
              <input className={input} value={form.mapLat} onChange={(e) => set('mapLat', e.target.value)}
                placeholder="43.21" />
            </div>
            <div className="flex-1">
              <label className={label}>Дължина (lng)</label>
              <input className={input} value={form.mapLng} onChange={(e) => set('mapLng', e.target.value)}
                placeholder="27.91" />
            </div>
          </div>
        </section>

        {/* Иконка на сайта */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Иконка на сайта</h2>
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-ff-border bg-ff-surface-2">
              {favicon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={favicon} alt="Иконка" className="h-12 w-12 object-contain" />
              ) : (
                <span className="text-[11px] text-ff-muted">няма</span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input ref={iconRef} type="file" accept={FAVICON_ACCEPT} className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) pickIcon(file);
                  e.target.value = '';
                }} />
              <div className="flex gap-2">
                <Button variant="soft" type="button" disabled={iconBusy}
                  onClick={() => iconRef.current?.click()} className="gap-1.5 rounded-sm px-3 py-2 text-[13.5px]">
                  <Upload size={15} /> {favicon ? 'Смени' : 'Качи икона'}
                </Button>
                {favicon && (
                  <Button variant="ghost" type="button" disabled={iconBusy} onClick={removeIcon}
                    className="gap-1.5 rounded-sm px-3 py-2 text-[13.5px] text-ff-red hover:bg-ff-red/10">
                    <Trash2 size={15} /> Премахни
                  </Button>
                )}
              </div>
              <p className="text-[12px] text-ff-muted">PNG или ICO, до 512 KB.</p>
            </div>
          </div>

        </section>

        <div className="mt-1 flex justify-end border-t border-ff-border pt-4">
          <Button type="button" onClick={save} disabled={saving}
            className="rounded-sm px-6 py-2.5 text-[14px] font-bold">
            {saving ? 'Запазване…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
