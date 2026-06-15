# Editable Site Copy — „Промени сайта" (Снимки + Текстове) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a farm edit its storefront body copy (and FAQ list) from the admin panel, by renaming the „Снимки на сайта" screen to „Промени сайта" with two tabs — Снимки (existing) + Текстове (new).

**Architecture:** Text slots mirror the existing media-slot system: a server `copy-slots.catalog.ts` contract + a generic `settings.copy` map + `settings.faq` array, exposed via `GET/PATCH tenants/me/site-copy`, projected onto the public storefront profile (so a warm render needs no extra read), and consumed by a chaika `<CopySlot>` wrapper whose inline `fallback` keeps the current text until a farm overrides it.

**Tech Stack:** NestJS + Drizzle (Postgres jsonb), Next.js admin client, Astro storefront (separate repo `../fermerski-pazar-chaika`), Jest.

**Repos / absolute paths:**
- FarmFlow API + admin: `C:\Users\Lenovo\source\repos\FarmFlow`
- Storefront (chaika): `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`

**Conventions to follow (from existing code):**
- Atomic per-path `jsonb_set` writes (never JS read-modify-write of the whole blob) — see `tenants.service.ts:259` (`setSiteMedia`) and `:399` (`updateMarketing`).
- Bust `publicCacheKeys.tenant(slug)` after every settings write.
- Owner-only: default-deny `TenantRolesGuard` makes a route `admin`-only unless `@Roles` opens it. New endpoints get explicit `@Roles('admin')`.
- chaika fallbacks: every dynamic field is optional so an older backend renders the static default with no error (see `Storefront.media?` in `types.ts`).
- Run jest / builds **sequentially** on this machine (parallel runs cause FS flakes — see project memory).

---

## File Structure

**Server (`C:\Users\Lenovo\source\repos\FarmFlow\server`):**
- Create `src/modules/tenants/copy-slots.catalog.ts` — catalog contract + per-theme slot list + helpers (mirrors `media-slots.catalog.ts`).
- Create `src/modules/tenants/site-copy.ts` — pure projection/cleaning helpers (`cleanCopy`, `buildPublicFaq`, `normalizeFaq`).
- Create `src/modules/tenants/dto/site-copy.dto.ts` — `SiteCopyDto` + `FaqItemDto`.
- Modify `src/modules/tenants/tenants.service.ts` — `getSiteCopy` / `setSiteCopy`; add `copy`/`faq` to `PublicStorefront`.
- Modify `src/modules/tenants/tenants.controller.ts` — `GET/PATCH me/site-copy`.
- Modify `src/common/cache/public-cache.service.ts` — derive `copy`/`faq` in `resolveTenant`, add to `TenantMeta`.
- Create `src/modules/tenants/copy-slots.catalog.spec.ts`, `src/modules/tenants/site-copy.spec.ts`, and add cases to the tenants service spec.

**Admin client (`C:\Users\Lenovo\source\repos\FarmFlow\client`):**
- Modify `src/lib/api-client.ts` — `getSiteCopy` / `updateSiteCopy` + types.
- Modify `src/app/(admin)/site-media/page.tsx` — tab shell + extract `MediaTab`, add `CopyTab`.
- Create `src/app/(admin)/site-media/copy-tab.tsx` — Текстове editor.
- Modify `src/components/layout/sidebar.tsx:115` + `src/components/layout/topbar.tsx:91` — rename label/title.
- Modify `src/app/(admin)/help/page.tsx` + help content — rename reference.

**Storefront (`C:\Users\Lenovo\source\repos\fermerski-pazar-chaika\src`):**
- Modify `lib/types.ts` — add `copy?` / `faq?` to `Storefront`.
- Modify `lib/api.ts:147` — add `copy: {}`, `faq: []` to `FALLBACK_STOREFRONT`.
- Create `components/CopySlot.astro`.
- Modify `pages/index.astro`, `pages/about.astro`, `pages/orders.astro`, `pages/contact.astro`, `pages/faq.astro`.

---

## Task 1: Server — copy-slots catalog

**Files:**
- Create: `server/src/modules/tenants/copy-slots.catalog.ts`
- Test: `server/src/modules/tenants/copy-slots.catalog.spec.ts`

This is the contract + source-of-truth default text for every editable body string. `default` values are copied **verbatim** from the current chaika markup (captured below). `multiline: true` → admin renders a textarea and the storefront renders with `white-space:pre-line`.

- [ ] **Step 1: Write the catalog file**

```ts
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
  { key: 'home.location.lead', label: 'Локация · текст', page: 'Начало', multiline: true, default: 'Намираш ни в кв. Чайка, Варна — на бул. „Ал. Стамболийски“, точно пред „Фратели“.' },
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
  { key: 'about.quote', label: 'Цитат', page: 'За нас', multiline: true, default: 'Не продаваме просто храна. Свързваме хората, които я отглеждат, с хората, които я ядат — лице в лице, всеки петък.”' },

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
```

- [ ] **Step 2: Write the spec**

```ts
// server/src/modules/tenants/copy-slots.catalog.spec.ts
import { getCopyCatalog, copySlotKeys, DEFAULT_SITE_THEME } from './copy-slots.catalog';

describe('copy-slots catalog', () => {
  it('returns the pazar catalog for default/unknown themes', () => {
    expect(getCopyCatalog().length).toBeGreaterThan(0);
    expect(getCopyCatalog('nope')).toBe(getCopyCatalog(DEFAULT_SITE_THEME));
  });
  it('has unique, non-empty keys and defaults', () => {
    const cat = getCopyCatalog();
    const keys = cat.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of cat) {
      expect(s.key).toMatch(/^[a-z0-9._]+$/);
      expect(s.default.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });
  it('copySlotKeys reflects the catalog', () => {
    expect(copySlotKeys().has('home.hero.title')).toBe(true);
    expect(copySlotKeys().has('not.a.key')).toBe(false);
  });
});
```

