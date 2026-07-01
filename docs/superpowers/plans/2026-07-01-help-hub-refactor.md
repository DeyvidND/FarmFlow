# Help Hub Refactor (FAQ search + AI Q&A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the thin walkthrough-only "Помощ" pages in `client` (farmer panel) and `delivery-web` (dostavki) with a searchable FAQ bank (categorized, 60+/32 entries) plus a docs-grounded "Ask AI" box, backed by a single shared content source.

**Architecture:** Two new pnpm workspace packages — `@fermeribg/help-content` (pure data: FAQ entries, categories, a client-side search function) and `@fermeribg/help-ui` (shared React components) — consumed by both Next.js apps. A new `HelpModule` on the existing NestJS server exposes `POST /help/ai/ask`, grounding a `gpt-4o-mini` call in the same FAQ corpus (no live tenant data, no RAG/vector store — the corpus is small enough to stuff directly into the prompt).

**Tech Stack:** TypeScript, pnpm workspaces + Turborepo, Next.js (client, delivery-web), NestJS (server), Jest/ts-jest, OpenAI SDK (`openai` npm package, already a server dependency).

---

## Spec reference

Full design: `docs/superpowers/specs/2026-07-01-help-hub-refactor-design.md`. One deliberate refinement made during planning: the search/filter logic (`searchFaq`) lives in `@fermeribg/help-content` (pure function, easy to unit-test with plain Jest) rather than as a React hook in `@fermeribg/help-ui` — `help-ui` stays presentation-only. This doesn't change any goal or behavior from the spec.

---

## Task 1: `@fermeribg/help-content` package — types, categories, search

**Files:**
- Create: `packages/help-content/package.json`
- Create: `packages/help-content/tsconfig.json`
- Create: `packages/help-content/src/types.ts`
- Create: `packages/help-content/src/categories.ts`
- Create: `packages/help-content/src/search.ts`
- Test: `packages/help-content/src/search.spec.ts`
- Create: `packages/help-content/src/index.ts`
- Modify: `pnpm-lock.yaml` (via `pnpm install`, not hand-edited)

- [ ] **Step 1: Scaffold the package**

Create `packages/help-content/package.json`:

```json
{
  "name": "@fermeribg/help-content",
  "version": "0.0.1",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "jest"
  },
  "jest": {
    "moduleFileExtensions": ["js", "json", "ts"],
    "rootDir": "src",
    "testRegex": ".*\\.spec\\.ts$",
    "transform": {
      "^.+\\.(t|j)s$": ["ts-jest", { "tsconfig": "<rootDir>/../tsconfig.json" }]
    },
    "testEnvironment": "node"
  },
  "devDependencies": {
    "typescript": "~5.6.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.4.11",
    "@types/jest": "^29.5.14"
  }
}
```

Create `packages/help-content/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.spec.ts"]
}
```

- [ ] **Step 2: Write `types.ts`**

```typescript
// packages/help-content/src/types.ts

export type HelpSurface = 'panel' | 'delivery';

export interface CategoryDef {
  id: string;
  label: string;
}

export interface FaqEntry {
  id: string;
  category: string;
  question: string;
  answer: string;
  /** Extra search terms not already present in the question/answer text. */
  keywords?: string[];
}
```

- [ ] **Step 3: Write `categories.ts`**

```typescript
// packages/help-content/src/categories.ts
import type { CategoryDef } from './types';

export const PANEL_CATEGORIES: CategoryDef[] = [
  { id: 'products', label: 'Продукти' },
  { id: 'orders', label: 'Поръчки' },
  { id: 'farmers', label: 'Фермери' },
  { id: 'categories', label: 'Категории' },
  { id: 'availability', label: 'Наличност' },
  { id: 'promotions', label: 'Промоции' },
  { id: 'delivery-slots', label: 'Доставка и часове' },
  { id: 'courier', label: 'Куриер' },
  { id: 'payments', label: 'Плащания' },
  { id: 'articles', label: 'Статии' },
  { id: 'reviews', label: 'Отзиви' },
  { id: 'site-editor', label: 'Сайт и редактор' },
  { id: 'marketing', label: 'Маркетинг' },
  { id: 'settings', label: 'Настройки' },
];

export const DELIVERY_CATEGORIES: CategoryDef[] = [
  { id: 'econt-speedy', label: 'Econt/Speedy връзка' },
  { id: 'import', label: 'Внос на пратки' },
  { id: 'handover', label: 'Предаване' },
  { id: 'cod', label: 'Проверка на клиент' },
  { id: 'tracking', label: 'Проследяване' },
];

export function categoriesFor(surface: 'panel' | 'delivery'): CategoryDef[] {
  return surface === 'delivery' ? DELIVERY_CATEGORIES : PANEL_CATEGORIES;
}
```

- [ ] **Step 4: Write the failing test for `search.ts`**

```typescript
// packages/help-content/src/search.spec.ts
import { searchFaq } from './search';
import type { FaqEntry } from './types';

const ENTRIES: FaqEntry[] = [
  { id: '1', category: 'products', question: 'Как добавям продукт?', answer: 'Отвори „Продукти" → „Добави продукт".' },
  { id: '2', category: 'orders', question: 'Как потвърждавам поръчка?', answer: 'Натисни „Потвърди" в панела.', keywords: ['статус'] },
  { id: '3', category: 'products', question: 'Как крия продукт?', answer: 'Ползвай превключвателя до продукта.' },
];

describe('searchFaq', () => {
  it('returns everything when query and categories are empty', () => {
    expect(searchFaq(ENTRIES, '', [])).toHaveLength(3);
  });

  it('filters by category', () => {
    const res = searchFaq(ENTRIES, '', ['orders']);
    expect(res.map((e) => e.id)).toEqual(['2']);
  });

  it('matches a question substring case-insensitively', () => {
    const res = searchFaq(ENTRIES, 'ДОБАВЯМ', []);
    expect(res.map((e) => e.id)).toEqual(['1']);
  });

  it('matches keywords even when absent from question/answer text', () => {
    const res = searchFaq(ENTRIES, 'статус', []);
    expect(res.map((e) => e.id)).toEqual(['2']);
  });

  it('ranks question matches above answer-only matches', () => {
    const res = searchFaq(ENTRIES, 'продукт', []);
    expect(res.map((e) => e.id)).toEqual(['1', '3']);
  });

  it('combines an active category filter with a query', () => {
    const res = searchFaq(ENTRIES, 'продукт', ['orders']);
    expect(res).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @fermeribg/help-content test`
Expected: FAIL — `Cannot find module './search'`

- [ ] **Step 6: Implement `search.ts`**

