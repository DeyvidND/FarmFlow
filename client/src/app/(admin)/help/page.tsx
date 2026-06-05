import { BookOpen, ChevronDown } from 'lucide-react';

/**
 * In-app documentation ("Документация"). Static help page.
 * Screenshots are served from Cloudflare R2 (folder docs/admin-guide/) so the
 * deployment build does not bundle/export them.
 */
const R2 = 'https://pub-fb8ad70ea98d409db9d1510a6b0a456d.r2.dev/docs/admin-guide';
const img = (n: string) => `${R2}/${n}.png`;

interface Shot {
  src: string;
  caption?: string;
}
interface Section {
  id: string;
  title: string;
  lead: string;
  bullets?: string[];
  shots: Shot[];
}

// NOTE: keep these sections in sync with docs/admin-panel-guide.md (Part B) —
// the two are maintained by hand until single-sourced.
const SECTIONS: Section[] = [
  {
    id: 'parola',
    title: 'Първо влизане и парола',
    lead: 'При първо влизане с временната парола панелът те праща в „Настройки“ да я смениш — останалите екрани се отключват чак тогава.',
    bullets: [
      '„Текуща парола“ = временната, която получи; „Нова парола“ ≥ 6 символа и различна.',
      'После можеш да сменяш паролата по всяко време от „Настройки“.',
      'Там е и „Локация и маршрут“: адресът на базата (началото на маршрута) и къде завършва той.',
    ],
    shots: [],
  },
  {
    id: 'tablo',
    title: 'Табло',
    lead: 'Началният екран за деня. Горе стоят четири карти на живо, отдолу — днешните поръчки и бързите действия.',
    bullets: [
      'Поръчки днес, Оборот днес, Чакащи потвърждение и Следващ слот.',
      'Бързи действия: „Потвърди всички чакащи“ и „Виж маршрута за днес“.',
      'Панел „Капацитет днес“ показва заетостта по часове.',
    ],
    shots: [{ src: img('dashboard') }],
  },
  {
    id: 'porachki',
    title: 'Поръчки',
    lead: 'Всички поръчки с търсене (клиент или № поръчка) и филтри по статус. Колоната „Доставка“ показва типа на доставката.',
    bullets: [
      'Адрес (зелено) = лична доставка до адрес; Еконт офис / Еконт адрес (кехлибар) = куриер.',
      'Клик на ред отваря панела с клиента, телефона, адреса или офиса и артикулите.',
      'Премести поръчката през статусите: чакаща → потвърдена → доставена (или откажи).',
    ],
    shots: [
      { src: img('orders'), caption: 'Списък с колона „Доставка“' },
      { src: img('order-panel'), caption: 'Панел с детайли и действия по статуса' },
    ],
  },
  {
    id: 'proizvodstvo',
    title: 'Производство',
    lead: 'Списък за приготвяне, съставен автоматично от продуктите в потвърдените поръчки за избрания ден.',
    bullets: [
      'Всеки ред: продукт, общо количество и брой поръчки, които го включват.',
      'Чекни редовете при бране — лента „Напредък“ следи готовото.',
    ],
    shots: [{ src: img('production') }],
  },
  {
    id: 'produkti',
    title: 'Продукти',
    lead: 'Каталогът — сърцето на ежедневната работа. Всяка карта има снимка, цена, наличност и превключвател активен/скрит в магазина.',
    bullets: [
      '„Редактирай“ = бърза инлайн смяна на цена и наличност.',
      '„Снимки“ = пълен редактор с галерия: добави няколко снимки, подреди ги с влачене, снимка №1 е корицата.',
      'Изтриването е меко — продуктът се скрива, името остава запазено.',
    ],
    shots: [
      { src: img('products'), caption: 'Списък с продукти' },
      { src: img('product-create'), caption: 'Нов продукт' },
      { src: img('product-media'), caption: 'Редактор със галерия снимки' },
    ],
  },
  {
    id: 'fermeri',
    title: 'Фермери',
    lead: 'Производителите, които се показват в магазина. Превключвателят „Няколко фермери в това стопанство“ включва режима.',
    bullets: [
      'Всяка карта: аватар, роля, телефон, био, година и брой свързани продукти.',
      'Панелът за редакция има същата галерия снимки като продуктите.',
    ],
    shots: [{ src: img('farmers') }],
  },
  {
    id: 'podkategorii',
    title: 'Подкатегории',
    lead: 'Визуални секции, които групират продуктите в магазина. Включват се с превключвателя „Подкатегории в магазина“.',
    bullets: ['Всяка секция: име, описание, цвят, снимка и брой свързани продукти.'],
    shots: [{ src: img('subcategories') }],
  },
  {
    id: 'slotove',
    title: 'Слотове',
    lead: 'Часове за лична доставка за седмицата; клиентът избира свободен слот на чек-аут.',
    bullets: [
      'Цветовете показват заетостта: свободно / почти пълно / пълно.',
      '„+ Слот“ добавя час (диапазон + макс. поръчки); клик на слот го премахва.',
      'Това са твоите собствени доставки — за куриер виж „Доставка → Еконт“.',
    ],
    shots: [{ src: img('slots') }],
  },
  {
    id: 'dostavka',
    title: 'Доставка',
    lead: 'Центърът за доставка. Главният превключвател „Доставка активна“ показва/скрива всички опции в магазина.',
    bullets: [
      'Методи: До офис на Еконт, До адрес (Еконт до врата), Лична доставка, Вземане на място.',
      'График (дни, отрязък, срокове), Ценообразуване (фиксирано / по тегло / по зона, безплатно над сума).',
      'Еконт интеграция: данни за достъп, подател, наложен платеж (COD), размер на товарителницата и синхронизация на градове/офиси.',
      'Таблицата „Пратки“ показва товарителниците с проследяване.',
    ],
    shots: [
      { src: img('delivery'), caption: 'Цялата конфигурация на доставката' },
      { src: img('delivery-econt'), caption: 'Блокът „Еконт интеграция“' },
    ],
  },
  {
    id: 'marshrut',
    title: 'Маршрут',
    lead: 'Оптимизиран маршрут за деня от потвърдените поръчки за доставка до адрес.',
    bullets: [
      'Подреждане „По часови слот“ или „Най-кратък път“.',
      'Край: към фирмата, едностранно или по избор (адрес от Настройки).',
      '„Google Maps“ отваря целия маршрут, „Старт“ пуска навигация; дългите маршрути се режат на отсечки.',
    ],
    shots: [{ src: img('route') }],
  },
  {
    id: 'statii',
    title: 'Статии',
    lead: 'Блог публикации за сайта. Всяка е Чернова (скрита) или Публикувана (видима).',
    bullets: [
      'Редакторът: заглавие, кратко описание, съдържание и корица.',
      'Медия блокове: снимки, видео и вграждане на YouTube / Instagram по адрес.',
      'Табът „Преглед“ показва как ще изглежда в сайта.',
    ],
    shots: [
      { src: img('articles'), caption: 'Списък със статии' },
      { src: img('article-editor'), caption: 'Редактор с медия блокове' },
    ],
  },
  {
    id: 'imeyl',
    title: 'Имейл клиенти',
    lead: 'Изпрати съобщение до абонатите на бюлетина на фермата.',
    bullets: [
      'Тема + текст на съобщението, после „Изпрати“.',
      'Стъпка за потвърждение показва броя получатели преди изпращане.',
    ],
    shots: [{ src: img('newsletters') }],
  },
  {
    id: 'nastroyki',
    title: 'Настройки',
    lead: 'Профил и логистика в две карти.',
    bullets: [
      'Смяна на парола (същият екран при първо влизане).',
      'Локация и маршрут: адрес на базата (началото на маршрута) и къде завършва маршрутът по подразбиране.',
    ],
    shots: [{ src: img('settings') }],
  },
];