- [ ] **Step 3: Run the spec — expect PASS**

Run: `cd server; npx jest copy-slots.catalog --runInBand`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/tenants/copy-slots.catalog.ts server/src/modules/tenants/copy-slots.catalog.spec.ts
git commit -m "feat(tenants): copy-slots catalog (editable storefront text contract)"
```

---

## Task 2: Server — pure copy/faq helpers

**Files:**
- Create: `server/src/modules/tenants/site-copy.ts`
- Test: `server/src/modules/tenants/site-copy.spec.ts`

- [ ] **Step 1: Write helpers**

```ts
// server/src/modules/tenants/site-copy.ts
import { copySlotKeys } from './copy-slots.catalog';

export interface PublicFaqItem { q: string; a: string; }

/** Clean an incoming copy map: keep only known slot keys, trim, drop empties.
 *  (Empty/blank override = "use the storefront default", so it isn't stored.) */
export function cleanCopy(
  theme: string | null | undefined,
  raw: unknown,
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allowed = copySlotKeys(theme);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k)) continue;
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out[k] = t;
  }
  return out;
}

/** Project a stored copy map to its public shape (same cleaning, theme-aware). */
export function buildPublicCopy(
  theme: string | null | undefined,
  raw: unknown,
): Record<string, string> {
  return cleanCopy(theme, raw);
}

/** Normalize an incoming FAQ array: trim q/a, drop fully-empty rows, cap at 50. */
export function normalizeFaq(raw: unknown): PublicFaqItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicFaqItem[] = [];
  for (const row of raw.slice(0, 50)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const q = typeof r.q === 'string' ? r.q.trim() : '';
    const a = typeof r.a === 'string' ? r.a.trim() : '';
    if (!q && !a) continue;
    out.push({ q, a });
  }
  return out;
}

/** Project a stored FAQ array to its public shape (same normalization). */
export const buildPublicFaq = normalizeFaq;
```

- [ ] **Step 2: Write the spec**

```ts
// server/src/modules/tenants/site-copy.spec.ts
import { cleanCopy, normalizeFaq } from './site-copy';

describe('site-copy helpers', () => {
  it('cleanCopy keeps known keys, trims, drops empty + unknown', () => {
    const out = cleanCopy('pazar', {
      'home.hero.title': '  Ново заглавие  ',
      'home.hero.lead': '   ',
      'bogus.key': 'x',
      'home.twoways.title': 5,
    });
    expect(out).toEqual({ 'home.hero.title': 'Ново заглавие' });
  });
  it('cleanCopy returns {} for non-objects', () => {
    expect(cleanCopy('pazar', null)).toEqual({});
    expect(cleanCopy('pazar', ['a'])).toEqual({});
  });
  it('normalizeFaq trims, drops empty rows, caps at 50', () => {
    const out = normalizeFaq([
      { q: ' Q1 ', a: ' A1 ' },
      { q: '', a: '' },
      { q: 'Q2', a: '' },
      'garbage',
    ]);
    expect(out).toEqual([{ q: 'Q1', a: 'A1' }, { q: 'Q2', a: '' }]);
    expect(normalizeFaq(Array(60).fill({ q: 'x', a: 'y' })).length).toBe(50);
  });
});
```

- [ ] **Step 3: Run — expect PASS**

Run: `cd server; npx jest site-copy --runInBand`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/tenants/site-copy.ts server/src/modules/tenants/site-copy.spec.ts
git commit -m "feat(tenants): pure copy/faq cleaning helpers"
```

---

## Task 3: Server — DTO

**Files:**
- Create: `server/src/modules/tenants/dto/site-copy.dto.ts`