```typescript
// packages/help-content/src/search.ts
import type { FaqEntry } from './types';

const norm = (s: string) => s.toLowerCase();

/**
 * Client-side FAQ filter: category filter first, then a substring scorer over
 * question/keywords/answer (question match ranks highest). No server round trip —
 * the corpus is small enough (tens of entries) to filter entirely in the browser.
 */
export function searchFaq(entries: FaqEntry[], query: string, activeCategories: string[] = []): FaqEntry[] {
  const byCategory = activeCategories.length
    ? entries.filter((e) => activeCategories.includes(e.category))
    : entries;

  const q = norm(query.trim());
  if (!q) return byCategory;

  return byCategory
    .map((e) => {
      const question = norm(e.question);
      const answer = norm(e.answer);
      const keywords = (e.keywords ?? []).map(norm);
      let score = 0;
      if (question.includes(q)) score = 3;
      else if (keywords.some((k) => k.includes(q))) score = 2;
      else if (answer.includes(q)) score = 1;
      return { entry: e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.entry);
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/help-content test`
Expected: PASS (6 tests)

- [ ] **Step 8: Write `index.ts` barrel**

```typescript
// packages/help-content/src/index.ts
export type { HelpSurface, CategoryDef, FaqEntry } from './types';
export { PANEL_CATEGORIES, DELIVERY_CATEGORIES, categoriesFor } from './categories';
export { searchFaq } from './search';
```

- [ ] **Step 9: Commit**

```bash
git add packages/help-content
git commit -m "feat: scaffold help-content package with types, categories, search"
```

---

## Task 2: FAQ content — panel + delivery corpora

**Files:**
- Create: `packages/help-content/src/panel.faq.ts`
- Create: `packages/help-content/src/delivery.faq.ts`
- Test: `packages/help-content/src/content.spec.ts`
- Modify: `packages/help-content/src/index.ts`

- [ ] **Step 1: Write the failing content-integrity test**

```typescript
// packages/help-content/src/content.spec.ts
import { PANEL_FAQ } from './panel.faq';
import { DELIVERY_FAQ } from './delivery.faq';
import { PANEL_CATEGORIES, DELIVERY_CATEGORIES } from './categories';

function assertHealthy(entries: { id: string; category: string; question: string; answer: string }[], validCategoryIds: Set<string>, minCount: number) {
  expect(entries.length).toBeGreaterThanOrEqual(minCount);
  const ids = new Set<string>();
  for (const e of entries) {
    expect(ids.has(e.id)).toBe(false);
    ids.add(e.id);
    expect(validCategoryIds.has(e.category)).toBe(true);
    expect(e.question.trim().length).toBeGreaterThan(0);
    expect(e.answer.trim().length).toBeGreaterThan(0);
  }
}

describe('FAQ content integrity', () => {
  it('panel corpus has unique ids, valid categories, non-empty text, and enough entries', () => {
    assertHealthy(PANEL_FAQ, new Set(PANEL_CATEGORIES.map((c) => c.id)), 60);
  });

  it('delivery corpus has unique ids, valid categories, non-empty text, and enough entries', () => {
    assertHealthy(DELIVERY_FAQ, new Set(DELIVERY_CATEGORIES.map((c) => c.id)), 30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/help-content test`
Expected: FAIL — `Cannot find module './panel.faq'`

- [ ] **Step 3: Write `panel.faq.ts`** (60 entries — sourced from `client/src/app/(admin)/help/page.tsx`, `client/src/lib/help-content.ts`, `client/src/components/products/{product-dialog,courier-settings-modal}.tsx`, and `docs/admin-panel-guide.md`)

