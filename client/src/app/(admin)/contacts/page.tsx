'use client';

import { useEffect, useRef, useState } from 'react';
import { Upload, Trash2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LocationPicker } from '@/components/maps/location-picker';
import {
  getSiteContact,
  updateSiteContact,
  uploadFavicon,
  deleteFavicon,
  type SocialLink,
} from '@/lib/api-client';

const FAVICON_ACCEPT = 'image/png,image/x-icon,.ico,.png';

type Form = {
  address: string;
  hours: string;
  tagline: string;
  social: SocialLink[];
  mapLat: string;
  mapLng: string;
  themeColor: string;
};

const EMPTY: Form = {
  address: '', hours: '', tagline: '', social: [], mapLat: '', mapLng: '', themeColor: '',
};

export default function ContactsPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [favicon, setFavicon] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const iconRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getSiteContact()
      .then((res) => {
        setForm({
          address: res.contact.address ?? '',
          hours: res.contact.hours ?? '',
          tagline: res.contact.tagline ?? '',
          social: res.contact.social ?? [],
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
    setForm((f) => (f.social.length >= 8 ? f : { ...f, social: [...f.social, { label: '', url: '' }] }));
  }

  function removeSocial(i: number) {
    setForm((f) => ({ ...f, social: f.social.filter((_, idx) => idx !== i) }));
  }

  async function save() {
    setSaving(true);
    try {
      await updateSiteContact({
        address: form.address,
        hours: form.hours,
        tagline: form.tagline,
        // Drop rows without a url — the API rejects non-url social links.
        social: form.social.filter((s) => s.url.trim()),
        mapLat: form.mapLat,
        mapLng: form.mapLng,
        themeColor: form.themeColor,
      });
      toast.success('Запазено');
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
              <label className={label}>Кратко описание (във футъра)</label>
              <textarea className={`${input} min-h-[80px]`} value={form.tagline}
                onChange={(e) => set('tagline', e.target.value)}
                placeholder="Местни стопани на едно място — пазарувай на живо или поръчай онлайн." />
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
                <div key={i} className="flex gap-2">
                  <input className={`${input} max-w-[160px]`} value={s.label}
                    onChange={(e) => setSocial(i, { label: e.target.value })} placeholder="Facebook" />
                  <input className={input} value={s.url}
                    onChange={(e) => setSocial(i, { url: e.target.value })}
                    placeholder="https://facebook.com/твоята-страница" />
                  <Button variant="ghost" type="button" onClick={() => removeSocial(i)}
                    title="Премахни" className="rounded-sm px-2.5 text-ff-red hover:bg-ff-red/10">
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[12px] text-ff-muted">
            Връзката трябва да започва с https:// — иконата се познава по адреса (Facebook,
            Instagram, TikTok, YouTube), останалите получават обща икона.
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

          <div className="mt-4">
            <label className={label}>Основен цвят (theme color)</label>
            <div className="flex items-center gap-2">
              <input type="color" value={form.themeColor || '#3F7D43'}
                onChange={(e) => set('themeColor', e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-ff-border bg-ff-surface" />
              <input className={`${input} max-w-[140px]`} value={form.themeColor}
                onChange={(e) => set('themeColor', e.target.value)} placeholder="#3F7D43" />
              {form.themeColor && (
                <Button variant="ghost" type="button" onClick={() => set('themeColor', '')}
                  className="rounded-sm px-2.5 text-[13px] text-ff-muted">
                  Изчисти
                </Button>
              )}
            </div>
          </div>
        </section>

        <div className="sticky bottom-0 -mx-1 flex justify-end bg-gradient-to-t from-ff-bg to-transparent py-3">
          <Button type="button" onClick={save} disabled={saving}
            className="rounded-sm px-6 py-2.5 text-[14px] font-bold">
            {saving ? 'Запазване…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
