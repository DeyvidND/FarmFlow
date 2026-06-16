/**
 * FarmFlow delivery — defaults, static mock nomenclature/shipments, helpers and
 * help-modal copy. Ported from the Claude Design prototype (data.js) into the real
 * client stack. The `DEFAULT_DELIVERY` blob hydrates a tenant that has never saved
 * delivery settings; the office/shipment data is mock until a live Econt API exists.
 */
import type {
  DeliveryConfig,
  DeliveryMethod,
  DeliveryMethodKey,
  EcontOffice,
  Shipment,
  ShipmentStatus,
} from './types';

/** Default per-tenant delivery config (no master `enabled` — that's deliveryEnabled). */
export const DEFAULT_DELIVERY: DeliveryConfig = {
  methods: {
    econtOffice: {
      // Default off — a new farm starts on self-delivery + pickup, never forced
      // into Econt's courier accounting. Flip on from the Econt section.
      // Fee MUST mirror the server `DELIVERY_DEFAULTS.econtFeeStotinki` (350) so a
      // first save (which persists this hydrated config) can't silently change the
      // fee a never-configured tenant was already being charged.
      enabled: false,
      label: 'До офис на Еконт',
      pricing: { type: 'flat', feeStotinki: 350 },
      etaText: '1–2 работни дни',
      payer: 'customer',
      minOrderStotinki: 0,
    },
    econtAddress: {
      // Fee mirrors the server `DELIVERY_DEFAULTS.econtAddressFeeStotinki` (590).
      enabled: false,
      label: 'До адрес (Еконт до врата)',
      pricing: { type: 'flat', feeStotinki: 590 },
      etaText: '1–2 работни дни',
      payer: 'customer',
    },
    ownSlots: { enabled: true, label: 'Лична доставка (Варна)', pricing: { type: 'free' } },
    pickup: {
      enabled: true,
      label: 'Вземане от място',
      address: 'гр. Варна, ул. Цар Симеон 12 (двора на фермата)',
      hours: 'Пн–Сб, 09:00–18:00',
    },
    order: ['ownSlots', 'pickup', 'econtOffice', 'econtAddress'],
  },
  schedule: {
    weekdays: [1, 2, 3, 4, 5, 6],
    cutoffTime: '14:00',
    leadDays: 1,
    sameDay: false,
    maxPerDay: 30,
    blackout: ['2026-06-01', '2026-09-06', '2026-09-22'],
  },
  pricing: {
    // Mirrors the server `DELIVERY_DEFAULTS.freeThresholdStotinki` (4000) — the
    // only global pricing value the server actually reads — so a first save is
    // idempotent.
    freeThresholdStotinki: 4000,
  },
  econt: {
    env: 'prod',
    mode: 'off',
    configured: false,
    username: '',
    sender: {
      name: 'Ферма Петрови ЕООД',
      phone: '+359 88 412 0001',
      cityId: 7, // Econt's live nomenclature id for Варна
      cityName: 'Варна',
      mode: 'office',
      officeCode: undefined,
      address: '',
    },
    defaultPackage: { weightKg: 1.5, dimensions: '30×20×15', contents: 'Хранителни продукти' },
    cod: { enabled: true, feePayer: 'customer' },
    label: { paper: 'A6', autoCreate: true },
    nomenclature: { lastSyncedAt: 'никога', cities: 0, offices: 0 },
  },
  cod: { enabled: true },
  card: { enabled: true },
};

/** Two retired price-types collapse to `flat`:
 *  - „Безплатна над сума" (`freeOver`) — replaced by a single shared free-over
 *    threshold (`pricing.freeThresholdStotinki`).
 *  - „Според теглото" (`byWeight`) — fully removed; it never had a configurable fee
 *    and silently fell back to the method's default flat fee. `byWeight` is gone
 *    from `PricingType`, so legacy saved configs are matched as a raw string.
 *  Both already resolve to flat on the server (`methodBaseFee`), so collapsing the
 *  type changes nothing the customer is charged — it just makes the fee editable
 *  in the admin again. */