```typescript
// packages/help-content/src/panel.faq.ts
import type { FaqEntry } from './types';

export const PANEL_FAQ: FaqEntry[] = [
  // Продукти
  { id: 'p-products-1', category: 'products', question: 'Как добавям нов продукт?', answer: '„Продукти" → „Добави продукт". Име и цена са задължителни; наличност, тегло, категория и цвят са по избор. Празна наличност означава неограничено.' },
  { id: 'p-products-2', category: 'products', question: 'Как крия продукт без да го трия?', answer: 'Превключвателят до продукта го скрива или показва в магазина без изтриване — удобно за сезонни стоки.' },
  { id: 'p-products-3', category: 'products', question: 'Изтрих продукт по грешка, как го връщам?', answer: 'Изтриването е меко — продуктът само се скрива, името му остава запазено. Активирай го отново от списъка, не създавай дубликат.', keywords: ['възстанови', 'меко изтриване'] },
  { id: 'p-products-4', category: 'products', question: 'Как подреждам реда на продуктите в магазина?', answer: 'Бутон „Подреди" → влачи ред или ползвай стрелките ↑/↓. С падащото меню избираш дали пренареждаш всички продукти (глобален ред) или само в една категория. Редът важи еднакво за фермери и категории.' },
  { id: 'p-products-5', category: 'products', question: 'Как сменям корицата на продукт?', answer: '„Снимки" отваря галерия — качи няколко снимки, подреди ги с влачене; снимка №1 винаги е корицата, която клиентът вижда. Иконата за кадриране мести и мащабира снимката преди показване.' },
  { id: 'p-products-6', category: 'products', question: 'Как включвам „Продукт на седмицата"?', answer: 'Звездата на продукта → отвори панела „Продукт на седмицата" над списъка с продукти. Там избираш ръчна смяна или автоматично сменяне всяка седмица.' },
  // Поръчки
  { id: 'p-orders-1', category: 'orders', question: 'Как потвърждавам нова поръчка?', answer: 'Отвори я от „Поръчки" или „Табло" и натисни „Потвърди" — влиза в „Производство" и в маршрута за деня.' },
  { id: 'p-orders-2', category: 'orders', question: 'Как разбирам как ще пътува поръчка?', answer: 'Колоната „Доставка": Адрес (зелено) = твоя лична доставка, Еконт офис/адрес (кехлибар) = куриер, Пазар = вземане на място.' },
  { id: 'p-orders-3', category: 'orders', question: 'Обърках статус на поръчка, как го връщам?', answer: 'Изскачащото съобщение веднага след действието има бутон „Отмени" — работи само в кратък прозорец след промяната.' },
  { id: 'p-orders-4', category: 'orders', question: 'Как разбирам дали клиентът е платил?', answer: 'Цветната точка до статуса на поръчката показва плащането: платено, чака или наложен платеж.' },
  { id: 'p-orders-5', category: 'orders', question: 'Какво става при отказ на поръчка?', answer: 'Запазеният час за доставка се освобождава автоматично; отказаните поръчки не влизат в статистиката.' },
  // Фермери
  { id: 'p-farmers-1', category: 'farmers', question: 'Как включвам секция „Фермери" в магазина?', answer: '„Настройки → Конфигурации → Функции на магазина" → превключвател „Фермери". После управляваш производителите от екран „Фермери".' },
  { id: 'p-farmers-2', category: 'farmers', question: 'Как свързвам продукт с конкретен фермер?', answer: 'Щом „Фермери" е включено, формата за продукт получава поле за избор на фермер.' },
  { id: 'p-farmers-3', category: 'farmers', question: 'Може ли фермер да има собствен вход в панела?', answer: 'Да — от „Фермери" създаваш подакаунт с роля farmer; той вижда само своите продукти, поръчки и статистика.', keywords: ['подакаунт', 'логин'] },
  { id: 'p-farmers-4', category: 'farmers', question: 'Как фермер пуска пратки сам с курс на своя си акаунт?', answer: 'Ако фермерът има собствен Econt или Speedy акаунт, той го въвежда в dostavki панела („Настройки"), отделно от общия на фермата — оттам пуска пратки за своите продукти сам.' },
  // Категории
  { id: 'p-categories-1', category: 'categories', question: 'Как създавам категория?', answer: 'Включи „Категории" от „Функции на магазина", после отвори екран „Категории" → нова категория с име, описание, цвят и снимка.' },
  { id: 'p-categories-2', category: 'categories', question: 'Как продукт влиза в категория?', answer: 'От формата за продукт — полето за категория се появява само когато категориите са включени.' },
  { id: 'p-categories-3', category: 'categories', question: 'Как подреждам категориите в сайта?', answer: '„Подреди" на екран „Категории" — влачи ред или ползвай стрелките ↑/↓.' },
  // Наличност
  { id: 'p-availability-1', category: 'availability', question: 'Каква е разликата между наличност и скрит/видим продукт?', answer: 'Скрит/видим спира или пуска продажбата изцяло. Наличността е бройка, която намалява при всяка поръчка и сама скрива продукта, щом стигне 0.' },
  { id: 'p-availability-2', category: 'availability', question: 'Как задавам едно и също количество на много продукти наведнъж?', answer: 'Избери продуктите в списъка, после натисни „Задай за всички".' },
  { id: 'p-availability-3', category: 'availability', question: 'Продукт свърши предсрочно — какво правя?', answer: 'Изтрий наличността му от „Задай наличност" — продуктът излиза от магазина веднага.' },
  { id: 'p-availability-4', category: 'availability', question: 'Нулира ли се наличността сама всеки ден?', answer: 'Не — количеството пада само при поръчка. Ти решаваш кога да зададеш ново число.' },
  // Промоции
  { id: 'p-promotions-1', category: 'promotions', question: 'Как пускам промоция на продукт?', answer: 'В редактора на продукта отвори секцията за промоция и избери един от двата режима: процент отстъпка (важи за всички разфасовки) или фиксирана промо цена (за всяка разфасовка поотделно).', keywords: ['намаление', 'отстъпка'] },
  { id: 'p-promotions-2', category: 'promotions', question: 'Мога ли да комбинирам процент отстъпка и фиксирана цена?', answer: 'Не — режимите са взаимно изключващи се за един продукт; избираш само единия.' },
  { id: 'p-promotions-3', category: 'promotions', question: 'Как слагам краен срок на промоция?', answer: 'При процентна промоция има поле за крайна дата — след нея промоцията спира сама, без ти да я триеш ръчно.' },
  { id: 'p-promotions-4', category: 'promotions', question: 'Продукт с разфасовки (варианти) как получава промоция?', answer: 'Избери фиксиран режим и задай промо цена на всеки ред (разфасовка) поотделно — процентният режим важи само за продукт без варианти или еднакво за всички.' },
  { id: 'p-promotions-5', category: 'promotions', question: 'Как включвам или сменям „Продукт на седмицата"?', answer: 'Панелът над списъка с продукти — избираш ръчна смяна или автоматично сменяне всяка седмица; звездата на продукта го маркира като активен.' },
  // Доставка и часове
  { id: 'p-slots-1', category: 'delivery-slots', question: 'Как задавам часовете, в които разнасям сам?', answer: '„Настройки → Конфигурации → Часове за доставка" — избери дни и часове; включи „Повтарящи се часове", за да се появяват напред автоматично.' },
  { id: 'p-slots-2', category: 'delivery-slots', question: 'Какво означават цветовете на часовете?', answer: 'Зелено = свободно, оранжево = почти пълно, сиво = пълно.' },
  { id: 'p-slots-3', category: 'delivery-slots', question: 'Мога ли различни часове за различни дни от седмицата?', answer: 'Да — изключи „Еднакви часове за всички дни" и задай отделно разписание за всеки ден.' },
  { id: 'p-slots-4', category: 'delivery-slots', question: 'Как затварям конкретен почивен ден?', answer: '„Промени деня" на избраната дата — затваря я или ѝ сменя часовете; вече направените поръчки в тези часове остават непроменени.' },
  { id: 'p-slots-5', category: 'delivery-slots', question: 'Може ли един час да поеме повече от една поръчка?', answer: 'Не — щом часът се заеме, изчезва от магазина, за да няма двойно записване.' },
  { id: 'p-slots-6', category: 'delivery-slots', question: 'Как разделям голям времеви прозорец на по-малки часове?', answer: '„Колко трае една доставка" разделя прозореца (напр. по 1 час) — клиентът избира точен час вместо цял интервал.' },
  // Куриер
  { id: 'p-courier-1', category: 'courier', question: 'Как включвам доставка с Еконт за целия магазин?', answer: '„Настройки → Конфигурации → Методи и цени" → „Куриер (Еконт)"; подробната настройка (акаунт, зони, цени) е в „Доставка".' },
  { id: 'p-courier-2', category: 'courier', question: 'Как спирам куриер само за конкретен продукт?', answer: 'Отвори продукта → секция за доставка → изключи „С куриер". Продуктът продължава да се продава на лична доставка, вземане на място или местна доставка до адрес — просто не пътува с Еконт/Speedy.', keywords: ['без куриер', 'courierDisabled'] },
  { id: 'p-courier-3', category: 'courier', question: 'Как спирам куриер за много продукти наведнъж?', answer: 'На екран „Продукти" отвори груповия диалог за куриер настройки — превключвател за всеки продукт наведнъж, после „Запази".' },
  { id: 'p-courier-4', category: 'courier', question: 'Продукт без куриер вижда ли се различно в магазина?', answer: 'Да — получава значка „без куриер"; ако кошницата на клиента съдържа само такива продукти, опцията за куриерска доставка отпада при плащане.' },
  { id: 'p-courier-5', category: 'courier', question: 'Кога фермер трябва да си свърже собствен Еконт/Speedy акаунт?', answer: 'Когато разнася собствените си продукти сам с куриер, отделно от общия акаунт на фермата — тогава го въвежда в dostavki панела.' },
  // Плащания
  { id: 'p-payments-1', category: 'payments', question: 'Как включвам плащане с карта?', answer: '„Плащания → Свържи Stripe" — регистрацията се прави на сигурната страница на Stripe и отнема около 5 минути.' },
  { id: 'p-payments-2', category: 'payments', question: 'Взима ли ФермериБГ комисиона от продажбите?', answer: 'Не — 0% комисиона. Парите от поръчките идват директно по твоята сметка; ти плащаш само таксата на Stripe за всяка трансакция.' },
  { id: 'p-payments-3', category: 'payments', question: 'Как отбелязвам получен наложен платеж?', answer: 'В „Плащания" всяка поръчка с наложен платеж е „Очаквано" или „Получено" — маркираш ръчно щом събереш парите в брой.' },
  { id: 'p-payments-4', category: 'payments', question: 'Как правя рефънд на клиент?', answer: 'От бутона „Отвори Stripe" — това е твоят собствен Stripe панел; там правиш връщания на пари и уреждаш спорове.' },
  { id: 'p-payments-5', category: 'payments', question: 'Кога идват парите ми по сметката след картово плащане?', answer: 'Обикновено за 2–7 дни. Наложеният платеж е в брой директно при теб — не минава през Stripe.' },
  { id: 'p-payments-6', category: 'payments', question: 'Какво ми трябва, за да свържа Stripe?', answer: 'Лична карта, IBAN на банковата ти сметка, телефон и имейл; понякога Stripe иска и снимка на личната карта за проверка на самоличността.' },
  // Статии
  { id: 'p-articles-1', category: 'articles', question: 'Как публикувам статия в сайта?', answer: '„Нова статия" създава чернова; превключвателят Чернова ⇄ Публикувана я качва в сайта или я сваля обратно.' },
  { id: 'p-articles-2', category: 'articles', question: 'Мога ли да прегледам статия преди публикуване?', answer: 'Да — бутонът „Преглед" показва точно как ще изглежда в сайта, преди клиентите да я видят.' },
  { id: 'p-articles-3', category: 'articles', question: 'Мога ли да сложа снимки вътре в текста на статия?', answer: 'Да — текстовият редактор приема снимки (JPEG, PNG, WebP) направо в съдържанието, заедно с заглавия, удебелен/курсив текст, цвят и списъци.' },
  // Отзиви
  { id: 'p-reviews-1', category: 'reviews', question: 'Нов отзив показва ли се веднага в сайта?', answer: 'Не — чака твоето одобрение в списъка „Чакащи". „Публикувай" го качва в магазина, „Скрий" го маха без изтриване.' },
  { id: 'p-reviews-2', category: 'reviews', question: 'Мога ли да скрия вече публикуван отзив?', answer: 'Да, по всяко време — и обратно, скрит отзив можеш пак да публикуваш.' },
  { id: 'p-reviews-3', category: 'reviews', question: 'Мога ли да избера кои отзиви да излизат на началната страница?', answer: 'Да — „Настройки → Начална страница → Отзиви" ти позволява ръчно да избереш до 12 публикувани отзива.' },
  // Сайт и редактор
  { id: 'p-site-1', category: 'site-editor', question: 'Как редактирам текст директно в сайта?', answer: '„Съдържание и сайт → Промени сайта" → „Редактирай сайта". Кликаш върху текст или снимка на живо, после „Запази". Достъпът важи 30 минути; изтече ли, натисни бутона отново.' },
  { id: 'p-site-2', category: 'site-editor', question: 'Как редактирам FAQ страницата на сайта (/faq)?', answer: 'В същия режим на редактиране: ↑/↓ пренарежда въпросите, ✕ трие ред, „+ Добави въпрос" добавя нов; „Запази" записва всичко.' },
  { id: 'p-site-3', category: 'site-editor', question: 'Как сменям снимка в сайта?', answer: 'Натисни „Смени снимка" върху желаното място за снимка, избери файл (JPEG/PNG/WebP) — качва се веднага, после „Запази".' },
  { id: 'p-site-4', category: 'site-editor', question: 'Къде сменям адрес, работно време и социални мрежи?', answer: '„Съдържание и сайт → Контакти" — отделен екран от „Промени сайта".' },
  { id: 'p-site-5', category: 'site-editor', question: 'Как качвам икона (favicon) на сайта?', answer: 'От „Контакти" → качи PNG или ICO файл, препоръчан размер 32×32 или 64×64 px — появява се до името на сайта в браузъра.' },
  // Маркетинг
  { id: 'p-marketing-1', category: 'marketing', question: 'Как свързвам Google Analytics?', answer: '„Маркетинг и проследяване" → постави Measurement ID (започва с G-).' },
  { id: 'p-marketing-2', category: 'marketing', question: 'Рекламните кодове тръгват ли преди клиентът да приеме бисквитки?', answer: 'Не — магазинът показва GDPR бар за съгласие; рекламните кодове тръгват едва след като клиентът приеме бисквитките.' },
  { id: 'p-marketing-3', category: 'marketing', question: 'Как отчитам покупки като конверсия в Google Ads?', answer: 'Постави Conversion ID (AW-) и Conversion Label в „Маркетинг и проследяване" — конверсиите се броят автоматично на страницата за потвърждение на поръчка.' },
  // Настройки
  { id: 'p-settings-1', category: 'settings', question: 'Как сменям паролата си?', answer: '„Настройки → Смяна на парола": текуща парола → нова (поне 8 символа, различна) → потвърди.' },
  { id: 'p-settings-2', category: 'settings', question: 'Забравих паролата си — какво правя?', answer: 'На екрана за вход натисни „Забравена парола?" — изпраща линк за смяна по имейл.' },
  { id: 'p-settings-3', category: 'settings', question: 'Как скривам елементи от лявото меню?', answer: '„Настройки → Странична навигация" — скрий или покажи цели групи от менюто; „Табло" остава винаги видимо.' },
  { id: 'p-settings-4', category: 'settings', question: 'Как избирам кои блокове да се виждат на началната страница на магазина?', answer: '„Настройки → Начална страница" — избираш категории, фермери, най-актуални продукти и колко неща да стоят във всеки блок.' },
];
```