> NOTE the global-pipe gotcha (newsletter work): a nested array DTO MUST declare `@Type(() => …)` or `@ValidateNested` validates only shallowly. `copy` is a free-form `Record` typed `@IsObject()` — its values are NOT class-validated (the service's `cleanCopy` is authoritative); `forbidNonWhitelisted` does not inspect plain-object contents.

- [ ] **Step 1: Write the DTO**

```ts
// server/src/modules/tenants/dto/site-copy.dto.ts
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsObject, IsString, MaxLength, ValidateNested } from 'class-validator';

export class FaqItemDto {
  @IsString()
  @MaxLength(300)
  q: string;

  @IsString()
  @MaxLength(4000)
  a: string;
}

export class SiteCopyDto {
  /** slot key → override text. Validated server-side against the catalog (cleanCopy). */
  @IsObject()
  copy: Record<string, string>;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  faq: FaqItemDto[];
}
```

- [ ] **Step 2: Commit** (compiled/checked with Task 4's build)

```bash
git add server/src/modules/tenants/dto/site-copy.dto.ts
git commit -m "feat(tenants): SiteCopyDto for site-copy PATCH"
```

---

## Task 4: Server — service `getSiteCopy` / `setSiteCopy` + `PublicStorefront` fields

**Files:**
- Modify: `server/src/modules/tenants/tenants.service.ts`

- [ ] **Step 1: Add imports** (top of file, alongside the existing media/contact imports near line 30)

```ts
import { getCopyCatalog, type CopySlotDef } from './copy-slots.catalog';
import { buildPublicCopy, buildPublicFaq, cleanCopy, normalizeFaq, type PublicFaqItem } from './site-copy';
import { SiteCopyDto } from './dto/site-copy.dto';
```

- [ ] **Step 2: Add `copy` + `faq` to the `PublicStorefront` interface** (after the `marketing` field, before the closing `}` at line ~95)

```ts
  // Editable body copy (settings.copy) — slot key → override text. Empty/missing
  // slot → the storefront renders its inline default. Theme-cleaned.
  copy: Record<string, string>;
  // Editable FAQ list (settings.faq). Empty → storefront falls back to DEFAULT_FAQ.
  faq: PublicFaqItem[];
```

- [ ] **Step 3: Add the service methods** (immediately after `deleteSiteMedia`, before `// ---- Site contact` at line ~300)

```ts
  // ---- Site copy (editable storefront text + FAQ) ----

  /** Catalog + current overrides + FAQ list for the „Текстове" admin editor. */
  async getSiteCopy(tenantId: string): Promise<{
    catalog: CopySlotDef[];
    copy: Record<string, string>;
    faq: PublicFaqItem[];
  }> {
    const settings = await this.loadSettings(tenantId);
    const theme = this.themeOf(settings);
    return {
      catalog: getCopyCatalog(theme),
      copy: buildPublicCopy(theme, settings.copy),
      faq: buildPublicFaq(settings.faq),
    };
  }

  /** Replace settings.copy (cleaned against the catalog) and settings.faq in a
   *  single atomic write, then bust the cached public profile. */
  async setSiteCopy(
    tenantId: string,
    dto: SiteCopyDto,
  ): Promise<{ copy: Record<string, string>; faq: PublicFaqItem[] }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);
    const copy = cleanCopy(this.themeOf(settings), dto.copy);
    const faq = normalizeFaq(dto.faq);

    // One UPDATE writes both leaves so a crash can't persist one without the other.
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['copy'], ${JSON.stringify(copy)}::jsonb, true),
          array['faq'], ${JSON.stringify(faq)}::jsonb, true
        )`,
      })
      .where(eq(tenants.id, tenantId));

    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { copy, faq };
  }
```

- [ ] **Step 4: Run the build — expect PASS**

Run: `cd server; npx tsc --noEmit`
Expected: no errors. (If `PublicFaqItem` import is flagged unused in the interface position, it IS used — ignore false alarms; re-run after Task 5.)

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants/tenants.service.ts
git commit -m "feat(tenants): getSiteCopy/setSiteCopy service + storefront copy/faq fields"
```

---

## Task 5: Server — controller endpoints

**Files:**
- Modify: `server/src/modules/tenants/tenants.controller.ts`

- [ ] **Step 1: Import the DTO** (with the other dto imports near line 21)

```ts
import { SiteCopyDto } from './dto/site-copy.dto';
```

- [ ] **Step 2: Add the endpoints** (right after the `deleteMedia` handler, before `// ---- Site contact` at line ~79)

```ts
  // ---- Site copy (editable storefront text + FAQ) ----

  @ApiOperation({ summary: 'Editable text slots: catalog + current overrides + FAQ' })
  @Roles('admin')
  @Get('me/site-copy')
  getSiteCopy(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getSiteCopy(tenantId);
  }

  @ApiOperation({ summary: 'Replace storefront text overrides + FAQ list' })
  @Roles('admin')
  @Patch('me/site-copy')
  updateSiteCopy(@CurrentTenant() tenantId: string, @Body() dto: SiteCopyDto) {
    return this.tenantsService.setSiteCopy(tenantId, dto);
  }
```

- [ ] **Step 3: Build — expect PASS**

Run: `cd server; npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/tenants/tenants.controller.ts
git commit -m "feat(tenants): GET/PATCH me/site-copy (admin-only)"
```

---

## Task 6: Server — project `copy`/`faq` onto the public profile

**Files:**
- Modify: `server/src/common/cache/public-cache.service.ts`
- Test: add a case to `server/src/common/cache/public-cache.service.spec.ts` if it exists; otherwise put the assertion in the tenants service spec.

The storefront profile (`findPublicProfileBySlug`) spreads `TenantMeta`, so adding `copy`/`faq` to `TenantMeta` + `resolveTenant` makes them flow through automatically.

- [ ] **Step 1: Add imports** (with the other tenant helper imports near line 17-22)

```ts
import { buildPublicCopy, buildPublicFaq, type PublicFaqItem } from '../../modules/tenants/site-copy';
```

- [ ] **Step 2: Add fields to the `TenantMeta` interface** (after `marketing`, before the closing `}` at line ~88)

```ts
  // Editable body copy (settings.copy) + FAQ list (settings.faq). Derived here so
  // a warm storefront render needs no extra read. Empty → storefront defaults.
  copy: Record<string, string>;
  faq: PublicFaqItem[];
```

- [ ] **Step 3: Extend the `settingsObj` type + derive** (in `resolveTenant`, line ~172-209)

Add to the `settingsObj` inline type (after `marketing?: unknown;`):

```ts
          copy?: unknown;
          faq?: unknown;
          siteTheme?: unknown;
```

Add to the `meta` object (after `marketing: buildPublicMarketing(settingsObj?.marketing),`):

```ts
      copy: buildPublicCopy(
        typeof settingsObj?.siteTheme === 'string' ? settingsObj.siteTheme : undefined,
        settingsObj?.copy,
      ),
      faq: buildPublicFaq(settingsObj?.faq),
```