function normalizeMethod(m: DeliveryMethod): DeliveryMethod {
  const t = m.pricing?.type as string | undefined;
  if (t === 'freeOver' || t === 'byWeight') {
    return { ...m, pricing: { ...m.pricing!, type: 'flat' } };
  }
  return m;
}

/** Deep-ish merge of a saved config over the defaults so missing/new keys are filled. */
export function hydrateDelivery(saved: DeliveryConfig | null | undefined): DeliveryConfig {
  if (!saved) return structuredClone(DEFAULT_DELIVERY);
  const d = DEFAULT_DELIVERY;
  return {
    methods: {
      econtOffice: normalizeMethod({ ...d.methods.econtOffice, ...saved.methods?.econtOffice }),
      econtAddress: normalizeMethod({ ...d.methods.econtAddress, ...saved.methods?.econtAddress }),
      ownSlots: normalizeMethod({ ...d.methods.ownSlots, ...saved.methods?.ownSlots }),
      pickup: { ...d.methods.pickup, ...saved.methods?.pickup },
      order: saved.methods?.order ?? d.methods.order,
    },
    schedule: { ...d.schedule, ...saved.schedule },
    pricing: { ...d.pricing, ...saved.pricing },
    econt: {
      ...d.econt,
      ...saved.econt,
      sender: { ...d.econt.sender, ...saved.econt?.sender },
      defaultPackage: { ...d.econt.defaultPackage, ...saved.econt?.defaultPackage },
      cod: { ...d.econt.cod, ...saved.econt?.cod },
      label: { ...d.econt.label, ...saved.econt?.label },
      nomenclature: { ...d.econt.nomenclature, ...saved.econt?.nomenclature },
    },
    cod: { enabled: saved?.cod?.enabled ?? d.cod?.enabled ?? true },
    card: { enabled: saved?.card?.enabled ?? d.card?.enabled ?? true },
  };
}

/** Bulgarian cities for the sender-city autocomplete (mock subset). */
export const BG_CITIES: { id: number; name: string }[] = [
  { id: 41, name: 'Варна' },
  { id: 1, name: 'София' },
  { id: 56, name: 'Пловдив' },
  { id: 22, name: 'Бургас' },
  { id: 70, name: 'Русе' },
  { id: 18, name: 'Стара Загора' },
  { id: 33, name: 'Плевен' },
  { id: 12, name: 'Добрич' },
  { id: 9, name: 'Шумен' },
];

/** Mock Econt office nomenclature (until live API). */
export const ECONT_OFFICES: EcontOffice[] = [
  { code: '1010', name: 'Офис Варна Център', address: 'бул. Владислав Варненчик 15', cityName: 'Варна', workingHours: 'Пн–Пт 08:30–19:00, Сб 09:00–14:00', dist: '0.6 км' },
  { code: '1024', name: 'Офис Варна Чайка', address: 'ж.к. Чайка, бл. 67', cityName: 'Варна', workingHours: 'Пн–Пт 09:00–18:30, Сб 09:00–13:00', dist: '2.4 км' },
  { code: '1038', name: 'Офис Варна Левски', address: 'ул. Подвис 5', cityName: 'Варна', workingHours: 'Пн–Пт 08:30–18:00', dist: '3.1 км' },
  { code: '1042', name: 'Офис Варна Аспарухово', address: 'ул. Народни будители 12', cityName: 'Варна', workingHours: 'Пн–Пт 09:00–18:00, Сб 09:00–13:00', dist: '4.7 км' },
  { code: '1055', name: 'Автомат Варна Гранд Мол', address: 'бул. Академик Курчатов 1', cityName: 'Варна', workingHours: 'Всеки ден 09:00–21:00', dist: '5.3 км' },
];