- [ ] **Step 4: Write `delivery.faq.ts`** (32 entries — sourced from `delivery-web/src/components/help-client.tsx`, `delivery-web/src/components/shipments-client.tsx`, `delivery-web/src/components/farmer-delivery/farmer-delivery-client.tsx` equivalent Econt/Speedy setup flows)

```typescript
// packages/help-content/src/delivery.faq.ts
import type { FaqEntry } from './types';

export const DELIVERY_FAQ: FaqEntry[] = [
  // Econt/Speedy връзка
  { id: 'd-connect-1', category: 'econt-speedy', question: 'Какво ми трябва, за да свържа Econt?', answer: 'e-Econt профил (бизнес клиент) плюс одобрен достъп до интеграция от Econt (пиши на support_integrations@econt.com). После въвеждаш потребител и парола в „Настройки".' },
  { id: 'd-connect-2', category: 'econt-speedy', question: 'Какво ми трябва, за да свържа Speedy?', answer: 'Договор като бизнес клиент на Speedy плюс отделен API потребител и парола от api.registration@speedy.bg — различни от обикновения логин в сайта на Speedy.' },
  { id: 'd-connect-3', category: 'econt-speedy', question: 'Мога ли да тествам без реален акаунт?', answer: 'Да — Econt има Демо среда с тестови данни (потребител iasp-dev, парола 1Asp-dev). Ползвай ги само за проба, не за реални пратки.' },
  { id: 'd-connect-4', category: 'econt-speedy', question: 'Каква е разликата между Демо и Реална среда?', answer: 'Демо не създава истински товарителници — само за тест. Реална създава реални пратки, които куриерът действително взема.' },
  { id: 'd-connect-5', category: 'econt-speedy', question: 'Мога ли да свържа и Econt, и Speedy едновременно?', answer: 'Да — свързваш и двата; при внос на пратки „Сравни куриери" автоматично избира по-евтиния за всеки ред.' },
  { id: 'd-connect-6', category: 'econt-speedy', question: 'Услугата ми показва „не е активна" — защо?', answer: 'Активирането се прави от администратор. Свържи куриерските акаунти; щом услугата стане активна, ще можеш да създаваш пратки.' },
  { id: 'd-connect-7', category: 'econt-speedy', question: 'Точното изписване на потребител/парола важно ли е?', answer: 'Да — главни и малки букви имат значение, както за Econt, така и за Speedy.' },
  // Внос на пратки
  { id: 'd-import-1', category: 'import', question: 'Как качвам много пратки наведнъж?', answer: 'Екран „Внос" — свали готовия Excel шаблон, попълни получател, телефон, град, режим (офис/адрес) и наложен платеж, после качи файла.' },
  { id: 'd-import-2', category: 'import', question: 'Какво значат цветовете в таблицата след качване?', answer: 'Зелено = готово, жълто = внимание, червено = трябва поправка. Редактираш директно на място в таблицата.' },
  { id: 'd-import-3', category: 'import', question: 'Как избирам по-евтиния куриер за всеки ред?', answer: 'Бутон „Сравни куриери" пита Econt и Speedy за цена на всеки ред и слага по-евтиния автоматично; после може ръчно да смениш куриера в колоната.' },
  { id: 'd-import-4', category: 'import', question: 'Защо колоната „Цена" показва „—"?', answer: 'Цената се появява чак след „Сравни куриери". Ако остане „—", куриерът не е върнал цена — липсва свързан акаунт, грешен град или грешен режим — и редът остава на Econt.' },
  { id: 'd-import-5', category: 'import', question: 'В каква валута са сумите във файла за внос?', answer: 'Всичко е в евро (EUR) — и наложеният платеж се чете в евро.' },
  { id: 'd-import-6', category: 'import', question: 'Какво тегло да сложа, ако не знам точно?', answer: 'Остави полето празно — автоматично се ползва 1 кг по подразбиране.' },
  // Предаване
  { id: 'd-handover-1', category: 'handover', question: 'Как предавам готова пратка на куриера?', answer: 'Два начина: свали и залепи етикета, после сам я занеси до офис на куриера; или маркирай пратката и натисни „Заяви куриер да вземе" от адреса ти.' },
  { id: 'd-handover-2', category: 'handover', question: 'Кой начин на предаване е по-добър за мен?', answer: 'При 1–2 пратки често е по-бързо да отскочиш до офиса, особено ако бездруго минаваш натам. От 3–4 пратки нагоре или при далечен офис — заявката за куриер обикновено си струва.' },
  { id: 'd-handover-3', category: 'handover', question: 'Как поръчка от онлайн магазина стига до „Пратки"?', answer: 'Клиент избере „Куриер" при поръчка → тя се появява като чернова на екран „Пратки". Избираш куриер и натискаш „Създай товарителница".' },
  { id: 'd-handover-4', category: 'handover', question: 'Какво пише в бутона „Детайли" на чернова пратка?', answer: 'Тегло, брой колети, съдържание и обявена стойност (застраховка) — всяко поле с кратко обяснение; празно поле означава стойност по подразбиране от фермата.' },
  { id: 'd-handover-5', category: 'handover', question: 'Клиентът разбира ли кога е пусната пратката?', answer: 'Да — автоматичен имейл с линк за проследяване, и за Econt, и за Speedy пратки.' },
  { id: 'd-handover-6', category: 'handover', question: 'Номерът на товарителницата активен линк ли е?', answer: 'Да — в таблицата „Пратки" номерът на товарителницата води директно към страницата за проследяване при куриера.' },
  { id: 'd-handover-7', category: 'handover', question: 'Мога ли да обновя статуса на пратка ръчно?', answer: 'Да — бутонът „Опресни статус" на всеки ред изтегля последното състояние директно от куриера, без да чакаш автоматично обновяване.' },
  // Проверка на клиент (COD)
  { id: 'd-cod-1', category: 'cod', question: 'Защо да проверявам клиент преди наложен платеж?', answer: 'За да намалиш риска от върната или отказана пратка — базата пази сигнали от други търговци за проблемни телефонни номера.' },
  { id: 'd-cod-2', category: 'cod', question: 'Какво значат нивата „Чисто", „Внимание" и „Висок риск"?', answer: 'Чисто = няма сигнали, безопасно. Внимание = единичен сигнал, провери лично. Висок риск = много сигнали, поискай предплащане вместо наложен платеж.' },
  { id: 'd-cod-3', category: 'cod', question: 'Как докладвам проблемен клиент?', answer: '„За докладване" показва върнати или отказани пратки с наложен платеж — натисни „Докладвай", за да добавиш клиента в общата база за риск.' },
  { id: 'd-cod-4', category: 'cod', question: 'Проверката гарантира ли, че клиентът ще плати?', answer: 'Не — тя само показва исторически сигнали от други търговци. Решението дали да пуснеш наложен платеж или да поискаш предплащане си е твое.' },
  { id: 'd-cod-5', category: 'cod', question: 'Виждам ли чужди детайли за поръчки при проверка на клиент?', answer: 'Не — виждаш само обобщено ниво на риск за телефонния номер, без имена или детайли за чужди поръчки.' },
  { id: 'd-cod-6', category: 'cod', question: 'Мога ли да докладвам клиент по-късно, ако пратката се върне седмица след пускането ѝ?', answer: 'Да — списъкът „За докладване" остава достъпен; докладвай веднага щом видиш връщането, за да помогнеш и на другите търговци.' },
  // Проследяване
  { id: 'd-tracking-1', category: 'tracking', question: 'Къде виждам статуса на пусната пратка?', answer: 'Екран „Пратки" — колоната Статус показва цветен етикет (създадена, изпратена, доставена, върната, отказана).' },
  { id: 'd-tracking-2', category: 'tracking', question: 'Проследяването различно ли е за Econt и Speedy?', answer: 'Линкът е различен по адрес, но и двата водят директно към официалната страница за проследяване на съответния куриер.' },
  { id: 'd-tracking-3', category: 'tracking', question: 'Клиентите звънят ли по-рядко след пускане на пратка?', answer: 'Обикновено да — имейлът с линк за проследяване намалява обажданията от типа „къде ми е поръчката".' },
  { id: 'd-tracking-4', category: 'tracking', question: 'Мога ли да сваля отново вече свален етикет?', answer: 'Да — бутонът „Свали етикет" на екран „Пратки" остава достъпен, докато пратката съществува в системата.' },
  { id: 'd-tracking-5', category: 'tracking', question: 'Какво показват бройките горе на екран „Пратки"?', answer: 'Обобщение по статус: Общо, Доставени, Изпратени, Създадени (чернови + чакащи) и Проблемни (върнати + отказани).' },
  { id: 'd-tracking-6', category: 'tracking', question: 'Как разбирам, че пратка вече е доставена?', answer: 'Статусът ѝ в таблицата минава на „Доставена" — натисни „Опресни статус" на реда, за да изтеглиш последното състояние от куриера.' },
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/help-content test`
Expected: PASS (8 tests total across both spec files)