- [ ] **Step 4: Build — expect PASS**

Run: `cd server; npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Add a projection assertion** to the tenants service spec (`tenants.service.spec.ts` — find the existing `findPublicProfileBySlug` describe block; if the spec mocks `resolveTenant`, instead assert on `resolveTenant` in the cache spec). Minimal inline test:

```ts
// in the file that tests resolveTenant — assert copy/faq are derived + cleaned
it('derives cleaned copy + faq from settings', async () => {
  // arrange a tenant row whose settings = { siteTheme:'pazar',
  //   copy:{ 'home.hero.title':' Hi ', bogus:'x' }, faq:[{q:'Q',a:'A'},{q:'',a:''}] }
  // act: resolveTenant(db, slug)
  // assert: meta.copy === { 'home.hero.title':'Hi' }; meta.faq === [{q:'Q',a:'A'}]
});
```

Implement it against whatever mocking pattern the existing spec uses (mirror a sibling `media`/`contact` projection test in the same file). Run the suite:

Run: `cd server; npx jest public-cache --runInBand` (or the tenants service spec name)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/common/cache/public-cache.service.ts server/src/**/*.spec.ts
git commit -m "feat(public): project settings.copy + settings.faq onto storefront profile"
```

---

## Task 7: Server — full test + build gate

- [ ] **Step 1: Run the whole server suite**

Run: `cd server; npx jest --runInBand`
Expected: all suites pass (previous count + the new copy specs).

- [ ] **Step 2: Build db/types dist if stale, then server build**

Run: `cd packages/db; npm run build; cd ../types; npm run build; cd ../../server; npm run build`
Expected: clean builds. (Rebuild db/types dist first — server consumes them via dist.)

- [ ] **Step 3: Commit** (if any spec adjustments were needed) — otherwise skip.

---

## Task 8: Admin — api-client

**Files:**
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Add types + functions** (after the `deleteSiteMedia` block at line ~254, before `// ---- Site contact`)

```ts
// ---- Site copy (editable storefront text + FAQ) ----
export interface SiteCopySlotDef {
  key: string;
  label: string;
  page: string;
  default: string;
  multiline?: boolean;
}
export interface SiteFaqItem { q: string; a: string; }
export interface SiteCopyResponse {
  catalog: SiteCopySlotDef[];
  copy: Record<string, string>;
  faq: SiteFaqItem[];
}

export const getSiteCopy = () => apiFetch<SiteCopyResponse>('tenants/me/site-copy');

export const updateSiteCopy = (data: { copy: Record<string, string>; faq: SiteFaqItem[] }) =>
  apiFetch<{ copy: Record<string, string>; faq: SiteFaqItem[] }>(
    'tenants/me/site-copy',
    { method: 'PATCH', ...json(data) },
    'Неуспешно записване',
  );
```

- [ ] **Step 2: Typecheck — expect PASS**

Run: `cd client; npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(admin): site-copy api-client (getSiteCopy/updateSiteCopy)"
```

---

## Task 9: Admin — rename screen, add tab shell, extract MediaTab

**Files:**
- Modify: `client/src/components/layout/sidebar.tsx:115`
- Modify: `client/src/components/layout/topbar.tsx:91`
- Modify: `client/src/app/(admin)/site-media/page.tsx`

- [ ] **Step 1: Rename the sidebar entry** (`sidebar.tsx:115`)

Change:
```tsx
      { href: '/site-media', label: 'Снимки на сайта', Icon: ImageIcon, desc: 'Снимки за началната страница и секциите.' },
```
to:
```tsx
      { href: '/site-media', label: 'Промени сайта', Icon: ImageIcon, desc: 'Снимки и текстове на сайта — смени какво пише и какви снимки стоят.' },
```

- [ ] **Step 2: Rename the topbar title** (`topbar.tsx:91`)

Change `'/site-media': 'Снимки на сайта',` → `'/site-media': 'Промени сайта',`

- [ ] **Step 3: Refactor `page.tsx`** — extract the existing photo grid into a `MediaTab` component (same file) and add a tab switcher. Replace the whole `SiteMediaPage` component (the default export, line ~111-208) with:

```tsx
export default function SiteMediaPage() {
  const [tab, setTab] = useState<'media' | 'copy'>('media');

  return (
    <div className="max-w-[1100px]">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Промени сайта</h1>
        <p className="text-[13.5px] text-ff-muted">
          Смени снимките и текстовете на сайта. Текстовете под хедъра и над футъра — заглавия, описания и въпроси.
        </p>
      </div>

      <div className="mb-6 inline-flex rounded-full border border-ff-border bg-ff-surface p-1 shadow-ff-sm">
        {([['media', 'Снимки'], ['copy', 'Текстове']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-full px-5 py-1.5 text-[13.5px] font-semibold transition ${
              tab === key ? 'bg-ff-ink text-white' : 'text-ff-muted hover:text-ff-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'media' ? <MediaTab /> : <CopyTab />}
    </div>
  );
}
```

- [ ] **Step 4: Wrap the old body as `MediaTab`** — rename the old `SiteMediaPage` body (the loading/catalog/groups JSX + its `useState`/`useEffect`/`upload`/`remove`) into a new `function MediaTab()` in the same file, returning ONLY the inner content (drop the outer `max-w` wrapper + the old `<h1>`/`<p>` header, which now live in the shell). Keep `SlotCard` as-is.

- [ ] **Step 5: Add the import** at the top of `page.tsx`:

```tsx
import { CopyTab } from './copy-tab';
```

(CopyTab is created in Task 10. To compile this task in isolation, you may temporarily stub `export function CopyTab() { return null; }` in `copy-tab.tsx`, then implement it in Task 10.)

- [ ] **Step 6: Typecheck — expect PASS**

Run: `cd client; npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/layout/sidebar.tsx client/src/components/layout/topbar.tsx client/src/app/(admin)/site-media/page.tsx
git commit -m "feat(admin): rename screen to Промени сайта + Снимки/Текстове tabs"
```

---

## Task 10: Admin — CopyTab (text + FAQ editor)

**Files:**
- Create: `client/src/app/(admin)/site-media/copy-tab.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  getSiteCopy,
  updateSiteCopy,
  type SiteCopySlotDef,
  type SiteFaqItem,
} from '@/lib/api-client';

export function CopyTab() {
  const [catalog, setCatalog] = useState<SiteCopySlotDef[]>([]);
  const [copy, setCopy] = useState<Record<string, string>>({});
  const [faq, setFaq] = useState<SiteFaqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    getSiteCopy()
      .then((res) => {
        setCatalog(res.catalog);
        setCopy(res.copy);
        setFaq(res.faq);
      })
      .catch(() => toast.error('Неуспешно зареждане'))
      .finally(() => setLoading(false));
  }, []);

  // Group catalog by page, preserving order.
  const groups = useMemo(() => {
    const g: { page: string; slots: SiteCopySlotDef[] }[] = [];
    for (const slot of catalog) {
      let row = g.find((x) => x.page === slot.page);
      if (!row) { row = { page: slot.page, slots: [] }; g.push(row); }
      row.slots.push(slot);
    }
    return g;
  }, [catalog]);

  function setField(key: string, value: string) {
    setCopy((c) => ({ ...c, [key]: value }));
    setDirty(true);
  }
  function resetField(key: string) {
    setCopy((c) => { const n = { ...c }; delete n[key]; return n; });
    setDirty(true);
  }
  function setFaqItem(i: number, patch: Partial<SiteFaqItem>) {
    setFaq((f) => f.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
    setDirty(true);
  }
  function addFaq() { setFaq((f) => [...f, { q: '', a: '' }]); setDirty(true); }
  function removeFaq(i: number) { setFaq((f) => f.filter((_, idx) => idx !== i)); setDirty(true); }
  function moveFaq(i: number, dir: -1 | 1) {
    setFaq((f) => {
      const j = i + dir;
      if (j < 0 || j >= f.length) return f;
      const n = [...f];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      // Drop blank overrides (= use default) and fully-empty FAQ rows before sending.
      const cleanCopy: Record<string, string> = {};
      for (const [k, v] of Object.entries(copy)) if (v.trim()) cleanCopy[k] = v.trim();
      const cleanFaq = faq
        .map((f) => ({ q: f.q.trim(), a: f.a.trim() }))
        .filter((f) => f.q || f.a);
      const res = await updateSiteCopy({ copy: cleanCopy, faq: cleanFaq });
      setCopy(res.copy);
      setFaq(res.faq);
      setDirty(false);
      toast.success('Промените са запазени');
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-[14px] text-ff-muted">Зареждане…</p>;

  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.page}>
          <h2 className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2">
            {group.page}
          </h2>
          <div className="flex flex-col gap-4 rounded-2xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
            {group.slots.map((slot) => {
              const value = copy[slot.key] ?? '';
              const overridden = value.trim().length > 0;
              return (
                <div key={slot.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[13px] font-semibold text-ff-ink">{slot.label}</label>
                    {overridden && (
                      <button
                        type="button"
                        onClick={() => resetField(slot.key)}
                        className="flex items-center gap-1 text-[12px] text-ff-muted hover:text-ff-ink"
                        title="Върни оригиналния текст"
                      >
                        <RotateCcw size={12} /> Върни оригинала
                      </button>
                    )}
                  </div>
                  {slot.multiline ? (
                    <textarea
                      rows={3}
                      value={value}
                      placeholder={slot.default}
                      onChange={(e) => setField(slot.key, e.target.value)}
                      className="w-full resize-y rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2"
                    />
                  ) : (
                    <input
                      type="text"
                      value={value}
                      placeholder={slot.default}
                      onChange={(e) => setField(slot.key, e.target.value)}
                      className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2"
                    />
                  )}
                </div>
              );
            })}

            {/* FAQ page-group gets a list editor below its heading fields. */}
            {group.page === 'FAQ' && (
              <div className="mt-2 flex flex-col gap-3 border-t border-ff-border pt-4">
                <div className="text-[13px] font-semibold text-ff-ink">Въпроси и отговори</div>
                {faq.length === 0 && (
                  <p className="text-[13px] text-ff-muted">Няма въпроси. Добави първия.</p>
                )}
                {faq.map((item, i) => (
                  <div key={i} className="flex flex-col gap-2 rounded-sm border border-ff-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-ff-muted-2">Въпрос {i + 1}</span>
                      <div className="flex gap-1">
                        <button type="button" onClick={() => moveFaq(i, -1)} disabled={i === 0} title="Нагоре" className="p-1 text-ff-muted hover:text-ff-ink disabled:opacity-30"><ArrowUp size={14} /></button>
                        <button type="button" onClick={() => moveFaq(i, 1)} disabled={i === faq.length - 1} title="Надолу" className="p-1 text-ff-muted hover:text-ff-ink disabled:opacity-30"><ArrowDown size={14} /></button>
                        <button type="button" onClick={() => removeFaq(i)} title="Изтрий" className="p-1 text-ff-red hover:bg-ff-red/10 rounded-sm"><Trash2 size={14} /></button>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={item.q}
                      placeholder="Въпрос"
                      onChange={(e) => setFaqItem(i, { q: e.target.value })}
                      className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2"
                    />
                    <textarea
                      rows={2}
                      value={item.a}
                      placeholder="Отговор"
                      onChange={(e) => setFaqItem(i, { a: e.target.value })}
                      className="w-full resize-y rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2"
                    />
                  </div>
                ))}
                <Button variant="soft" type="button" onClick={addFaq} className="self-start gap-1.5 rounded-sm py-2 text-[13.5px]">
                  <Plus size={15} /> Добави въпрос
                </Button>
              </div>
            )}
          </div>
        </section>
      ))}

      <div className="sticky bottom-0 flex justify-end border-t border-ff-border bg-ff-bg/80 py-3 backdrop-blur">
        <Button type="button" disabled={!dirty || saving} onClick={save} className="rounded-sm px-6 py-2.5 text-[14px]">
          {saving ? 'Записване…' : 'Запази промените'}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck — expect PASS**

Run: `cd client; npx tsc --noEmit`
Expected: no errors. (If `Button` variant `"soft"`/class props differ, mirror the exact usage in `page.tsx`'s `SlotCard`.)

- [ ] **Step 3: Production build — expect PASS**

Run: `cd client; npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/app/(admin)/site-media/copy-tab.tsx
git commit -m "feat(admin): Текстове tab — per-page text fields + FAQ list editor"
```

---

## Task 11: Storefront — types, fallback, CopySlot component

**Files (chaika repo `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`):**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts:147`
- Create: `src/components/CopySlot.astro`