/** Mock shipments (orders with Econt waybills). */
export const MOCK_SHIPMENTS: Shipment[] = [
  { orderId: '1042', orderNumber: '1042', customerName: 'Иван Петров', method: 'econtAddress', status: 'created', trackingNumber: '1052 7788 4421', priceStotinki: 690, history: [{ at: '30 май, 09:12', label: 'Създадена товарителница', location: 'Варна' }] },
  { orderId: '1041', orderNumber: '1041', customerName: 'Мария Георгиева', method: 'econtOffice', status: 'shipped', trackingNumber: '1052 7788 4398', priceStotinki: 499, history: [{ at: '30 май, 08:40', label: 'Създадена товарителница', location: 'Варна' }, { at: '30 май, 13:05', label: 'Приета в офис', location: 'Офис Варна Център' }, { at: '30 май, 17:20', label: 'В транзит', location: 'Разпределителен център Варна' }] },
  { orderId: '1040', orderNumber: '1040', customerName: 'Димитър Иванов', method: 'econtOffice', status: 'delivered', trackingNumber: '1052 7701 9930', priceStotinki: 499, history: [{ at: '29 май, 10:00', label: 'Създадена товарителница', location: 'Варна' }, { at: '29 май, 15:30', label: 'В транзит', location: 'РЦ Варна' }, { at: '30 май, 11:18', label: 'Доставена', location: 'Офис Варна Чайка' }] },
  { orderId: '1039', orderNumber: '1039', customerName: 'Елена Стоянова', method: 'ownSlots', status: 'pending', priceStotinki: 0, history: [] },
  { orderId: '1037', orderNumber: '1037', customerName: 'Георги Тодоров', method: 'econtAddress', status: 'returned', trackingNumber: '1052 7700 1247', priceStotinki: 690, history: [{ at: '27 май, 09:30', label: 'Създадена товарителница', location: 'Варна' }, { at: '28 май, 14:00', label: 'Неуспешна доставка', location: 'Варна' }, { at: '29 май, 16:40', label: 'Върната към подател', location: 'РЦ Варна' }] },
];

export const SHIPMENT_META: Record<ShipmentStatus, { label: string; tone: 'gray' | 'amber' | 'green' | 'red' }> = {
  pending: { label: 'Чака', tone: 'gray' },
  created: { label: 'Създадена', tone: 'amber' },
  shipped: { label: 'Изпратена', tone: 'amber' },
  delivered: { label: 'Доставена', tone: 'green' },
  returned: { label: 'Върната', tone: 'red' },
};

export const METHOD_META: Record<
  DeliveryMethodKey,
  { name: string; econt: boolean; desc: string }
> = {
  econtOffice: { name: 'До офис на Еконт', econt: true, desc: 'Клиентът си взема поръчката от избран офис на Еконт.' },
  econtAddress: { name: 'До адрес (Еконт до врата)', econt: true, desc: 'Куриер на Еконт носи поръчката до вратата на клиента.' },
  ownSlots: { name: 'Лична доставка (слотове)', econt: false, desc: 'Ти доставяш сам в час, избран от клиента — не минава през Еконт.' },
  pickup: { name: 'Вземане от място', econt: false, desc: 'Клиентът идва да си вземе поръчката от твой адрес.' },
};

export const SHORT_METHOD: Record<DeliveryMethodKey, string> = {
  econtOffice: 'Еконт офис',
  econtAddress: 'Еконт адрес',
  ownSlots: 'Лична',
  pickup: 'Вземане',
};

export const WEEKDAYS = [
  { i: 1, l: 'Пн' },
  { i: 2, l: 'Вт' },
  { i: 3, l: 'Ср' },
  { i: 4, l: 'Чт' },
  { i: 5, l: 'Пт' },
  { i: 6, l: 'Сб' },
  { i: 0, l: 'Нд' },
];

/** cents → "12,34 €" */
export const lv = (stotinki: number) => (stotinki / 100).toFixed(2).replace('.', ',') + ' €';

// ---- Help-modal copy ----