- [ ] **Step 6: Update `index.ts` to export the content**

```typescript
// packages/help-content/src/index.ts
export type { HelpSurface, CategoryDef, FaqEntry } from './types';
export { PANEL_CATEGORIES, DELIVERY_CATEGORIES, categoriesFor } from './categories';
export { searchFaq } from './search';
export { PANEL_FAQ } from './panel.faq';
export { DELIVERY_FAQ } from './delivery.faq';
```

- [ ] **Step 7: Build the package**

Run: `pnpm --filter @fermeribg/help-content build`
Expected: `packages/help-content/dist/` created with `.js`/`.d.ts` files, no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/help-content
git commit -m "feat: add panel and delivery FAQ corpora"
```

---

## Task 3: `@fermeribg/help-ui` package — shared presentational components

**Files:**
- Create: `packages/help-ui/package.json`
- Create: `packages/help-ui/tsconfig.json`
- Create: `packages/help-ui/src/HelpSearchBar.tsx`
- Create: `packages/help-ui/src/CategoryChips.tsx`
- Create: `packages/help-ui/src/FaqAccordion.tsx`
- Create: `packages/help-ui/src/AskAiBox.tsx`
- Create: `packages/help-ui/src/index.ts`

No unit tests in this task — these are thin presentational components with no branching logic worth a render-test harness (the project doesn't have `@testing-library/react` set up anywhere; adding that infra for four small components would be disproportionate). `searchFaq` (the only logic) is already tested in Task 1. Manual verification happens in Tasks 5–6.

- [ ] **Step 1: Scaffold the package**

Create `packages/help-ui/package.json`:

```json
{
  "name": "@fermeribg/help-ui",
  "version": "0.0.1",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "peerDependencies": {
    "react": "^18.3.1"
  },
  "dependencies": {
    "@fermeribg/help-content": "workspace:*",
    "lucide-react": "^0.453.0"
  },
  "devDependencies": {
    "typescript": "~5.6.0",
    "@types/react": "^18.3.11"
  }
}
```

Create `packages/help-ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "lib": ["dom", "esnext"]
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Write `HelpSearchBar.tsx`**