function Figure({ src, caption }: Shot) {
  return (
    <figure className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface-2 shadow-ff-sm">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={caption ?? ''} loading="lazy" className="block w-full" />
      {caption && (
        <figcaption className="border-t border-ff-border px-3.5 py-2 text-[12.5px] font-semibold text-ff-muted">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

export default function HelpPage() {
  return (
    <div className="max-w-[860px] pb-4">
      <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Документация</h1>
      <p className="mb-6 text-[13.5px] text-ff-muted">
        Кратко ръководство за всеки екран на панела. Снимките са от живия панел.
      </p>

      {/* Intro + quick nav */}
      <div className="mb-7 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-ff-green-100 text-ff-green-800">
            <BookOpen size={20} />
          </span>
          <div>
            <h2 className="text-[16px] font-extrabold">Добре дошъл в управлението на фермата</h2>
            <p className="mt-1 text-[13.5px] leading-[1.55] text-ff-ink-2">
              Всичко, което създадеш тук — продукти, фермери, секции, статии — се показва автоматично
              в онлайн магазина на фермата. Използвай менюто вляво, за да преминаваш между екраните.
            </p>
          </div>
        </div>

        <nav className="mt-5 flex flex-wrap gap-2 border-t border-ff-border pt-4">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="rounded-full border border-ff-border bg-ff-surface-2 px-3 py-1.5 text-[12.5px] font-bold text-ff-ink-2 transition-colors hover:border-ff-green-500 hover:bg-ff-green-50 hover:text-ff-green-800"
            >
              {s.title}
            </a>
          ))}
        </nav>
      </div>

      {/* Sections — each is a click-to-open dropdown so the page stays short and scannable. */}
      <div className="flex flex-col gap-3">
        {SECTIONS.map((s, i) => (
          <details
            key={s.id}
            id={s.id}
            open={i === 0}
            className="group scroll-mt-4 overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-sm open:shadow-ff-md"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 p-5 [&::-webkit-details-marker]:hidden">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[13px] font-extrabold text-[#EAF1E4]">
                {i + 1}
              </span>
              <h2 className="flex-1 text-[18px] font-extrabold tracking-[-0.01em]">{s.title}</h2>
              <span className="shrink-0 text-ff-muted transition-transform duration-200 group-open:rotate-180">
                <ChevronDown size={20} />
              </span>
            </summary>

            <div className="border-t border-ff-border px-5 pb-5 pt-4">
              <p className="text-[14px] leading-[1.6] text-ff-ink-2">{s.lead}</p>

              {s.bullets && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {s.bullets.map((b, bi) => (
                    <li key={bi} className="flex gap-2.5 text-[13.5px] leading-[1.5] text-ff-ink-2">
                      <span className="mt-[7px] h-[6px] w-[6px] shrink-0 rounded-full bg-ff-green-500" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 grid gap-4">
                {s.shots.map((shot) => (
                  <Figure key={shot.src} {...shot} />
                ))}
              </div>
            </div>
          </details>
        ))}
      </div>

      <p className="mt-7 text-center text-[12.5px] text-ff-muted">FarmFlow · Документация</p>
    </div>
  );
}
