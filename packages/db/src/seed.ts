import { config } from 'dotenv';
config({ path: '../../.env' });
config();
import * as argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { createDb, tenants, users, products, farmers, subcategories, deliverySlots, orders, orderItems, platformAdmins, articles, articleMedia, reviews } from './index';

// Demo owner credentials (matches the design's prefilled login).
const OWNER_EMAIL = 'ivan@ferma-petrovi.bg';
const OWNER_PASSWORD = 'ferma1234';

// Demo platform (ФермериБГ staff) admin credentials.
const PLATFORM_EMAIL = 'admin@fermeribg.bg';
const PLATFORM_PASSWORD = 'admin1234';

async function main() {
  // Hard stop: this script TRUNCATEs every table and inserts trivially-guessable
  // demo credentials. It must never run against a production database.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production (this wipes data + seeds weak demo logins)');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const db = createDb(connectionString);

  // Idempotent: wipe existing rows so re-running the seed is safe.
  await db.execute(
    sql`TRUNCATE article_media, articles, newsletter_subscribers, order_items, orders, delivery_slots, products, subcategories, farmers, users, tenants, platform_admins, audit_logs RESTART IDENTITY CASCADE`,
  );

  // Platform admin (manages all farms from the separate admin app).
  await db.insert(platformAdmins).values({
    email: PLATFORM_EMAIL,
    passwordHash: await argon2.hash(PLATFORM_PASSWORD),
    // Even in demos, force a rotation so a seeded login can't become a soft backdoor.
    mustChangePassword: true,
  });

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'Ферма Петрови',
      slug: 'ferma-petrovi',
      phone: '+359 88 123 4567',
      email: OWNER_EMAIL,
      subscriptionStatus: 'active',
      subscriptionSince: new Date(),
      deliveryEnabled: true,
      // Farm origin near Varna (route optimization start point).
      farmAddress: 'с. Звездица, общ. Варна',
      farmLat: '43.1729',
      farmLng: '27.8456',
    })
    .returning();

  await db.insert(users).values({
    tenantId: tenant.id,
    email: OWNER_EMAIL,
    passwordHash: await argon2.hash(OWNER_PASSWORD),
    role: 'admin',
  });

  // 3 demo farmers + 3 subcategories from docs/farmflow/project/data.js. Tenant
  // toggles stay off by default, so these stay dormant until the owner enables them.
  const farmerRows = await db.insert(farmers).values([
    { tenantId: tenant.id, name: 'Петър Петров', role: 'Ягодоплодни насаждения', since: '2014', phone: '+359 88 412 0001', tint: '#2C5530', position: 0,
      bio: 'Гледа ягоди, малини и череши на 4 декара край Варна. Бере рано сутрин и доставя в същия ден.' },
    { tenantId: tenant.id, name: 'Мария Петрова', role: 'Преработка — сладка и сиропи', since: '2016', phone: '+359 88 412 0002', tint: '#B23B5E', position: 1,
      bio: 'Прави домашни сладка, конфитюри и сиропи по семейни рецепти, без консерванти и оцветители.' },
    { tenantId: tenant.id, name: 'Стоян Петров', role: 'Пчелар — мед и пчелни продукти', since: '2018', phone: '+359 88 412 0003', tint: '#D08B26', position: 2,
      bio: 'Поддържа 40 кошера в Лонгоза. Липов, акациев и полифлорен мед, прополис и восък.' },
  ]).returning();

  const subcatRows = await db.insert(subcategories).values([
    { tenantId: tenant.id, name: 'Сезонни плодове', tint: '#4C8A54', position: 0, description: 'Прясно набрани плодове през текущия сезон.' },
    { tenantId: tenant.id, name: 'Зимнина и буркани', tint: '#B23B5E', position: 1, description: 'Домашни сладка, конфитюри и сиропи за зимата.' },
    { tenantId: tenant.id, name: 'Пчелни продукти', tint: '#D08B26', position: 2, description: 'Мед и продукти от собствен пчелин.' },
  ]).returning();

  // 9 demo products from docs/farmflow/project/data.js (prices in stotinki).
  // `slug` = storefront URL key (unique per tenant), transliterated from the name.
  // farmerId/subcategoryId follow data.js: fruits → Петър/Сезонни плодове,
  // processed → Мария/Зимнина, honey → Стоян/Пчелни продукти.
  const productSeed = [
    { tenantId: tenant.id, name: 'Ягоди', slug: 'yagodi', priceStotinki: 650, unit: 'бр', weight: '500 г', category: 'Плодове', tint: '#D94A4A', stockQuantity: 24, isActive: true, farmerId: farmerRows[0].id, subcategoryId: subcatRows[0].id },
    { tenantId: tenant.id, name: 'Боровинки', slug: 'borovinki', priceStotinki: 790, unit: 'бр', weight: '250 г', category: 'Плодове', tint: '#5B5BA8', stockQuantity: 12, isActive: true, farmerId: farmerRows[0].id, subcategoryId: subcatRows[0].id },
    { tenantId: tenant.id, name: 'Малини', slug: 'malini', priceStotinki: 820, unit: 'бр', weight: '500 г', category: 'Плодове', tint: '#C0426B', stockQuantity: 6, isActive: true, farmerId: farmerRows[0].id, subcategoryId: subcatRows[0].id },
    { tenantId: tenant.id, name: 'Къпини', slug: 'kapini', priceStotinki: 580, unit: 'бр', weight: '250 г', category: 'Плодове', tint: '#3B3B57', stockQuantity: 0, isActive: false, farmerId: farmerRows[0].id, subcategoryId: subcatRows[0].id },
    { tenantId: tenant.id, name: 'Череши', slug: 'chereshi', priceStotinki: 940, unit: 'кг', weight: '1 кг', category: 'Плодове', tint: '#A11E2E', stockQuantity: 18, isActive: true, farmerId: farmerRows[0].id, subcategoryId: subcatRows[0].id },
    { tenantId: tenant.id, name: 'Сироп от ягоди', slug: 'sirop-ot-yagodi', priceStotinki: 1100, unit: 'бр', weight: '330 мл', category: 'Преработени', tint: '#C13A52', stockQuantity: 9, isActive: true, farmerId: farmerRows[1].id, subcategoryId: subcatRows[1].id },
    { tenantId: tenant.id, name: 'Домашно сладко малина', slug: 'domashno-sladko-malina', priceStotinki: 990, unit: 'бр', weight: '320 г', category: 'Преработени', tint: '#B23B5E', stockQuantity: 14, isActive: true, farmerId: farmerRows[1].id, subcategoryId: subcatRows[1].id },
    { tenantId: tenant.id, name: 'Мед липов', slug: 'med-lipov', priceStotinki: 1350, unit: 'бр', weight: '450 г', category: 'Преработени', tint: '#D89A2B', stockQuantity: 7, isActive: true, farmerId: farmerRows[2].id, subcategoryId: subcatRows[2].id },
    { tenantId: tenant.id, name: 'Арония', slug: 'aroniya', priceStotinki: 620, unit: 'бр', weight: '250 г', category: 'Плодове', tint: '#4A2E55', stockQuantity: 4, isActive: true, farmerId: farmerRows[0].id, subcategoryId: subcatRows[0].id },
    // Bundles (category 'bundle') — curated contents + struck-through old price.
    { tenantId: tenant.id, name: 'Летен микс', slug: 'paket-leten', description: 'за 2–3 души', priceStotinki: 2490, compareAtPriceStotinki: 2940, unit: 'бр', weight: 'пакет', category: 'bundle', tint: '#C0426B', stockQuantity: null, isActive: true, bundleItems: ['Малини 250 г', 'Боровинки 250 г', 'Къпини 300 г', 'Ягоди 500 г'] },
    { tenantId: tenant.id, name: 'Семеен пакет', slug: 'paket-semeen', description: 'за цялото семейство', priceStotinki: 4200, compareAtPriceStotinki: 4980, unit: 'бр', weight: 'пакет', category: 'bundle', tint: '#A11E2E', stockQuantity: null, isActive: true, featured: true, bundleItems: ['Малини 500 г', 'Боровинки 500 г', 'Череши 500 г', 'Ягоди 500 г', 'Сироп от бъз', 'Горско сладко'] },
    { tenantId: tenant.id, name: 'Подаръчна кутия', slug: 'paket-podarak', description: 'в дървена кутийка', priceStotinki: 3450, compareAtPriceStotinki: 3800, unit: 'бр', weight: 'пакет', category: 'bundle', tint: '#D89A2B', stockQuantity: null, isActive: true, bundleItems: ['Микс горски плодове 750 г', 'Сироп от малина', 'Горско сладко', 'Картичка с поздрав'] },
  ];
  // Seed an explicit display order so the storefront catalog is deterministic
  // (without `position` every row defaults to 0 and ties break on random uuid).
  const productRows = await db
    .insert(products)
    .values(productSeed.map((p, i) => ({ ...p, position: i })))
    .returning();

  // Full week of slots (25–31 May 2026) from docs/farmflow/project/data.js.
  // Each slot holds one order; `booked` is computed live from orders.
  const SLOT_WEEK: Array<[string, Array<[string, string]>]> = [
    ['2026-05-25', [['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00'], ['17:00', '18:00']]],
    ['2026-05-26', [['09:00', '10:00'], ['10:00', '11:00'], ['17:00', '18:00']]],
    ['2026-05-27', [['10:00', '11:00'], ['11:00', '12:00'], ['12:00', '13:00']]],
    ['2026-05-28', [['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00'], ['17:00', '18:00']]],
    ['2026-05-29', [['09:00', '10:00'], ['10:00', '11:00'], ['12:00', '13:00']]],
    ['2026-05-30', [['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00'], ['12:00', '13:00'], ['13:00', '14:00']]],
    ['2026-05-31', [['10:00', '11:00'], ['11:00', '12:00']]],
  ];

  // Rolling storefront window: standard slots for the next 7 days (today..+6),
  // so the public slot picker always has live availability regardless of the
  // real date. The storefront date pills compute the same window from the
  // browser clock, so seed and UI always line up. Dates already covered by the
  // fixed demo week above are skipped to avoid duplicate slots.
  const DAY_TEMPLATE: Array<[string, string]> = [
    ['09:00', '10:00'],
    ['10:00', '11:00'],
    ['11:00', '12:00'],
    ['12:00', '13:00'],
    ['17:00', '18:00'],
  ];
  const seededDates = new Set(SLOT_WEEK.map(([date]) => date));
  const windowBase = new Date();
  windowBase.setUTCHours(0, 0, 0, 0);
  const ROLLING_SLOTS = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(windowBase);
    d.setUTCDate(windowBase.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  })
    .filter((date) => !seededDates.has(date))
    .flatMap((date) =>
      DAY_TEMPLATE.map(([timeFrom, timeTo]) => ({
        tenantId: tenant.id,
        date,
        timeFrom,
        timeTo,
      })),
    );

  const slotRows = await db
    .insert(deliverySlots)
    .values([
      ...SLOT_WEEK.flatMap(([date, daySlots]) =>
        daySlots.map(([timeFrom, timeTo]) => ({
          tenantId: tenant.id,
          date,
          timeFrom,
          timeTo,
        })),
      ),
      ...ROLLING_SLOTS,
    ])
    .returning();

  // 13 demo orders (all "today" = Събота 30.05.2026) from data.js, across statuses.
  const findProduct = (itemName: string) => productRows.find((p) => itemName.startsWith(p.name));
  const todaySlot = new Map(
    slotRows
      .filter((s) => s.date === '2026-05-30')
      // Seed data always sets timeFrom explicitly (see DAY_TEMPLATE/ROLLING_SLOTS above).
      .map((s) => [s.timeFrom!.slice(0, 5), s.id]),
  );

  type DemoOrder = {
    time: string;
    customer: string;
    phone: string;
    items: Array<[string, number]>;
    delivery: 'address' | 'econt';
    address: string;
    note: string;
    status: 'pending' | 'confirmed' | 'delivered' | 'cancelled';
    total: number; // stotinki
    slot: string | null; // slot start "HH:MM" or null
  };

  const DEMO_ORDERS: DemoOrder[] = [
    { time: '08:14', customer: 'Иван Петров', phone: '+359 88 412 7733', items: [['Ягоди 500 г', 2], ['Сироп от ягоди 330 мл', 1]], delivery: 'address', address: 'ул. Цар Симеон 12, Варна', note: 'Звънец не работи, моля обадете се.', status: 'pending', total: 2400, slot: '10:00' },
    { time: '08:02', customer: 'Мария Георгиева', phone: '+359 89 553 1290', items: [['Боровинки 250 г', 3]], delivery: 'econt', address: 'Еконт офис — ул. Осми Приморски полк 54', note: '', status: 'pending', total: 2370, slot: '11:00' },
    { time: '07:51', customer: 'Димитър Иванов', phone: '+359 88 901 6655', items: [['Малини 500 г', 1], ['Череши 1 кг', 1], ['Мед липов 450 г', 1]], delivery: 'address', address: 'бул. Сливница 45, вх. Б, ет. 3, Варна', note: '', status: 'pending', total: 3110, slot: '10:00' },
    { time: '07:38', customer: 'Елена Стоянова', phone: '+359 87 220 4418', items: [['Домашно сладко малина 320 г', 2]], delivery: 'address', address: 'ул. Драган Цанков 8, Варна', note: 'Предпочита доставка преди обяд.', status: 'pending', total: 1980, slot: '11:00' },
    { time: '07:22', customer: 'Георги Тодоров', phone: '+359 88 174 9920', items: [['Ягоди 500 г', 3]], delivery: 'address', address: 'ул. Княз Борис I 102, Варна', note: '', status: 'confirmed', total: 1950, slot: '10:00' },
    { time: '07:05', customer: 'Николай Димитров', phone: '+359 89 008 3471', items: [['Боровинки 250 г', 2], ['Малини 500 г', 1]], delivery: 'econt', address: 'Еконт офис — бул. Владислав Варненчик 277', note: '', status: 'confirmed', total: 2400, slot: '12:00' },
    { time: '06:54', customer: 'Анна Колева', phone: '+359 88 663 2017', items: [['Череши 1 кг', 2]], delivery: 'address', address: 'ж.к. Чайка, бл. 24, вх. А, Варна', note: 'Остави на портиера, ако ме няма.', status: 'confirmed', total: 1880, slot: '12:00' },
    { time: '06:40', customer: 'Стефан Маринов', phone: '+359 87 559 6603', items: [['Мед липов 450 г', 1], ['Сироп от ягоди 330 мл', 2]], delivery: 'address', address: 'ул. Македония 33, Варна', note: '', status: 'delivered', total: 3550, slot: '09:00' },
    { time: '06:31', customer: 'Петя Василева', phone: '+359 88 311 8842', items: [['Ягоди 500 г', 1], ['Боровинки 250 г', 1]], delivery: 'econt', address: 'Еконт офис — ул. Девня 16', note: '', status: 'delivered', total: 1440, slot: '09:00' },
    { time: '06:18', customer: 'Тодор Ангелов', phone: '+359 89 740 1126', items: [['Малини 500 г', 2]], delivery: 'address', address: 'ул. Подвис 7, Варна', note: '', status: 'delivered', total: 1640, slot: '09:00' },
    { time: '06:02', customer: 'Виолета Петкова', phone: '+359 88 425 5590', items: [['Домашно сладко малина 320 г', 1], ['Мед липов 450 г', 1]], delivery: 'address', address: 'ул. Генерал Колев 88, Варна', note: '', status: 'cancelled', total: 2340, slot: null },
    { time: '05:49', customer: 'Красимир Илиев', phone: '+359 87 992 0034', items: [['Череши 1 кг', 1]], delivery: 'address', address: 'ул. Хан Аспарух 21, Варна', note: '', status: 'delivered', total: 940, slot: '09:00' },
    { time: '05:33', customer: 'Десислава Райчева', phone: '+359 88 117 4408', items: [['Ягоди 500 г', 2], ['Малини 500 г', 1]], delivery: 'econt', address: 'Еконт офис — ул. Цар Освободител 109', note: '', status: 'confirmed', total: 2120, slot: '13:00' },
  ];

  // Number them per tenant in creation order (earliest = #1) like live intake does.
  const orderedDemo = [...DEMO_ORDERS].sort((a, b) => a.time.localeCompare(b.time));
  let seq = 0;
  for (const o of orderedDemo) {
    seq++;
    const isEcont = o.delivery === 'econt';
    const [order] = await db
      .insert(orders)
      .values({
        tenantId: tenant.id,
        orderNumber: seq,
        customerName: o.customer,
        customerPhone: o.phone,
        slotId: o.slot ? todaySlot.get(o.slot) ?? null : null,
        status: o.status,
        totalStotinki: o.total,
        deliveryType: o.delivery,
        deliveryAddress: isEcont ? null : o.address,
        econtOffice: isEcont ? o.address : null,
        notes: o.note || null,
        createdAt: new Date(`2026-05-30T${o.time}:00`),
      })
      .returning();

    await db.insert(orderItems).values(
      o.items.map(([itemName, quantity]) => {
        const p = findProduct(itemName);
        return {
          orderId: order.id,
          productId: p?.id ?? null,
          productName: itemName,
          quantity,
          priceStotinki: p?.priceStotinki ?? 0,
        };
      }),
    );
  }

  // 3 demo статии for the storefront news feed: 2 published, 1 draft.
  // Article 1 carries the full media mix (uploaded photo + YouTube embed).
  const [berriesArticle] = await db
    .insert(articles)
    .values([
      {
        tenantId: tenant.id,
        slug: 'yagodite-uzryaha',
        title: 'Ягодите узряха — започваме бране',
        excerpt: 'Първите ягоди за сезона са готови. Ето как ги берем и кога да очаквате доставка.',
        body:
          'Тази седмица започваме бране на ягодите от ранните лехи. Реколтата е отлична — едри, ароматни плодове, брани рано сутрин и доставяни същия ден.\n\nПоръчайте през магазина и изберете удобен слот за доставка. Количествата са ограничени в пиковите дни.',
        coverImageUrl: 'https://images.unsplash.com/photo-1464965911861-746a04b4bca6?w=1200&q=80',
        category: 'От полето',
        status: 'published',
        publishedAt: new Date('2026-05-28T07:30:00'),
      },
      {
        tenantId: tenant.id,
        slug: 'syhranenie-borovinki',
        title: 'Как съхраняваме боровинките пресни',
        excerpt: 'Няколко прости съвета, за да издържат боровинките по-дълго след доставка.',
        body:
          'Боровинките се пазят най-добре в хладилник, немити, в проветрива опаковка. Измивайте ги непосредствено преди консумация.\n\nТака запазват вкуса и плътността си до седмица.',
        coverImageUrl: 'https://images.unsplash.com/photo-1498557850523-fd3d118b962e?w=1200&q=80',
        category: 'Съвети',
        status: 'published',
        publishedAt: new Date('2026-05-26T09:00:00'),
      },
      {
        tenantId: tenant.id,
        slug: 'podgotovka-esen',
        title: 'Подготовка за есенния сезон',
        excerpt: 'Какво садим наесен и какви продукти да очаквате през следващите месеци.',
        body: 'Чернова — предстои да опишем плановете за есента.',
        coverImageUrl: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=1200&q=80',
        category: 'От полето',
        status: 'draft',
      },
    ])
    .returning();

  await db.insert(articleMedia).values([
    {
      articleId: berriesArticle.id,
      tenantId: tenant.id,
      type: 'image',
      url: 'https://images.unsplash.com/photo-1518635017498-87f514b751ba?w=1200&q=80',
      caption: 'Прясно набрани ягоди от сутрешното бране',
      position: 0,
    },
    {
      articleId: berriesArticle.id,
      tenantId: tenant.id,
      type: 'youtube',
      url: 'https://www.youtube.com/watch?v=ScMzIvxBSi4',
      embedId: 'ScMzIvxBSi4',
      caption: 'Разходка из ягодовите лехи',
      position: 1,
    },
  ]);

  // Published customer reviews (avg 4.8 over 6).
  await db.insert(reviews).values([
    { tenantId: tenant.id, authorName: 'Мария Д.', authorLocation: 'Варна', rating: 5, status: 'published', body: 'Малините са невероятни — наистина се усеща, че са брани същия ден. Децата ги изяждат преди да съм ги прибрала.' },
    { tenantId: tenant.id, authorName: 'Иван П.', authorLocation: 'Девня', rating: 5, status: 'published', body: 'Поръчвам всяка седмица. Доставката е точна, плодовете — безупречни. Сиропът от бъз е любим вкъщи.' },
    { tenantId: tenant.id, authorName: 'Елена Г.', authorLocation: 'Варна', rating: 5, status: 'published', body: 'Семейният пакет беше идеален подарък за рожден ден. Опаковката е красива, а вкусът — още по-добър.' },
    { tenantId: tenant.id, authorName: 'Георги Т.', authorLocation: 'Аксаково', rating: 4, status: 'published', body: 'Качеството е отлично. Единствено бих искал по-голям избор от сладка през зимата.' },
    { tenantId: tenant.id, authorName: 'Радостина К.', authorLocation: 'Варна', rating: 5, status: 'published', body: 'Личи си, че зад това стои семейство, на което му пука. Отношението е топло, а боровинките — най-добрите.' },
    { tenantId: tenant.id, authorName: 'Стефан М.', authorLocation: 'Белослав', rating: 5, status: 'published', body: 'Берем днес – доставяме днес не е просто реклама. Разликата с магазинните плодове е огромна.' },
  ]);

  console.log(`Seed complete — tenant "Ферма Петрови" + ${productRows.length} products + ${slotRows.length} slots + ${DEMO_ORDERS.length} orders + 3 articles + 6 reviews`);
  // Never print passwords — they leak into terminal scrollback + CI logs. The demo
  // credentials live in the repo docs for whoever needs them.
  console.log(`  owner login: ${OWNER_EMAIL} · platform login: ${PLATFORM_EMAIL} (passwords in docs)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