```tsx
// packages/help-ui/src/HelpSearchBar.tsx
'use client';
import { Search } from 'lucide-react';

export function HelpSearchBar({
  value,
  onChange,
  placeholder = 'Търси въпрос…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 shadow-ff-sm">
      <Search size={18} className="shrink-0 text-ff-muted" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[13.5px] text-ff-ink outline-none placeholder:text-ff-muted"
      />
    </div>
  );
}
```

- [ ] **Step 3: Write `CategoryChips.tsx`**

```tsx
// packages/help-ui/src/CategoryChips.tsx
'use client';
import type { CategoryDef } from '@fermeribg/help-content';

export function CategoryChips({
  categories,
  active,
  onToggle,
}: {
  categories: CategoryDef[];
  active: string[];
  onToggle: (id: string) => void;
}) {
  const chip = (isActive: boolean) =>
    `rounded-full border px-3 py-1.5 text-[12.5px] font-bold transition-colors ${
      isActive
        ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-800'
        : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2'
    }`;
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => active.forEach(onToggle)} className={chip(active.length === 0)}>
        Всички
      </button>
      {categories.map((c) => (
        <button key={c.id} type="button" onClick={() => onToggle(c.id)} className={chip(active.includes(c.id))}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write `FaqAccordion.tsx`**

```tsx
// packages/help-ui/src/FaqAccordion.tsx
import type { FaqEntry } from '@fermeribg/help-content';