- [ ] **Step 1: Add `copy`/`faq` to the `Storefront` interface** (`types.ts`, after the `availabilityTitle?` field, before the closing `}` at line ~78)

```ts
  // Editable body copy (settings.copy) — slot key → override text. Optional (older
  // backend) → CopySlot renders its inline fallback. Empty value = use the default.
  copy?: Record<string, string>;
  // Editable FAQ list (settings.faq). Optional/empty → faq.astro uses DEFAULT_FAQ.
  faq?: { q: string; a: string }[];
```

- [ ] **Step 2: Add to `FALLBACK_STOREFRONT`** (`api.ts`, in the object at line ~147, after `marketing: {...}`)

```ts
  copy: {},
  faq: [],
```

- [ ] **Step 3: Create `CopySlot.astro`**

```astro
---
/**
 * Editable text slot. Renders the tenant override `copy[slot]` when non-empty,
 * otherwise the inline `fallback` (the original storefront text) — so the design
 * stays correct before the farm edits anything and on an older backend that
 * doesn't send `copy`. Managed in the FarmFlow admin → „Промени сайта → Текстове".
 *
 * `multiline` preserves the farmer's line breaks (white-space:pre-line). Without
 * it the component emits a bare text node, so it composes inside <h1>/<h2>/<p>.
 */
interface Props {
  slot: string;
  copy?: Record<string, string> | null;
  fallback: string;
  multiline?: boolean;
}
const { slot, copy, fallback, multiline = false } = Astro.props;
const raw = copy?.[slot];
const text = typeof raw === 'string' && raw.trim() ? raw : fallback;
---
{multiline ? <span style="white-space:pre-line">{text}</span> : <Fragment>{text}</Fragment>}
```

- [ ] **Step 4: Typecheck — expect PASS**

Run: `cd ../fermerski-pazar-chaika; npx astro check` (or `npx tsc --noEmit` if configured)
Expected: no new errors.

- [ ] **Step 5: Commit** (in the chaika repo)

```bash
cd ../fermerski-pazar-chaika
git add src/lib/types.ts src/lib/api.ts src/components/CopySlot.astro
git commit -m "feat: CopySlot wrapper + storefront copy/faq fields"
```

---

## Task 12: Storefront — wire index.astro (Начало)

**Files:** `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika\src\pages\index.astro`

**Rule:** replace each listed text node with `<CopySlot slot="<key>" copy={sf.copy} fallback="<exact current text>" [multiline] />`. The `fallback` MUST equal the current text verbatim (catalog `default` from Task 1). `sf` is already in scope. Add the import.

- [ ] **Step 1: Add the import** (with the other component imports at the top, after `import MediaSlot...`)

```astro
import CopySlot from '../components/CopySlot.astro';
```

- [ ] **Step 2: Worked examples (apply these patterns)**

Eyebrow (line 58):
```astro
<span class="eyebrow"><CopySlot slot="home.hero.eyebrow" copy={sf.copy} fallback="Фермерски пазар · кв. Чайка, Варна" /></span>
```
Heading (line 59):
```astro
<h1 style="margin-top:14px"><CopySlot slot="home.hero.title" copy={sf.copy} fallback="Свежа храна директно от фермерите" /></h1>
```
Multiline lead (lines 60-62 — collapse the inner text to one CopySlot):
```astro
<p class="lead" style="margin-top:20px;max-width:46ch"><CopySlot slot="home.hero.lead" copy={sf.copy} multiline fallback="Ела на живо всеки петък на Чайка или поръчай онлайн — плодове, мляко, мед, месо и домашни сладка с доставка до дома." /></p>
```
Value card (line 214 — replace the `<h3>` and `<p>` inner text only, keep the `<div class="ic">`):
```astro
<div class="card value-card"><div class="ic"><Icon name="heart" /></div><h3><CopySlot slot="home.how.s1.title" copy={sf.copy} fallback="1 · Избираш фермер" /></h3><p><CopySlot slot="home.how.s1.text" copy={sf.copy} multiline fallback="Всяко стопанство има профил със снимка, история и собствен асортимент." /></p></div>
```

