// server/src/modules/tenants/copy-slots.catalog.ts
/**
 * Catalog of editable storefront *text* slots — the body-copy analog of
 * media-slots.catalog.ts. The map is generic (`settings.copy[key] = string`);
 * this catalog is the contract: which keys exist for a site theme, their admin
 * label, page grouping, the original (default) text, and whether the field is
 * multiline. The admin „Промени сайта → Текстове" tab renders its editor from
 * this catalog; the storefront keeps the same default inline as <CopySlot
 * fallback> so each side is safe alone.
 */
export interface CopySlotDef {
  /** Stable slot id, e.g. "home.hero.title". Storefront lookup key + admin field id. */
  key: string;
  /** Bulgarian label shown in the admin editor. */
  label: string;
  /** Group heading in the editor (the storefront page). */
  page: string;
  /** Current storefront text — admin placeholder + reference; storefront's own fallback. */
  default: string;
  /** Multiline → textarea in admin + white-space:pre-line on the storefront. */
  multiline?: boolean;
}

/** Pages in display order for the editor. */
export const COPY_SLOT_PAGES = ['Начало', 'За нас', 'Поръчки', 'Контакти', 'FAQ'] as const;

/** Theme "pazar" (Фермерски пазар Чайка / ferma). */
const PAZAR_COPY: CopySlotDef[] = [
  // ---- Начало (index.astro) ----
  { key: 'home.hero.eyebrow', label: 'Hero · надпис отгоре', page: 'Начало', default: 'Фермерски пазар · кв. Чайка, Варна' },
  { key: 'home.hero.title', label: 'Hero · заглавие', page: 'Начало', default: 'Свежа храна директно от фермерите' },
  { key: 'home.hero.lead', label: 'Hero · текст', page: 'Начало', multiline: true, default: 'Ела на живо всеки петък на Чайка или поръчай онлайн — плодове, мляко, мед, месо и домашни сладка с доставка до дома.' },
  { key: 'home.twoways.eyebrow', label: 'Два начина · надпис', page: 'Начало', default: 'Два начина да пазаруваш' },
  { key: 'home.twoways.title', label: 'Два начина · заглавие', page: 'Начало', default: 'На пазара или онлайн — ти избираш' },
  { key: 'home.pillar_market.title', label: 'Стълб „Пазар" · заглавие', page: 'Начало', default: 'Пазар на място' },
  { key: 'home.pillar_market.text', label: 'Стълб „Пазар" · текст', page: 'Начало', multiline: true, default: 'Всеки петък фермерите се събират на Чайка. Опитай, разгледай и вземи директно от стопанина — без посредник.' },
  { key: 'home.pillar_delivery.title', label: 'Стълб „Доставка" · заглавие', page: 'Начало', default: 'Доставка до дома' },
  { key: 'home.pillar_delivery.text', label: 'Стълб „Доставка" · текст', page: 'Начало', multiline: true, default: 'Запази продукти от сайта и ги получи удобно вкъщи. Поръчай онлайн, а ние ги доставяме свежи в петък.' },
  { key: 'home.categories.eyebrow', label: 'Категории · надпис', page: 'Начало', default: 'Пазарувай по категория' },
  { key: 'home.categories.title', label: 'Категории · заглавие', page: 'Начало', default: 'Какво ще намериш' },
  { key: 'home.farmers.eyebrow', label: 'Фермери · надпис', page: 'Начало', default: 'Хора зад щандовете' },
  { key: 'home.farmers.title', label: 'Фермери · заглавие', page: 'Начало', default: 'Запознай се с фермерите' },
  { key: 'home.latest.eyebrow', label: 'Предложения · надпис', page: 'Начало', default: 'Свежо този петък' },
  { key: 'home.latest.title', label: 'Предложения · заглавие', page: 'Начало', default: 'Най-актуални предложения' },
  { key: 'home.reviews.eyebrow', label: 'Отзиви · надпис', page: 'Начало', default: 'Отзиви' },
  { key: 'home.reviews.title', label: 'Отзиви · заглавие', page: 'Начало', default: 'Какво казват клиентите' },
  { key: 'home.how.eyebrow', label: 'Как работи · надпис', page: 'Начало', default: 'Как е подреден магазинът' },
  { key: 'home.how.title', label: 'Как работи · заглавие', page: 'Начало', default: 'Фермер → категория → продукт' },
  { key: 'home.how.text', label: 'Как работи · текст', page: 'Начало', multiline: true, default: 'Всеки продукт идва от конкретен фермер и е подреден в категория. Така знаеш точно кой стопанин стои зад храната ти.' },
  { key: 'home.how.s1.title', label: 'Как работи · стъпка 1 заглавие', page: 'Начало', default: '1 · Избираш фермер' },
  { key: 'home.how.s1.text', label: 'Как работи · стъпка 1 текст', page: 'Начало', multiline: true, default: 'Всяко стопанство има профил със снимка, история и собствен асортимент.' },
  { key: 'home.how.s2.title', label: 'Как работи · стъпка 2 заглавие', page: 'Начало', default: '2 · Разглеждаш категориите' },
  { key: 'home.how.s2.text', label: 'Как работи · стъпка 2 текст', page: 'Начало', multiline: true, default: 'Продуктите на фермера са групирани по категории — плодове, мляко, мед, месо, сладка.' },
  { key: 'home.how.s3.title', label: 'Как работи · стъпка 3 заглавие', page: 'Начало', default: '3 · Поръчваш продукта' },
  { key: 'home.how.s3.text', label: 'Как работи · стъпка 3 текст', page: 'Начало', multiline: true, default: 'Добавяш в количката директно от категорията или запазваш за петъчния пазар.' },
  { key: 'home.location.eyebrow', label: 'Локация · надпис', page: 'Начало', default: 'Локация' },
  { key: 'home.location.title', label: 'Локация · заглавие', page: 'Начало', default: 'Фермерски пазар — Чайка' },
  { key: 'home.location.lead', label: 'Локация · текст', page: 'Начало', multiline: true, default: 'Намираш ни в кв. Чайка, Варна — на бул. „Ал. Стамболийски", точно пред „Фратели".' },
  { key: 'home.trust.1.title', label: 'Доверие · карта 1 заглавие', page: 'Начало', default: 'Местно и сезонно' },
  { key: 'home.trust.1.text', label: 'Доверие · карта 1 текст', page: 'Начало', multiline: true, default: 'Всичко идва от ферми в региона на Варна — толкова свежо, колкото изобщо е възможно.' },
  { key: 'home.trust.2.title', label: 'Доверие · карта 2 заглавие', page: 'Начало', default: 'Директно от фермера' },
  { key: 'home.trust.2.text', label: 'Доверие · карта 2 текст', page: 'Начало', multiline: true, default: 'Без вериги и без посредник. Парите отиват при стопанина, който е отгледал продукта.' },
  { key: 'home.trust.3.title', label: 'Доверие · карта 3 заглавие', page: 'Начало', default: 'Познаваме си хората' },
  { key: 'home.trust.3.text', label: 'Доверие · карта 3 текст', page: 'Начало', multiline: true, default: 'Малка общност от стопани и клиенти, които се срещат всеки петък на Чайка.' },
  { key: 'home.newsletter.title', label: 'Бюлетин · заглавие', page: 'Начало', default: 'Какво има на пазара тази седмица?' },
  { key: 'home.newsletter.text', label: 'Бюлетин · текст', page: 'Начало', multiline: true, default: 'Абонирай се и получавай в четвъртък какво носят фермерите в петък. Без спам.' },

  // ---- За нас (about.astro) ----
  { key: 'about.hero.eyebrow', label: 'Hero · надпис', page: 'За нас', default: 'За нас' },
  { key: 'about.hero.title', label: 'Hero · заглавие', page: 'За нас', multiline: true, default: 'Един пазар,\nмного местни\nстопани' },
  { key: 'about.hero.lead', label: 'Hero · текст', page: 'За нас', multiline: true, default: 'събира фермерите от региона на Варна на едно място — всеки петък на Чайка. Тук храната не минава през вериги и складове. Купуваш я директно от човека, който я е отгледал.' },
  { key: 'about.story.p1', label: 'История · параграф 1', page: 'За нас', multiline: true, default: 'Започнахме като малка сбирка от няколко съседни стопанства, които искаха да продават директно на хората — без посредник, без етикети, които никой не разбира. Първите петъци на Чайка бяхме шепа маси и кошници. Хората се връщаха. После водеха приятели.' },
  { key: 'about.story.p2', label: 'История · параграф 2', page: 'За нас', multiline: true, default: 'Днес на пазара се събират фермери с плодове и зеленчуци, мляко и сирене, мед, месо и домашни сладка. Различни стопанства, но един и същ принцип — местно, сезонно и честно. Каквото е узряло тази седмица, това носим.' },
  { key: 'about.story.p3', label: 'История · параграф 3', page: 'За нас', multiline: true, default: 'Сайтът добавихме, за да е по-лесно: разглеждаш фермерите и продуктите им предварително, запазваш онлайн и идваш да вземеш — или избираш доставка до дома. Така пазарът работи и през останалите дни от седмицата.' },
  { key: 'about.values.eyebrow', label: 'Ценности · надпис', page: 'За нас', default: 'Нашите ценности' },
  { key: 'about.values.title', label: 'Ценности · заглавие', page: 'За нас', default: 'В какво вярваме' },
  { key: 'about.values.1.title', label: 'Ценности · карта 1 заглавие', page: 'За нас', default: 'Местно и сезонно' },
  { key: 'about.values.1.text', label: 'Ценности · карта 1 текст', page: 'За нас', multiline: true, default: 'Продукти от региона на Варна — толкова свежи, колкото е възможно.' },
  { key: 'about.values.2.title', label: 'Ценности · карта 2 заглавие', page: 'За нас', default: 'Директно от фермера' },
  { key: 'about.values.2.text', label: 'Ценности · карта 2 текст', page: 'За нас', multiline: true, default: 'Без вериги и посредници — парите отиват при стопанина.' },
  { key: 'about.values.3.title', label: 'Ценности · карта 3 заглавие', page: 'За нас', default: 'Общност' },
  { key: 'about.values.3.text', label: 'Ценности · карта 3 текст', page: 'За нас', multiline: true, default: 'Познаваме си хората — стопани и клиенти, които се срещат всеки петък.' },
  { key: 'about.values.4.title', label: 'Ценности · карта 4 заглавие', page: 'За нас', default: 'Честно и ясно' },
  { key: 'about.values.4.text', label: 'Ценности · карта 4 текст', page: 'За нас', multiline: true, default: 'Знаеш кой, къде и как е произвел това, което купуваш.' },
  { key: 'about.gallery.eyebrow', label: 'Галерия · надпис', page: 'За нас', default: 'От пазара' },
  { key: 'about.gallery.title', label: 'Галерия · заглавие', page: 'За нас', default: 'Един петък на Чайка' },
  { key: 'about.quote', label: 'Цитат', page: 'За нас', multiline: true, default: 'Не продаваме просто храна. Свързваме хората, които я отглеждат, с хората, които я ядат — лице в лице, всеки петък."' },

  // ---- Поръчки (orders.astro) ----
  { key: 'orders.head.eyebrow', label: 'Заглавна · надпис', page: 'Поръчки', default: 'Поръчки' },
  { key: 'orders.head.title', label: 'Заглавна · заглавие', page: 'Поръчки', default: 'Как стига храната до теб' },
  { key: 'orders.head.text', label: 'Заглавна · текст', page: 'Поръчки', multiline: true, default: 'Два начина да вземеш продуктите от фермерите — ела на пазара на Чайка всеки петък, или запази онлайн и получи доставка до дома. Ти избираш.' },
  { key: 'orders.pickup.title', label: 'Вземане · заглавие', page: 'Поръчки', default: 'Вземане от пазара' },
  { key: 'orders.pickup.text', label: 'Вземане · текст', page: 'Поръчки', multiline: true, default: 'Запази продуктите си онлайн и ги вземи лично в петък от щандовете на Чайка — без такса за доставка.' },
  { key: 'orders.delivery.title', label: 'Доставка · заглавие', page: 'Поръчки', default: 'Доставка до адрес' },
  { key: 'orders.delivery.text', label: 'Доставка · текст', page: 'Поръчки', multiline: true, default: 'Поръчай онлайн и получи свежите продукти удобно вкъщи в петък между 11:00 и 20:00 ч.' },
  { key: 'orders.steps.eyebrow', label: 'Стъпки · надпис', page: 'Поръчки', default: 'Стъпка по стъпка' },
  { key: 'orders.steps.title', label: 'Стъпки · заглавие', page: 'Поръчки', default: 'Поръчката за 4 стъпки' },
  { key: 'orders.steps.1.title', label: 'Стъпка 1 · заглавие', page: 'Поръчки', default: '1 · Разгледай' },
  { key: 'orders.steps.1.text', label: 'Стъпка 1 · текст', page: 'Поръчки', multiline: true, default: 'Избери фермер или категория и виж какво е свежо тази седмица.' },
  { key: 'orders.steps.2.title', label: 'Стъпка 2 · заглавие', page: 'Поръчки', default: '2 · Добави' },
  { key: 'orders.steps.2.text', label: 'Стъпка 2 · текст', page: 'Поръчки', multiline: true, default: 'Сложи продуктите в количката и избери количество.' },
  { key: 'orders.steps.3.title', label: 'Стъпка 3 · заглавие', page: 'Поръчки', default: '3 · Избери начин' },
  { key: 'orders.steps.3.text', label: 'Стъпка 3 · текст', page: 'Поръчки', multiline: true, default: 'Вземане от пазара на Чайка или доставка до адрес.' },
  { key: 'orders.steps.4.title', label: 'Стъпка 4 · заглавие', page: 'Поръчки', default: '4 · Готово' },
  { key: 'orders.steps.4.text', label: 'Стъпка 4 · текст', page: 'Поръчки', multiline: true, default: 'Потвърждаваме поръчката и я приготвяме за петък.' },
  { key: 'orders.know.eyebrow', label: 'Добре е да знаеш · надпис', page: 'Поръчки', default: 'Доставка и плащане' },
  { key: 'orders.know.title', label: 'Добре е да знаеш · заглавие', page: 'Поръчки', default: 'Добре е да знаеш' },

  // ---- Контакти (contact.astro) ----
  { key: 'contact.head.eyebrow', label: 'Заглавна · надпис', page: 'Контакти', default: 'Контакти' },
  { key: 'contact.head.title', label: 'Заглавна · заглавие', page: 'Контакти', default: 'Ще се радваме да чуем' },
  { key: 'contact.head.text', label: 'Заглавна · текст', page: 'Контакти', multiline: true, default: 'Въпрос за поръчка, продукт от пазара или просто здравей — пиши ни по който начин ти е удобен. Ще се радваме да те видим и на живо в петък на Чайка.' },
  { key: 'contact.form.title', label: 'Форма · заглавие', page: 'Контакти', default: 'Изпрати съобщение' },
  { key: 'contact.form.note', label: 'Форма · бележка', page: 'Контакти', default: 'Отговаряме в рамките на работния ден.' },

  // ---- FAQ (faq.astro) — heading only; the Q&A list is edited separately ----
  { key: 'faq.head.eyebrow', label: 'Надпис', page: 'FAQ', default: 'Често задавани въпроси' },
  { key: 'faq.head.title', label: 'Заглавие', page: 'FAQ', default: 'Каквото обикновено ни питат' },
];

const CATALOGS: Record<string, CopySlotDef[]> = { pazar: PAZAR_COPY };
export const DEFAULT_SITE_THEME = 'pazar';

/** Resolve a tenant's copy catalog by `settings.siteTheme` (default "pazar"). */
export function getCopyCatalog(theme?: string | null): CopySlotDef[] {
  return CATALOGS[theme ?? DEFAULT_SITE_THEME] ?? CATALOGS[DEFAULT_SITE_THEME];
}

/** Set of valid slot keys for a theme — used to drop unknown keys on write. */
export function copySlotKeys(theme?: string | null): Set<string> {
  return new Set(getCopyCatalog(theme).map((s) => s.key));
}