export function FaqAccordion({ entries }: { entries: FaqEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-ff-border bg-ff-surface-2 p-4 text-center text-[13px] text-ff-muted">
        Нищо не съвпада с търсенето. Пробвай друга дума или питай AI помощника по-долу.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-4">
      {entries.map((e) => (
        <details key={e.id} className="group border-b border-ff-border-2 py-1 last:border-0">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2.5 text-[13.5px] font-bold text-ff-ink [&::-webkit-details-marker]:hidden">
            {e.question}
            <span className="shrink-0 text-ff-muted transition-transform group-open:rotate-180">⌄</span>
          </summary>
          <p className="pb-3 text-[13px] leading-relaxed text-ff-ink-2">{e.answer}</p>
        </details>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Write `AskAiBox.tsx`**

```tsx
// packages/help-ui/src/AskAiBox.tsx
'use client';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';

export function AskAiBox({ onAsk }: { onAsk: (question: string) => Promise<string> }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await onAsk(q));
    } catch {
      setError('AI помощникът не е достъпен в момента, виж въпросите по-горе.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-ink">
        <Sparkles size={17} className="text-ff-green-700" /> Не намери отговор? Питай AI
      </div>
      <div className="mt-2.5 flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Напиши въпроса си…"
          className="w-full rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2 text-[13px] text-ff-ink outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={loading || !question.trim()}
          className="shrink-0 rounded-lg bg-ff-green-700 px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-50"
        >
          {loading ? '…' : 'Питай'}
        </button>
      </div>
      {answer && <p className="mt-3 rounded-lg bg-ff-green-50 p-3 text-[13px] leading-relaxed text-ff-ink-2">{answer}</p>}
      {error && <p className="mt-3 text-[12.5px] text-ff-red">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 6: Write `index.ts` barrel**

```typescript
// packages/help-ui/src/index.ts
export { HelpSearchBar } from './HelpSearchBar';
export { CategoryChips } from './CategoryChips';
export { FaqAccordion } from './FaqAccordion';
export { AskAiBox } from './AskAiBox';
```

- [ ] **Step 7: Install and build**

Run: `pnpm install && pnpm --filter @fermeribg/help-ui build`
Expected: `packages/help-ui/dist/` created, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/help-ui
git commit -m "feat: add help-ui shared components (search, chips, accordion, ask-ai box)"
```

---

## Task 4: Server — `POST /help/ai/ask` endpoint

**Files:**
- Create: `server/src/modules/help/dto/help-ask.dto.ts`
- Create: `server/src/modules/help/help-ai.service.ts`
- Test: `server/src/modules/help/help-ai.service.spec.ts`
- Create: `server/src/modules/help/help.controller.ts`
- Create: `server/src/modules/help/help.module.ts`
- Modify: `server/src/app.module.ts`
- Modify: `server/package.json` (add `@fermeribg/help-content` dependency)

- [ ] **Step 1: Add the dependency**

In `server/package.json`, add to `"dependencies"` (alongside the existing `"@fermeribg/types": "workspace:*"` line):

```json
    "@fermeribg/help-content": "workspace:*",
```

Run: `pnpm install`

- [ ] **Step 2: Write the DTO**

```typescript
// server/src/modules/help/dto/help-ask.dto.ts
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class HelpAskDto {
  @IsIn(['panel', 'delivery'])
  surface!: 'panel' | 'delivery';

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question!: string;
}
```

- [ ] **Step 3: Write the failing test for `HelpAiService`**

```typescript
// server/src/modules/help/help-ai.service.spec.ts
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { HelpAiService } from './help-ai.service';

function makeSvc(key: string | null = null) {
  const config = { get: (k: string, d?: unknown) => (k === 'OPENAI_API_KEY' ? key : d) } as any;
  return new HelpAiService(config);
}

describe('HelpAiService.ask', () => {
  it('rejects an empty question', async () => {
    await expect(makeSvc().ask('panel', '   ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a question over 500 chars', async () => {
    await expect(makeSvc().ask('panel', 'a'.repeat(501))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is unavailable when no API key is configured', async () => {
    await expect(makeSvc().ask('panel', 'Как добавям продукт?')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns the model answer, grounded via the surface corpus', async () => {
    const svc = makeSvc('key');
    (svc as any).client = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Отвори „Продукти" → „Добави продукт".' } }] }) } },
    };
    const answer = await svc.ask('panel', 'Как добавям продукт?');
    expect(answer).toContain('Добави продукт');
  });

  it('surfaces an OpenAI failure as ServiceUnavailable', async () => {
    const svc = makeSvc('key');
    (svc as any).client = {
      chat: { completions: { create: async () => { throw new Error('timeout'); } } },
    };
    await expect(svc.ask('panel', 'Как добавям продукт?')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- help-ai.service`
Expected: FAIL — `Cannot find module './help-ai.service'`

- [ ] **Step 5: Implement `HelpAiService`**

```typescript
// server/src/modules/help/help-ai.service.ts
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { DELIVERY_FAQ, PANEL_FAQ, type FaqEntry, type HelpSurface } from '@fermeribg/help-content';

const MAX_QUESTION = 500;

function corpusFor(surface: HelpSurface): FaqEntry[] {
  return surface === 'delivery' ? DELIVERY_FAQ : PANEL_FAQ;
}

function buildSystemPrompt(entries: FaqEntry[]): string {
  const qa = entries.map((e) => `В: ${e.question}\nО: ${e.answer}`).join('\n\n');
  return (
    'Ти си помощник за българска платформа за фермерски онлайн магазини (ФермериБГ). ' +
    'Отговаряй САМО въз основа на въпросите и отговорите по-долу — това е цялата документация, с която разполагаш. ' +
    'Ако въпросът на потребителя не е покрит в нея, кажи ясно, че не знаеш, и го насочи към списъка с въпроси горе или към поддръжката. ' +
    'Никога не измисляй функционалност, която не е описана тук. Отговаряй кратко и на български.\n\n' +
    qa
  );
}

@Injectable()
export class HelpAiService {
  private readonly log = new Logger(HelpAiService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('OPENAI_API_KEY');
    this.client = key ? new OpenAI({ apiKey: key, timeout: 20_000, maxRetries: 1 }) : null;
    this.model = config.get<string>('OPENAI_IMPORT_MODEL', 'gpt-4o-mini') ?? 'gpt-4o-mini';
  }

  async ask(surface: HelpSurface, question: string): Promise<string> {
    const q = question.trim();
    if (!q) throw new BadRequestException('Въпросът е празен');
    if (q.length > MAX_QUESTION) throw new BadRequestException('Въпросът е твърде дълъг');
    if (!this.client) throw new ServiceUnavailableException('AI помощникът не е достъпен в момента');

    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: buildSystemPrompt(corpusFor(surface)) },
          { role: 'user', content: q },
        ],
        temperature: 0.2,
      });
      const answer = res.choices[0]?.message?.content?.trim();
      if (!answer) throw new Error('empty response from model');
      return answer;
    } catch (err) {
      this.log.warn(`AI ask failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('AI помощникът не е достъпен в момента');
    }
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- help-ai.service`
Expected: PASS (5 tests)

- [ ] **Step 7: Write the controller**

```typescript
// server/src/modules/help/help.controller.ts
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { HelpAiService } from './help-ai.service';
import { HelpAskDto } from './dto/help-ask.dto';

/** Docs-grounded AI Q&A for the Help pages. No tenant/live-data access by design. */
@ApiTags('help')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('help')
export class HelpController {
  constructor(private readonly helpAi: HelpAiService) {}

  @Roles('admin', 'farmer')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('ai/ask')
  async ask(@Body() dto: HelpAskDto) {
    const answer = await this.helpAi.ask(dto.surface, dto.question);
    return { answer };
  }
}
```

- [ ] **Step 8: Write the module**

```typescript
// server/src/modules/help/help.module.ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HelpController } from './help.controller';
import { HelpAiService } from './help-ai.service';

@Module({
  imports: [AuthModule],
  controllers: [HelpController],
  providers: [HelpAiService],
})
export class HelpModule {}
```

- [ ] **Step 9: Wire `HelpModule` into `app.module.ts`**

Open `server/src/app.module.ts`. Find the block of feature-module imports near `PlatformModule`/`EcontModule` and add:

```typescript
import { HelpModule } from './modules/help/help.module';
```

next to the other `./modules/...` imports, then add `HelpModule` to the root `imports: [...]` array (alongside the other feature modules like `EcontModule`, `PlatformModule`).

- [ ] **Step 10: Run the full server test suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: PASS, no regressions, `HelpAiService` suite included.

- [ ] **Step 11: Commit**

```bash
git add server/src/modules/help server/src/app.module.ts server/package.json pnpm-lock.yaml
git commit -m "feat(server): add POST /help/ai/ask, grounded in the FAQ corpus"
```

---

## Task 5: Wire into the farmer panel (`client`)

**Files:**
- Modify: `client/package.json` (add `@fermeribg/help-content`, `@fermeribg/help-ui`)
- Modify: `client/src/lib/api-client.ts` (add `askHelpAi`)
- Modify: `client/src/app/(admin)/help/page.tsx`

- [ ] **Step 1: Add dependencies**

In `client/package.json` `"dependencies"`, add:

```json
    "@fermeribg/help-content": "workspace:*",
    "@fermeribg/help-ui": "workspace:*",
```

Run: `pnpm install`

- [ ] **Step 2: Add `askHelpAi` to `api-client.ts`**

Add near the bottom of `client/src/lib/api-client.ts` (after the existing farmer/product helpers, following the `json()`-helper pattern already used by `createProduct` etc.):

```typescript
export const askHelpAi = (question: string) =>
  apiFetch<{ answer: string }>(
    'help/ai/ask',
    { method: 'POST', ...json({ surface: 'panel', question }) },
    'AI помощникът не е достъпен в момента',
  );
```

- [ ] **Step 3: Compose the FAQ + AI section into the Help page**

Modify `client/src/app/(admin)/help/page.tsx`. Add imports at the top (after the existing `lucide-react` import):

```typescript
import { useState } from 'react';
import { PANEL_CATEGORIES, PANEL_FAQ, searchFaq } from '@fermeribg/help-content';
import { HelpSearchBar, CategoryChips, FaqAccordion, AskAiBox } from '@fermeribg/help-ui';
import { askHelpAi } from '@/lib/api-client';
```

This page currently has no `'use client'` directive (it's a static server component). Adding `useState` requires making it a client component — add `'use client';` as the very first line of the file.

Replace the final closing of the component — insert a new section between the walkthrough `<div className="flex flex-col gap-3">...</div>` block and the trailing `<p className="mt-7 ...">` footer:

```tsx
      {/* FAQ search + AI — added below the walkthrough sections */}
      <FaqSection />

      <p className="mt-7 text-center text-[12.5px] text-ff-muted">ФермериБГ · Помощ</p>
    </div>
  );
}

function FaqSection() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string[]>([]);
  const toggle = (id: string) =>
    setActive((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const results = searchFaq(PANEL_FAQ, query, active);

  return (
    <div className="mt-7 flex flex-col gap-3">
      <h2 className="text-[18px] font-extrabold tracking-[-0.01em]">Често задавани въпроси</h2>
      <HelpSearchBar value={query} onChange={setQuery} />
      <CategoryChips categories={PANEL_CATEGORIES} active={active} onToggle={toggle} />
      <FaqAccordion entries={results} />
      <AskAiBox onAsk={(q) => askHelpAi(q).then((r) => r.answer)} />
    </div>
  );
}
```

Note: the existing file ends with:
```tsx
      <p className="mt-7 text-center text-[12.5px] text-ff-muted">ФермериБГ · Помощ</p>
    </div>
  );
}
```
— replace that exact closing block with the snippet above (which reproduces the same footer paragraph before adding the new `FaqSection` function below it).

- [ ] **Step 4: Verify it builds**

Run: `pnpm --filter @fermeribg/web build`
Expected: build succeeds, no type errors.

- [ ] **Step 5: Manual check in dev server**

Run: `pnpm --filter @fermeribg/web dev`, open the panel, log in, navigate to „Помощ". Confirm:
- Walkthrough sections still render as before.
- New "Често задавани въпроси" section shows the search bar, category chips, and FAQ list.
- Typing in the search bar filters results live.
- Clicking a category chip filters to that category; clicking "Всички" resets.
- Asking the AI box a question covered by the FAQ returns a grounded answer; asking something unrelated (e.g. "Какво е времето утре?") returns a polite "not covered" answer or the inline unavailable message if `OPENAI_API_KEY` isn't set locally.

- [ ] **Step 6: Commit**

```bash
git add client/package.json client/src/lib/api-client.ts client/src/app/\(admin\)/help/page.tsx pnpm-lock.yaml
git commit -m "feat(client): add FAQ search and AI Q&A to the Help page"
```

---

## Task 6: Wire into dostavki (`delivery-web`)

**Files:**
- Modify: `delivery-web/package.json` (add `@fermeribg/help-content`, `@fermeribg/help-ui`)
- Modify: `delivery-web/src/lib/api-client.ts` (add `askHelpAi`)
- Modify: `delivery-web/src/components/help-client.tsx`

- [ ] **Step 1: Add dependencies**

In `delivery-web/package.json` `"dependencies"`, add:

```json
    "@fermeribg/help-content": "workspace:*",
    "@fermeribg/help-ui": "workspace:*",
```

Run: `pnpm install`

- [ ] **Step 2: Add `askHelpAi` to `api-client.ts`**

Add near the other helpers in `delivery-web/src/lib/api-client.ts` (following the `bff()`-helper pattern used by `compareShipment`):

```typescript
export const askHelpAi = async (question: string): Promise<{ answer: string }> =>
  (await bff('help/ai/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ surface: 'delivery', question }),
  }, 'AI помощникът не е достъпен в момента')).json();
