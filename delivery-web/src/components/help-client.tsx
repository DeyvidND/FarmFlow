'use client';

import { useEffect, useRef, useState } from 'react';
import {
  HelpCircle, Truck, Zap, FileSpreadsheet, ShieldAlert, Settings as SettingsIcon,
  ExternalLink, Image as ImageIcon, CheckCircle2, Info, Mail, Download, Scale, ListChecks, ChevronDown,
} from 'lucide-react';

/* -------------------------------------------------------------------------- */
/*  Small building blocks                                                     */
/* -------------------------------------------------------------------------- */

/** A real screenshot if one was dropped into /public/help, otherwise a labeled
 *  placeholder telling the operator/admin exactly which file to add. */
function HelpShot({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // A 404 during SSR fires the error event before hydration, so onError alone misses
  // it — re-check the broken state once on mount.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  return (
    <figure className="m-0">
      {failed ? (
        <div className="grid h-[180px] place-items-center rounded-lg border-2 border-dashed border-ff-border bg-ff-surface-2 px-4 text-center">
          <div>
            <ImageIcon size={26} className="mx-auto text-ff-muted-2" />
            <div className="mt-2 text-[12.5px] font-bold text-ff-ink-2">Място за снимка</div>
            <code className="mt-1 block text-[11px] text-ff-muted">{src}</code>
          </div>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={imgRef} src={src} alt={alt} onError={() => setFailed(true)} className="w-full rounded-lg border border-ff-border shadow-ff-sm" />
      )}
      {caption && <figcaption className="mt-1.5 text-[11.5px] text-ff-muted">{caption}</figcaption>}
    </figure>
  );
}

/** A clean illustrative "browser window" mockup (not a real screenshot) showing a URL
 *  and a sketch of the page, so each step still has a visual cue. */
function BrowserMock({ url, fields, highlight, button }: { url: string; fields: string[]; highlight?: number; button: string }) {
  const C = { surface: 'var(--ff-surface)', surface2: 'var(--ff-surface-2)', border: 'var(--ff-border)', green: 'var(--ff-green-700)', green5: 'var(--ff-green-500)', ink: 'var(--ff-ink-2)', muted: 'var(--ff-muted)' };
  const rowY = (i: number) => 70 + i * 30;
  return (
    <svg viewBox="0 0 320 200" className="w-full" role="img" aria-label={`Илюстрация: ${url}`}>
      <rect x="2" y="2" width="316" height="196" rx="12" fill={C.surface} stroke={C.border} strokeWidth="1.5" />
      {/* top bar */}
      <rect x="2" y="2" width="316" height="34" rx="12" fill={C.surface2} stroke={C.border} strokeWidth="1.5" />
      <rect x="2" y="24" width="316" height="12" fill={C.surface2} />
      <circle cx="18" cy="19" r="3.5" fill="#e08a7a" /><circle cx="30" cy="19" r="3.5" fill="#e8c07a" /><circle cx="42" cy="19" r="3.5" fill={C.green5} />
      <rect x="56" y="11" width="252" height="16" rx="8" fill={C.surface} stroke={C.border} />
      <text x="66" y="22.5" fontSize="9.5" fill={C.muted} style={{ fontFamily: 'var(--font-commissioner)' }}>{url}</text>
      {/* form sketch */}
      {fields.map((f, i) => (
        <g key={i}>
          <text x="20" y={rowY(i) - 6} fontSize="8.5" fill={C.muted} style={{ fontFamily: 'var(--font-commissioner)' }}>{f}</text>
          <rect x="20" y={rowY(i)} width="280" height="16" rx="6" fill={C.surface2} stroke={highlight === i ? C.green5 : C.border} strokeWidth={highlight === i ? 2 : 1} />
        </g>
      ))}
      <rect x="20" y={rowY(fields.length) + 4} width="120" height="20" rx="8" fill={C.green} />
      <text x="80" y={rowY(fields.length) + 17.5} fontSize="9.5" fill="#fff" textAnchor="middle" style={{ fontFamily: 'var(--font-commissioner)', fontWeight: 700 }}>{button}</text>
    </svg>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3.5">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[14px] font-extrabold text-white">{n}</div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-[14.5px] font-bold text-ff-ink">{title}</div>
        <div className="mt-1 text-[13.5px] leading-relaxed text-ff-ink-2">{children}</div>
      </div>
    </div>
  );
}