export const ECONT_HELP = {
  eyebrow: 'Доставка с куриер',
  title: 'Как се използва Еконт доставката',
  intro:
    'Еконт е куриерската фирма, която носи поръчките до клиента вместо теб. Свързваш акаунта си веднъж и после създаваш товарителници (етикетите за пратките) направо оттук — клиентът получава поръчката до офис на Еконт или до вратата си. Това е по избор: ако доставяш само сам, не ти трябва.',
  steps: [
    { title: 'Извади си Еконт акаунт', body: 'Нужен ти е търговски (бизнес) договор с Еконт и достъп до Econt Delivery / API. Ако нямаш, обади се в Еконт — те ти дават API потребител и парола.' },
    { title: 'Свържи акаунта', body: 'Въведи API потребител и парола. Първо избери „Тест“ и натисни „Провери връзката“ — ако светне зелено, всичко е наред. Чак тогава мини на „Реален“ за истински пратки.' },
    { title: 'Попълни профил на подател', body: 'Име, телефон и град на фермата + дали изпращаш „От офис“ или „От адрес“. Тези данни влизат автоматично във всяка товарителница — попълваш ги веднъж.' },
    { title: 'Задай пакет по подразбиране', body: 'Обичайно тегло, размери и какво съдържа (напр. „хранителни продукти“). Спестява ти писане при всяка пратка.' },
    { title: 'Включи методите в магазина', body: 'В „Методи за доставка“ активирай „До офис на Еконт“ и/или „До адрес“. Едва тогава клиентът ги вижда при поръчка.' },
    { title: 'Създай товарителница', body: 'В таблицата „Пратки“ натисни иконата камионче до поръчката — Еконт връща номер за проследяване.' },
    { title: 'Принтирай и предай', body: 'Принтирай етикета (A4 или A6), залепи го на пакета и го предай на куриер или в офис. Статусът на пратката се обновява тук сам.' },
  ],
  tips: [
    'Наложен платеж (COD): клиентът плаща при получаване — ти избираш кой поема таксата за това.',
    'Авто-товарителница: при платена поръчка системата може да създаде етикета сама.',
    'Натисни „Обнови градове и офиси“, ако Еконт е добавил нови офиси и не ги виждаш.',
    'Цената на Еконт доставката се задава при самия метод („Фиксирана“). Безплатна над обща сума се задава веднъж за всички методи.',
  ],
};

export const SLOTS_HELP = {
  eyebrow: 'Доставка от теб',
  title: 'Как работи личната доставка',
  intro:
    'Лична доставка значи, че ти разнасяш сам — без куриер. Тук задаваш в кои часове доставяш; клиентът избира свободен час при поръчка, а ти ги обикаляш по маршрут. Това е напълно отделно от Еконт и не иска никакъв акаунт.',
  steps: [
    { title: 'Включи доставката', body: 'Превключвателят „Доставка“ горе трябва да е включен, за да се показват часовете в магазина (управлява се от страница „Доставка“).' },
    { title: 'Добави часове (слотове)', body: 'Натисни „+ Слот“ под някой ден и задай интервал (напр. 10:00–11:00). Всеки час поема една поръчка.' },
    { title: 'Клиентът си запазва час', body: 'При поръчка клиентът вижда само свободните ти часове и избира един. Запълнените изчезват сами — без двойни записвания.' },
    { title: 'Следи запълването', body: 'Цветът на лентата показва натовареността: зелено = свободно, амбър = почти пълно, сиво = пълно. Така не се претоварваш.' },
    { title: 'Доставяй по маршрут', body: 'В „Маршрут“ потвърдените поръчки за деня излизат подредени за разнасяне — с навигация и телефони.' },
  ],
  tips: [
    'Цената на личната доставка се задава в „Доставка → Методи → Лична доставка“ (може и безплатна).',
    'Всеки час поема една поръчка — щом се заеме, изчезва от магазина, за да не се претоварваш.',
    'Сгрешил час? Клик върху слота го маха; редактирай го с молива, ако само интервалът е грешен.',
    'Повтарящи се часове? Виж правилото за авто-запълване над седмицата — създава ги вместо теб.',
    'В правилото избираш само дните, в които доставяш. Изключи „Еднакви часове за всички дни“, за да дадеш на всеки ден собствени часове (напр. Пн 10–12, Ср 16–18, Сб — не).',
  ],
};