```

- [ ] **Step 3: Replace the hardcoded FAQ block in `help-client.tsx` with the shared components**

In `delivery-web/src/components/help-client.tsx`:

1. Remove the local `Faq` component definition (lines 121-131) — it's replaced by `FaqAccordion` from `@fermeribg/help-ui`. `ChevronDown` (from `lucide-react`, imported on line 6) was only used inside this `Faq` component — remove it from that import line too, otherwise the unused import fails lint.
2. Add imports at the top, after the existing `lucide-react` import:

```typescript
import { DELIVERY_CATEGORIES, DELIVERY_FAQ, searchFaq } from '@fermeribg/help-content';
import { HelpSearchBar, CategoryChips, FaqAccordion, AskAiBox } from '@fermeribg/help-ui';
import { askHelpAi } from '@/lib/api-client';
```

3. Replace the existing FAQ `<Section>` block (lines 314-323, the one with `id="faq"` and the five hardcoded `<Faq q="...">` entries) with:

```tsx
        {/* ---------------------------------------------------------------- */}
        <Section id="faq" icon={Info} tone="bg-ff-green-50 text-ff-green-700" title="Често задавани въпроси">
          <FaqExplorer />
        </Section>
```

4. Add a new component in the same file, right after the existing `Faq`-block removal point (or just above `export function HelpClient()`):

```tsx
function FaqExplorer() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string[]>([]);
  const toggle = (id: string) =>
    setActive((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const results = searchFaq(DELIVERY_FAQ, query, active);

  return (
    <div className="flex flex-col gap-3">
      <HelpSearchBar value={query} onChange={setQuery} />
      <CategoryChips categories={DELIVERY_CATEGORIES} active={active} onToggle={toggle} />
      <FaqAccordion entries={results} />
      <AskAiBox onAsk={(q) => askHelpAi(q).then((r) => r.answer)} />
    </div>
  );
}
```

This file already has `'use client'` at the top and already imports `useState` from `react` — confirm the existing `import { useEffect, useRef, useState } from 'react';` line covers it (no new React import needed).

- [ ] **Step 4: Verify it builds**

Run: `pnpm --filter @fermeribg/delivery-web build`
Expected: build succeeds, no type errors.

- [ ] **Step 5: Manual check in dev server**

Run: `pnpm --filter @fermeribg/delivery-web dev`, open dostavki, navigate to „Помощ" (or `#faq` section). Confirm:
- All other walkthrough sections (overview, Econt, Speedy, import, handover, COD) are unchanged.
- The FAQ section now shows search + category chips + the full 32-entry list instead of the old 5 hardcoded questions.
- Search and category filtering work.
- Ask-AI box returns a grounded answer or the inline unavailable message.

- [ ] **Step 6: Commit**

```bash
git add delivery-web/package.json delivery-web/src/lib/api-client.ts delivery-web/src/components/help-client.tsx pnpm-lock.yaml
git commit -m "feat(delivery-web): replace hardcoded FAQ with searchable FAQ bank + AI Q&A"
```

---

## Task 7: Full workspace verification

**Files:** none (verification only)

- [ ] **Step 1: Full monorepo build**

Run: `pnpm build`
Expected: `turbo run build` succeeds for every package (`help-content`, `help-ui`, `db`, `types`, `server`, `client`, `delivery-web`, `admin`, `storefront`), respecting the `^build` dependency order.

- [ ] **Step 2: Full server test suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: PASS, including `HelpAiService` tests, no regressions in existing suites.

- [ ] **Step 3: help-content test suite**

Run: `pnpm --filter @fermeribg/help-content test`
Expected: PASS (content-integrity + search tests).

- [ ] **Step 4: Manual smoke test — both Help pages**

With `OPENAI_API_KEY` set in the server's local env, repeat the manual checks from Task 5 Step 5 and Task 6 Step 5 end-to-end (search, category filter, AI answer for a covered question, AI answer for an uncovered question, AI box behavior with the key unset).

- [ ] **Step 5: Final commit (only if any cleanup was needed)**

```bash
git add -A
git commit -m "chore: help hub refactor cleanup"
```

(Skip this step if Tasks 1-6 already left a clean working tree.)