- [ ] **Step 3: Apply to every Начало slot.** Replace the inner text of each element with its CopySlot (key → element/line → multiline?). Fallback text = the verbatim string already in the file.

| key | element (line) | multiline |
|---|---|---|
| home.hero.eyebrow | `.eyebrow` (58) | no |
| home.hero.title | `<h1>` (59) | no |
| home.hero.lead | `<p class="lead">` (60) | yes |
| home.twoways.eyebrow | `.eyebrow` (89) | no |
| home.twoways.title | `<h2>` (90) | no |
| home.pillar_market.title | `<h3>` (97) | no |
| home.pillar_market.text | `<p>` (98) | yes |
| home.pillar_delivery.title | `<h3>` (110) | no |
| home.pillar_delivery.text | `<p>` (111) | yes |
| home.categories.eyebrow | `.eyebrow` (129) | no |
| home.categories.title | `<h2>` (130) | no |
| home.farmers.eyebrow | `.eyebrow` (147) | no |
| home.farmers.title | `<h2>` (148) | no |
| home.latest.eyebrow | `.eyebrow` (167) | no |
| home.latest.title | `<h2>` (168) | no |
| home.reviews.eyebrow | `.eyebrow` (184) | no |
| home.reviews.title | `<h2>` (185) | no |
| home.how.eyebrow | `.eyebrow` (209) | no |
| home.how.title | `<h2>` (210) | no |
| home.how.text | `<p>` (211) | yes |
| home.how.s1.title / .text | card (214) | text=yes |
| home.how.s2.title / .text | card (215) | text=yes |
| home.how.s3.title / .text | card (216) | text=yes |
| home.location.eyebrow | `.eyebrow` (226) | no |
| home.location.title | `<h2>` (227) | no |
| home.location.lead | `<p class="lead">` (228) | yes |
| home.trust.1.title / .text | card (258) | text=yes |
| home.trust.2.title / .text | card (259) | text=yes |
| home.trust.3.title / .text | card (260) | text=yes |
| home.newsletter.title | `<h2>` (270) | no |
| home.newsletter.text | `<p>` (271) | yes |

(Lines are pre-edit references; they shift as you edit — match on the exact text, not the line number.)

- [ ] **Step 4: Build — expect PASS**

Run: `cd ../fermerski-pazar-chaika; npx astro build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: editable copy slots on Начало"
```

---

## Task 13: Storefront — wire about.astro (За нас)

**Files:** `src/pages/about.astro`

- [ ] **Step 1: Add the import** `import CopySlot from '../components/CopySlot.astro';`

- [ ] **Step 2: Apply CopySlot to each За нас slot** (fallback = verbatim current text).

| key | element | multiline |
|---|---|---|
| about.hero.eyebrow | `.eyebrow` (14) | no |
| about.hero.title | `<h1>` (15) — replace `Един пазар,<br>много местни<br>стопани` with `multiline` CopySlot fallback `"Един пазар,\nмного местни\nстопани"` | yes |
| about.hero.lead | `<p class="lead">` (16) — NOTE the live text starts with `{sf.name}`. Keep `{sf.name} ` and wrap the rest: `<p class="lead">{sf.name} <CopySlot slot="about.hero.lead" copy={sf.copy} multiline fallback="събира фермерите от региона на Варна на едно място — всеки петък на Чайка. Тук храната не минава през вериги и складове. Купуваш я директно от човека, който я е отгледал." /></p>` | yes |
| about.story.p1 | `<p>` (31) | yes |
| about.story.p2 | `<p>` (32) | yes |
| about.story.p3 | `<p>` (33) | yes |
| about.values.eyebrow | `.eyebrow` (40) | no |
| about.values.title | `<h2>` (41) | no |
| about.values.1.title / .text | card (44) | text=yes |
| about.values.2.title / .text | card (45) | text=yes |
| about.values.3.title / .text | card (46) | text=yes |
| about.values.4.title / .text | card (47) | text=yes |
| about.gallery.eyebrow | `.eyebrow` (55) | no |
| about.gallery.title | `<h2>` (56) | no |
| about.quote | `<p class="quote">` (72) — keep `— екипът на {sf.name}` line static | yes |

- [ ] **Step 3: Build — expect PASS**

Run: `cd ../fermerski-pazar-chaika; npx astro build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/pages/about.astro
git commit -m "feat: editable copy slots on За нас"
```

---

## Task 14: Storefront — wire orders.astro (Поръчки)

**Files:** `src/pages/orders.astro`

- [ ] **Step 1: Add the import.**

- [ ] **Step 2: Apply CopySlot to each Поръчки slot.**

| key | element (line) | multiline |
|---|---|---|
| orders.head.eyebrow | `.eyebrow` (17) | no |
| orders.head.title | `<h2>` (18) | no |
| orders.head.text | `<p>` (19) | yes |
| orders.pickup.title | `<h3>` (31) | no |
| orders.pickup.text | `<p>` (32) | yes |
| orders.delivery.title | `<h3>` (45) | no |
| orders.delivery.text | `<p>` (46) | yes |
| orders.steps.eyebrow | `.eyebrow` (62) | no |
| orders.steps.title | `<h2>` (63) | no |
| orders.steps.1.title / .text | card (66) | text=yes |
| orders.steps.2.title / .text | card (67) | text=yes |
| orders.steps.3.title / .text | card (68) | text=yes |
| orders.steps.4.title / .text | card (69) | text=yes |
| orders.know.eyebrow | `.eyebrow` (78) | no |
| orders.know.title | `<h2>` (79) | no |