function Section({ id, icon: Icon, tone, title, intro, children }: { id: string; icon: React.ElementType; tone: string; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-[80px] rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-5 shadow-ff-sm sm:p-6">
      <div className="flex items-center gap-3">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-[11px] ${tone}`}><Icon size={21} /></div>
        <h2 className="font-display text-[19px] font-extrabold tracking-[-0.01em]">{title}</h2>
      </div>
      {intro && <p className="mt-2 text-[13.5px] leading-relaxed text-ff-ink-2">{intro}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'tip' | 'warn'; title: string; children: React.ReactNode }) {
  const map = {
    info: { box: 'border-ff-border bg-ff-surface-2', icon: 'text-ff-green-700', Icon: Info },
    tip: { box: 'border-ff-green-500 bg-ff-green-50', icon: 'text-ff-green-700', Icon: CheckCircle2 },
    warn: { box: 'border-[#e7c9a0] bg-ff-amber-softer', icon: 'text-ff-amber-600', Icon: Info },
  } as const;
  const m = map[tone];
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border p-3.5 ${m.box}`}>
      <m.Icon size={18} className={`mt-0.5 shrink-0 ${m.icon}`} />
      <div>
        <div className="text-[13px] font-bold text-ff-ink">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-ff-ink-2">{children}</div>
      </div>
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-ff-green-700 hover:underline">
      {children} <ExternalLink size={13} />
    </a>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group border-b border-ff-border-2 last:border-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 text-[14px] font-bold text-ff-ink [&::-webkit-details-marker]:hidden">
        {q}
        <ChevronDown size={17} className="shrink-0 text-ff-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="pb-3.5 text-[13.5px] leading-relaxed text-ff-ink-2">{children}</div>
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

const TOC = [
  { href: '#overview', label: 'Как работи' },
  { href: '#econt', label: 'Econt акаунт' },
  { href: '#speedy', label: 'Speedy акаунт' },
  { href: '#import', label: 'Внос на пратки' },
  { href: '#cod', label: 'Проверка на клиент' },
  { href: '#faq', label: 'Въпроси' },
];

export function HelpClient() {
  return (
    <div className="animate-ff-fade-up">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-[11px] bg-ff-green-50 text-ff-green-700"><HelpCircle size={22} /></div>
        <div>
          <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Помощ</h1>
          <p className="text-[13.5px] text-ff-muted">Как да свържеш куриерите и да пускаш пратки — стъпка по стъпка.</p>
        </div>
      </div>

      {/* quick nav */}
      <nav className="mt-5 flex flex-wrap gap-2">
        {TOC.map((t) => (
          <a key={t.href} href={t.href} className="rounded-full border border-ff-border bg-ff-surface px-3 py-1.5 text-[12.5px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2">{t.label}</a>
        ))}
      </nav>

      <div className="mt-5 flex flex-col gap-5">
        {/* ---------------------------------------------------------------- */}
        <Section id="overview" icon={Truck} tone="bg-ff-green-50 text-ff-green-700" title="Как работи доставката"
          intro="Панелът има четири екрана. Свързваш куриерски акаунт веднъж, после само качваш файл и пускаш пратки.">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { icon: SettingsIcon, t: 'Настройки', d: 'Свържи Econt и/или Speedy акаунт. Прави се веднъж.' },
              { icon: FileSpreadsheet, t: 'Внос', d: 'Качваш Excel/CSV, поправяш редовете, избираш най-евтиния куриер и създаваш пратките.' },
              { icon: Truck, t: 'Пратки', d: 'Всички създадени пратки, статуси и сваляне на етикети.' },
              { icon: ShieldAlert, t: 'Проверка на клиент', d: 'Проверка на телефон преди наложен платеж + докладване на проблемни клиенти.' },
            ].map((x) => (
              <div key={x.t} className="flex items-start gap-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <x.icon size={18} className="mt-0.5 shrink-0 text-ff-green-700" />
                <div><div className="text-[13.5px] font-bold text-ff-ink">{x.t}</div><div className="mt-0.5 text-[12.5px] text-ff-muted">{x.d}</div></div>
              </div>
            ))}
          </div>
          <div className="mt-4"><Callout tone="tip" title="Първа стъпка">Започни от „Настройки" → свържи поне един куриер. Без свързан куриер не може да създаваш пратки.</Callout></div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="econt" icon={Truck} tone="bg-ff-green-50 text-ff-green-700" title="Свържи Econt акаунт"
          intro="Econt използва същото потребителско име и парола като твоя e-Econt профил. Нужен е профил на бизнес клиент.">
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <div className="flex flex-col gap-4">
              <Step n={1} title="Направи си e-Econt профил">
                Регистрирай се: <ExtLink href="https://login.econt.com/register/">login.econt.com/register</ExtLink> за реална среда,
                или <ExtLink href="https://login-demo.econt.com/register/">login-demo.econt.com/register</ExtLink> за тест (Демо).
              </Step>
              <Step n={2} title="Поискай достъп до интеграция">
                Приеми Общите условия и поискай достъп до API/интеграция от Econt: пиши на{' '}
                <ExtLink href="mailto:support_integrations@econt.com">support_integrations@econt.com</ExtLink>. Бизнес информация:{' '}
                <ExtLink href="https://www.econt.com/en/business/b2b">econt.com бизнес</ExtLink>.
              </Step>
              <Step n={3} title="Въведи данните в „Настройки“">
                Отвори „Настройки" → карта <b>Econt</b>. Избери <b>Среда</b> (Демо или Реална), въведи <b>Потребител</b> (твоето e-Econt
                потребителско име) и <b>Парола</b>, после „Запази". Точното изписване има значение (главни/малки букви).
              </Step>
            </div>
            <div className="flex flex-col gap-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
              <BrowserMock url="login.econt.com/register" fields={['Имейл', 'Потребителско име', 'Парола']} highlight={1} button="Регистрация" />
              <HelpShot src="/help/econt-register.png" alt="Econt регистрация" caption="Снимка: страница за регистрация (добави при желание)" />
            </div>
          </div>
          <div className="mt-4"><Callout tone="info" title="Тест без свой акаунт">За Демо среда Econt дава тестови данни: потребител <code className="font-bold">iasp-dev</code>, парола <code className="font-bold">1Asp-dev</code>. Ползвай ги само за проба — не за реални пратки.</Callout></div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="speedy" icon={Zap} tone="bg-ff-amber-softer text-ff-amber-600" title="Свържи Speedy акаунт"
          intro="Speedy изисква договор като бизнес клиент и отделен API потребител (различен от обикновения логин в сайта).">
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <div className="flex flex-col gap-4">
              <Step n={1} title="Имай договор със Speedy">
                Стани бизнес клиент на Speedy. Инфо за интеграция:{' '}
                <ExtLink href="https://www.speedy.bg/en/system-integration">speedy.bg/system-integration</ExtLink>.
              </Step>
              <Step n={2} title="Поискай API достъп">
                Пиши на <ExtLink href="mailto:api.support@speedy.bg">api.support@speedy.bg</ExtLink> за <b>API потребител и парола</b> (за проба поискай тестов акаунт).
                Документация: <ExtLink href="https://api.speedy.bg/web-api.html">api.speedy.bg</ExtLink>.
              </Step>
              <Step n={3} title="Въведи данните в „Настройки“">
                „Настройки" → карта <b>Speedy</b>: <b>Среда</b>, <b>Потребител</b> (API user), <b>Парола</b>. По избор <b>Client System ID</b>
                (за договори с няколко обекта). Задай и <b>Услуга по подразбиране</b> (serviceId, напр. 505) — иначе Speedy пратки няма да се създават.
              </Step>
            </div>
            <div className="flex flex-col gap-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
              <BrowserMock url="api.speedy.bg" fields={['API потребител', 'Парола', 'Client System ID']} highlight={0} button="API достъп" />
              <HelpShot src="/help/speedy-api-user.png" alt="Speedy API потребител" caption="Снимка: API данни (добави при желание)" />
            </div>
          </div>
          <div className="mt-4"><Callout tone="warn" title="„Услуга по подразбиране“ е важна">Ако избереш Speedy за пратка, но не си задал serviceId, ще видиш грешка „Задай услуга по подразбиране за Speedy в Настройки". Попитай Speedy кой service code ползваш.</Callout></div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="import" icon={FileSpreadsheet} tone="bg-ff-green-50 text-ff-green-700" title="Внос на пратки"
          intro="Качваш само файл — куриерът се избира накрая, по най-добра цена.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: Download, t: '1 · Свали шаблон', d: 'Готов Excel с правилните колони. Бутон „Свали шаблон" на екран „Внос".' },
              { icon: FileSpreadsheet, t: '2 · Попълни и качи', d: 'Получател, телефон, град, режим (офис/адрес), наложен платеж. Качи файла.' },
              { icon: ListChecks, t: '3 · Поправи', d: 'Зелено = готово, жълто = внимание, червено = поправи. Редактираш на място.' },
              { icon: Scale, t: '4 · Сравни и създай', d: '„Сравни куриери" слага по-евтиния за всеки ред, после „Създай пратки".' },
            ].map((x) => (
              <div key={x.t} className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                <x.icon size={18} className="text-ff-green-700" />
                <div className="mt-2 text-[13px] font-bold text-ff-ink">{x.t}</div>
                <div className="mt-0.5 text-[12px] leading-snug text-ff-muted">{x.d}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
            <Callout tone="tip" title="Цените идват от куриерите">„Сравни куриери" пита Econt и Speedy за цена на всеки ред и показва двете. По-евтиният се избира автоматично — после може ръчно да смениш куриера в колоната.</Callout>
            <HelpShot src="/help/import-flow.png" alt="Внос екран" caption="Снимка: екран „Внос“ с таблицата (добави при желание)" />
          </div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="cod" icon={ShieldAlert} tone="bg-ff-amber-softer text-ff-amber-600" title="Проверка на клиент (наложен платеж)"
          intro="Преди да пуснеш пратка с наложен платеж, провери телефона на клиента.">
          <div className="grid gap-2.5 sm:grid-cols-3">
            {[
              { t: 'Чисто', d: 'Няма сигнали — безопасно.', cls: 'border-ff-green-500 bg-ff-green-50 text-ff-green-700' },
              { t: 'Внимание', d: 'Единичен сигнал — провери.', cls: 'border-ff-amber-600 bg-ff-amber-softer text-ff-amber-600' },
              { t: 'Висок риск', d: 'Много сигнали — искай предплащане.', cls: 'border-ff-red bg-[#FBE9E7] text-ff-red' },
            ].map((v) => (
              <div key={v.t} className={`rounded-xl border p-3 ${v.cls}`}>
                <div className="text-[13.5px] font-extrabold">{v.t}</div>
                <div className="mt-0.5 text-[12px] text-ff-ink-2">{v.d}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ff-ink-2">В „За докладване" виждаш върнати/отказани пратки с наложен платеж. Натисни „Докладвай", за да добавиш клиента в базата за риск — така помагаш и на другите търговци.</p>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="faq" icon={Info} tone="bg-ff-green-50 text-ff-green-700" title="Често задавани въпроси">
          <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-4">
            <Faq q="Защо колоната „Цена“ показва „—“?">Цената се появява чак след „Сравни куриери". Ако остане „—" за някой ред, куриерът не е върнал цена (липсва свързан акаунт, грешен град или режим) — тогава редът остава на Econt.</Faq>
            <Faq q="В каква валута са сумите?">Всичко е в евро (EUR). Наложеният платеж във файла се чете в евро.</Faq>
            <Faq q="Какво тегло да сложа?">Колоната „Тегло" е в килограми във файла. Празно тегло → ползва се 1 кг по подразбиране.</Faq>
            <Faq q="Каква е разликата между „Демо“ и „Реална“ среда?">Демо е за тестове — не създава истински товарителници. Реална създава реални пратки, които куриерът ще вземе.</Faq>
            <Faq q="Speedy дава грешка за serviceId. Какво да правя?">Отвори „Настройки" → Speedy и попълни „Услуга по подразбиране" (serviceId). Попитай Speedy кой код ползва договорът ти.</Faq>
            <Faq q="Услугата ми „не е активна“. Защо?">Активирането се прави от администратор. Свържи куриерските акаунти; щом услугата е активна, ще можеш да създаваш пратки.</Faq>
          </div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
          <div className="flex items-center gap-2.5"><Mail size={18} className="text-ff-green-700" /><h2 className="font-display text-[16px] font-extrabold">Нужда от още помощ?</h2></div>
          <div className="mt-2 grid gap-2 text-[13px] text-ff-ink-2 sm:grid-cols-2">
            <p>Econt интеграция: <ExtLink href="mailto:support_integrations@econt.com">support_integrations@econt.com</ExtLink></p>
            <p>Speedy API: <ExtLink href="mailto:api.support@speedy.bg">api.support@speedy.bg</ExtLink></p>
          </div>
        </section>
      </div>
    </div>
  );
}