- [ ] **Step 3: Build — expect PASS.** Run: `cd ../fermerski-pazar-chaika; npx astro build`

- [ ] **Step 4: Commit**

```bash
git add src/pages/orders.astro
git commit -m "feat: editable copy slots on Поръчки"
```

---

## Task 15: Storefront — wire contact.astro + faq.astro (Контакти + FAQ)

**Files:** `src/pages/contact.astro`, `src/pages/faq.astro`

- [ ] **Step 1: contact.astro — add the import + apply slots.**

| key | element (line) | multiline |
|---|---|---|
| contact.head.eyebrow | `.eyebrow` (25) | no |
| contact.head.title | `<h2>` (26) | no |
| contact.head.text | `<p>` (27) | yes |
| contact.form.title | `<h3>` (86) | no |
| contact.form.note | `<p class="muted">` (87) | no |

- [ ] **Step 2: faq.astro — heading slots + FAQ list fallback.**

Add `import CopySlot from '../components/CopySlot.astro';`. The page already does `const sf = (await getStorefront()) ?? FALLBACK_STOREFRONT;`.

Rename the existing hardcoded array `const FAQ = [...]` to `const DEFAULT_FAQ = [...]` and add below it:
```astro
const FAQ = sf.faq && sf.faq.length ? sf.faq : DEFAULT_FAQ;
```

Wrap the heading text:
```astro
<span class="eyebrow"><CopySlot slot="faq.head.eyebrow" copy={sf.copy} fallback="Често задавани въпроси" /></span>
<h2 style="margin-top:8px"><CopySlot slot="faq.head.title" copy={sf.copy} fallback="Каквото обикновено ни питат" /></h2>
```

(The `{FAQ.map(...)}` block already renders `f.q`/`f.a` — no change needed there.)

- [ ] **Step 3: Build — expect PASS.** Run: `cd ../fermerski-pazar-chaika; npx astro build`

- [ ] **Step 4: Commit**

```bash
git add src/pages/contact.astro src/pages/faq.astro
git commit -m "feat: editable copy on Контакти + editable FAQ list"
```

---

## Task 16: Docs — admin guide + in-app help

**Files (FarmFlow repo):**
- Modify: `docs/admin-panel-guide.md`
- Modify: `client/src/app/(admin)/help/page.tsx` + any `help-content.ts`

- [ ] **Step 1: Find current references**

Run: `cd C:/Users/Lenovo/source/repos/FarmFlow; npx --yes rg -n "Снимки на сайта|/site-media" docs client/src`
Expected: lists the doc + help references.

- [ ] **Step 2: Update each reference** — rename „Снимки на сайта" → „Промени сайта" and add one line that the screen now has two tabs (Снимки + Текстове), and that Текстове edits body headings/paragraphs + the FAQ list, while header/footer + contact details stay in their own screens.

- [ ] **Step 3: Commit**

```bash
git add docs/admin-panel-guide.md client/src/app/\(admin\)/help/page.tsx
git commit -m "docs: rename to Промени сайта + document Текстове tab"
```

---

## Task 17: Full verification gate + live E2E

- [ ] **Step 1: Server suite + builds (sequential)**

Run: `cd server; npx jest --runInBand` → all pass.
Run: `cd packages/db; npm run build; cd ../types; npm run build; cd ../../server; npm run build` → clean.

- [ ] **Step 2: Admin typecheck + build**

Run: `cd client; npx tsc --noEmit; npm run build` → clean.

- [ ] **Step 3: chaika build**

Run: `cd ../fermerski-pazar-chaika; npx astro build` → clean.

- [ ] **Step 4: Live E2E** (start API on :3001 with db/types dist built — `node dist/main.js`, NOT `nest --watch`; start admin + chaika dev). Verify:
  - Admin → „Промени сайта": both tabs render; Снимки unchanged.
  - Текстове: edit `home.hero.title` (e.g. "Тест заглавие"), add an FAQ item, click „Запази промените" → success toast.
  - Storefront `/` shows the new hero title; `/faq` shows the new question. Network/`GET bootstrap` (or `GET public/:slug`) includes `copy`/`faq`.
  - Clear the hero override (Върни оригинала) + save → storefront reverts to the default text.
  - Confirm zero console errors on the storefront pages.

- [ ] **Step 5: Final commit** (if any fixes) and report results with command output.

---

## Self-Review notes (for the executor)

- **Cyrillic exact-match:** chaika `Edit` calls must match the source text byte-for-byte (typographic quotes „ " “ ”, the `·` middot, `—` em-dash, non-breaking spaces). If an Edit fails to match, Read the exact line first.
- **Don't double-wrap dynamic bits:** in `about.hero.lead`, `about.quote`, `contact` phone/email cards, keep the `{sf.*}` expressions outside the CopySlot.
- **Migration:** none — `settings.copy` / `settings.faq` are new jsonb leaves; existing rows simply lack them and fall back. No 00XX migration file.
- **Theme:** only `pazar` exists; `getCopyCatalog`/`buildPublicCopy` are theme-aware for future themes.
