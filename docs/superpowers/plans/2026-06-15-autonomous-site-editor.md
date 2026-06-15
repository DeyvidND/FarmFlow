# Autonomous Unified Site Editor (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One autonomous „Промени сайта" editor: the storefront declares all editable text+photo slots (per page→section) in a manifest; the admin renders a single section-structured editor from it with a live iframe preview that scrolls/outlines the focused section; the server just stores per-tenant overrides and is slot-agnostic.

**Architecture:** Source of truth for *what is editable* moves to the storefront (`editable-manifest.ts` registry → JSON endpoint). `<CopySlot>`/`<MediaSlot>` read their default/label/ratio from the registry and emit `data-editable-slot` + section anchors. The FarmFlow server deletes its hardcoded catalogs, validates override keys by pattern only, and adds `settings.siteUrl`. The admin fetches the manifest client-side and renders the unified editor + drives the iframe via origin-checked `postMessage`.

**Tech Stack:** Astro storefront (`../fermerski-pazar-chaika`), NestJS + Drizzle (FarmFlow `server`), Next.js admin (`client`), Jest.

**Repos (absolute):**
- FarmFlow: `C:\Users\Lenovo\source\repos\FarmFlow` (branch `feat/autonomous-site-editor` is checked out)
- chaika: `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika` (create branch `feat/autonomous-site-editor`)

**Spec:** `docs/superpowers/specs/2026-06-15-autonomous-site-editor-design.md`. **Supersedes** v1 (`b01e27c`); slot keys preserved → existing `settings.copy`/`settings.media` overrides stay valid; no DB migration.

**Conventions / gotchas (from this codebase):**
- Atomic per-path `jsonb_set`; bust `publicCacheKeys.tenant(slug)` after writes.
- Global `ValidationPipe` is `whitelist + forbidNonWhitelisted`; nested array DTOs need `@Type(() => …)`.
- Run jest / builds **sequentially** on this machine (parallel = FS flakes).
- chaika uses `pnpm`? No — chaika is Astro (npm/`astro build`); FarmFlow is `pnpm` workspace for server/client. Use the command shown in each step.
- Cyrillic exact-match: when relocating defaults, copy byte-for-byte (typographic „ " “ ”, `·`, `—`, `→`, `\n`).
- Windows/PowerShell: chain with `;` (or use the Bash tool). Quote paths with `(admin)`.

**The v1 data sources to relocate (exact defaults/labels already committed):**
- `server/src/modules/tenants/copy-slots.catalog.ts` — 82 text slots `{key,label,page,default,multiline}`.
- `server/src/modules/tenants/media-slots.catalog.ts` — 12 image slots `{key,label,ratio,page,note,rounded}`.

---

## File Structure

**chaika (`src/`):**
- Create `lib/editable-manifest.ts` — the registry (pages→sections→slots, text+image) + `SLOTS` flat lookup + types. **Single source of truth.**
- Create `pages/editable-manifest.json.ts` — Astro endpoint serving the manifest (CORS for admin origin).
- Modify `components/CopySlot.astro` — registry-driven (drop `fallback`/`multiline` props).
- Modify `components/MediaSlot.astro` — registry-driven (drop `label`/`ratio`/`rounded` props; keep `priority`/`klass`).
- Modify `pages/{index,about,orders,contact,faq}.astro` — strip the now-redundant props from CopySlot/MediaSlot; add `data-copy-section` to section containers.
- Modify `middleware.ts` — preview-mode framing relaxation + `no-store`.
- Modify `components/Layout.astro` — inject the preview listener script when `?preview=1`.
- Modify `lib/types.ts` — (unchanged shape; `copy`/`faq` already present from v1).

**FarmFlow server (`server/src/`):**
- Delete `modules/tenants/copy-slots.catalog.ts` (+ `.spec.ts`) and `modules/tenants/media-slots.catalog.ts`.
- Modify `modules/tenants/site-copy.ts` — `cleanCopy(raw)` (no catalog), add `sanitizeSiteUrl`, `SLOT_KEY_RE`.
- Modify `modules/tenants/dto/site-copy.dto.ts` — add `siteUrl`.
- Modify `modules/tenants/tenants.service.ts` — reshape `getSiteCopy`; `setSiteCopy` writes siteUrl; `setSiteMedia`/`deleteSiteMedia` pattern-validate; drop catalog imports/`getSiteMedia` GET method usage.
- Modify `modules/tenants/tenants.controller.ts` — remove `GET me/media`; keep upload/delete; `getSiteCopy` shape.
- Modify `common/cache/public-cache.service.ts` — unchanged projection (copy/faq/media stay); confirm no catalog import.
- Modify/replace specs: `site-copy.spec.ts`, delete catalog specs, adjust any tenants service spec referencing the catalog.

**Admin (`client/src/`):**
- Modify `lib/api-client.ts` — `getSiteCopy` → `{copy,media,faq,siteUrl}`; `updateSiteCopy({copy,faq,siteUrl})`; `getEditableManifest(siteUrl)`; manifest types; drop `getSiteMedia`/`SiteMediaResponse`.
- Replace `app/(admin)/site-media/page.tsx` — unified manifest-driven editor shell.
- Create `app/(admin)/site-media/site-editor.tsx` — the editor tree (text+image slots + FAQ) + save.
- Create `app/(admin)/site-media/preview-pane.tsx` — iframe + focus→postMessage + responsive toggle + siteUrl input.
- Delete `app/(admin)/site-media/copy-tab.tsx` (folded into site-editor).
- Modify `components/layout/sidebar.tsx` / `topbar.tsx` — label already „Промени сайта" (v1); leave as-is.

---

## Task 1: chaika — editable-manifest registry (single source of truth)

**Files:**
- Create: `../fermerski-pazar-chaika/src/lib/editable-manifest.ts`

This holds EVERY editable slot. Relocate the data from the FarmFlow v1 catalogs (`copy-slots.catalog.ts` = text defaults/labels, `media-slots.catalog.ts` = image labels/ratios) — open both, copy each `default`/`label`/`ratio`/`multiline`/`rounded` **verbatim**, keeping the exact `key`s. Group into the section tree below.

- [ ] **Step 1: Create the file with types + the full registry**

```ts
// src/lib/editable-manifest.ts
/**
 * Single source of truth for what is editable on this storefront. The admin
 * „Промени сайта" panel reads the serialized form (editable-manifest.json) and
 * renders its editor from it; CopySlot/MediaSlot read defaults/labels from here.
 * Add a slot = add it to a section below + drop <CopySlot slot="…"/> /
 * <MediaSlot slot="…"/> into the markup. Add a page = add a Page entry + wrap
 * its sections with data-copy-section. Slot keys must match the stored override
 * keys (settings.copy / settings.media) — never rename a shipped key.
 */
export interface TextSlot { kind: 'text'; key: string; label: string; default: string; multiline?: boolean }
export interface ImageSlot { kind: 'image'; key: string; label: string; ratio: string; rounded?: boolean; note?: string }
export type Slot = TextSlot | ImageSlot;
export interface Section { id: string; label: string; slots: Slot[] }
export interface Page { route: string; label: string; sections: Section[]; faq?: boolean }
export interface EditableManifest { theme: string; pages: Page[] }

export const MANIFEST: EditableManifest = {
  theme: 'pazar',
  pages: [
    {
      route: '/', label: 'Начало',
      sections: [
        { id: 'home.hero', label: 'Hero', slots: [
          { kind: 'text', key: 'home.hero.eyebrow', label: 'Надпис отгоре', default: 'Фермерски пазар · кв. Чайка, Варна' },
          { kind: 'text', key: 'home.hero.title', label: 'Заглавие', default: 'Свежа храна директно от фермерите' },
          { kind: 'text', key: 'home.hero.lead', label: 'Текст', multiline: true, default: 'Ела на живо всеки петък на Чайка или поръчай онлайн — плодове, мляко, мед, месо и домашни сладка с доставка до дома.' },
          { kind: 'image', key: 'home.hero', label: 'Главна снимка (hero)', ratio: '4/5', rounded: true },
        ]},
        { id: 'home.twoways', label: 'Два начина да пазаруваш', slots: [
          { kind: 'text', key: 'home.twoways.eyebrow', label: 'Надпис', default: 'Два начина да пазаруваш' },
          { kind: 'text', key: 'home.twoways.title', label: 'Заглавие', default: 'На пазара или онлайн — ти избираш' },
          { kind: 'text', key: 'home.pillar_market.title', label: 'Стълб „Пазар" · заглавие', default: 'Пазар на място' },
          { kind: 'text', key: 'home.pillar_market.text', label: 'Стълб „Пазар" · текст', multiline: true, default: 'Всеки петък фермерите се събират на Чайка. Опитай, разгледай и вземи директно от стопанина — без посредник.' },
          { kind: 'image', key: 'site.pillar_market', label: '„Пазар на място“ · щандове', ratio: '16/10', note: 'Показва се и на „Поръчки"' },
          { kind: 'text', key: 'home.pillar_delivery.title', label: 'Стълб „Доставка" · заглавие', default: 'Доставка до дома' },
          { kind: 'text', key: 'home.pillar_delivery.text', label: 'Стълб „Доставка" · текст', multiline: true, default: 'Запази продукти от сайта и ги получи удобно вкъщи. Поръчай онлайн, а ние ги доставяме свежи в петък.' },
          { kind: 'image', key: 'site.pillar_delivery', label: '„Доставка до дома“ · кашон', ratio: '16/10', note: 'Показва се и на „Поръчки"' },
        ]},
        { id: 'home.categories', label: 'Категории', slots: [
          { kind: 'text', key: 'home.categories.eyebrow', label: 'Надпис', default: 'Пазарувай по категория' },
          { kind: 'text', key: 'home.categories.title', label: 'Заглавие', default: 'Какво ще намериш' },
        ]},
        { id: 'home.farmers', label: 'Фермери', slots: [
          { kind: 'text', key: 'home.farmers.eyebrow', label: 'Надпис', default: 'Хора зад щандовете' },
          { kind: 'text', key: 'home.farmers.title', label: 'Заглавие', default: 'Запознай се с фермерите' },
        ]},
        { id: 'home.latest', label: 'Предложения', slots: [
          { kind: 'text', key: 'home.latest.eyebrow', label: 'Надпис', default: 'Свежо този петък' },
          { kind: 'text', key: 'home.latest.title', label: 'Заглавие', default: 'Най-актуални предложения' },
        ]},
        { id: 'home.reviews', label: 'Отзиви', slots: [
          { kind: 'text', key: 'home.reviews.eyebrow', label: 'Надпис', default: 'Отзиви' },
          { kind: 'text', key: 'home.reviews.title', label: 'Заглавие', default: 'Какво казват клиентите' },
        ]},
        { id: 'home.how', label: 'Как е подреден магазинът', slots: [
          { kind: 'text', key: 'home.how.eyebrow', label: 'Надпис', default: 'Как е подреден магазинът' },
          { kind: 'text', key: 'home.how.title', label: 'Заглавие', default: 'Фермер → категория → продукт' },
          { kind: 'text', key: 'home.how.text', label: 'Текст', multiline: true, default: 'Всеки продукт идва от конкретен фермер и е подреден в категория. Така знаеш точно кой стопанин стои зад храната ти.' },
          { kind: 'text', key: 'home.how.s1.title', label: 'Стъпка 1 · заглавие', default: '1 · Избираш фермер' },
          { kind: 'text', key: 'home.how.s1.text', label: 'Стъпка 1 · текст', multiline: true, default: 'Всяко стопанство има профил със снимка, история и собствен асортимент.' },
          { kind: 'text', key: 'home.how.s2.title', label: 'Стъпка 2 · заглавие', default: '2 · Разглеждаш категориите' },
          { kind: 'text', key: 'home.how.s2.text', label: 'Стъпка 2 · текст', multiline: true, default: 'Продуктите на фермера са групирани по категории — плодове, мляко, мед, месо, сладка.' },
          { kind: 'text', key: 'home.how.s3.title', label: 'Стъпка 3 · заглавие', default: '3 · Поръчваш продукта' },
          { kind: 'text', key: 'home.how.s3.text', label: 'Стъпка 3 · текст', multiline: true, default: 'Добавяш в количката директно от категорията или запазваш за петъчния пазар.' },
        ]},
        { id: 'home.location', label: 'Локация', slots: [
          { kind: 'text', key: 'home.location.eyebrow', label: 'Надпис', default: 'Локация' },
          { kind: 'text', key: 'home.location.title', label: 'Заглавие', default: 'Фермерски пазар — Чайка' },
          { kind: 'text', key: 'home.location.lead', label: 'Текст', multiline: true, default: 'Намираш ни в кв. Чайка, Варна — на бул. „Ал. Стамболийски“, точно пред „Фратели“.' },
        ]},
        { id: 'home.trust', label: 'Доверие', slots: [
          { kind: 'text', key: 'home.trust.1.title', label: 'Карта 1 · заглавие', default: 'Местно и сезонно' },
          { kind: 'text', key: 'home.trust.1.text', label: 'Карта 1 · текст', multiline: true, default: 'Всичко идва от ферми в региона на Варна — толкова свежо, колкото изобщо е възможно.' },
          { kind: 'text', key: 'home.trust.2.title', label: 'Карта 2 · заглавие', default: 'Директно от фермера' },
          { kind: 'text', key: 'home.trust.2.text', label: 'Карта 2 · текст', multiline: true, default: 'Без вериги и без посредник. Парите отиват при стопанина, който е отгледал продукта.' },
          { kind: 'text', key: 'home.trust.3.title', label: 'Карта 3 · заглавие', default: 'Познаваме си хората' },
          { kind: 'text', key: 'home.trust.3.text', label: 'Карта 3 · текст', multiline: true, default: 'Малка общност от стопани и клиенти, които се срещат всеки петък на Чайка.' },
        ]},
        { id: 'home.newsletter', label: 'Бюлетин', slots: [
          { kind: 'text', key: 'home.newsletter.title', label: 'Заглавие', default: 'Какво има на пазара тази седмица?' },
          { kind: 'text', key: 'home.newsletter.text', label: 'Текст', multiline: true, default: 'Абонирай се и получавай в четвъртък какво носят фермерите в петък. Без спам.' },
        ]},
      ],
    },
    {
      route: '/about', label: 'За нас',
      sections: [
        { id: 'about.hero', label: 'Hero', slots: [
          { kind: 'text', key: 'about.hero.eyebrow', label: 'Надпис', default: 'За нас' },
          { kind: 'text', key: 'about.hero.title', label: 'Заглавие', multiline: true, default: 'Един пазар,\nмного местни\nстопани' },
          { kind: 'text', key: 'about.hero.lead', label: 'Текст', multiline: true, default: 'събира фермерите от региона на Варна на едно място — всеки петък на Чайка. Тук храната не минава през вериги и складове. Купуваш я директно от човека, който я е отгледал.' },
          { kind: 'image', key: 'about.portrait', label: 'Портрет (пазарът на Чайка)', ratio: '4/5', rounded: true },
        ]},
        { id: 'about.story', label: 'История', slots: [
          { kind: 'text', key: 'about.story.p1', label: 'Параграф 1', multiline: true, default: 'Започнахме като малка сбирка от няколко съседни стопанства, които искаха да продават директно на хората — без посредник, без етикети, които никой не разбира. Първите петъци на Чайка бяхме шепа маси и кошници. Хората се връщаха. После водеха приятели.' },
          { kind: 'text', key: 'about.story.p2', label: 'Параграф 2', multiline: true, default: 'Днес на пазара се събират фермери с плодове и зеленчуци, мляко и сирене, мед, месо и домашни сладка. Различни стопанства, но един и същ принцип — местно, сезонно и честно. Каквото е узряло тази седмица, това носим.' },
          { kind: 'text', key: 'about.story.p3', label: 'Параграф 3', multiline: true, default: 'Сайтът добавихме, за да е по-лесно: разглеждаш фермерите и продуктите им предварително, запазваш онлайн и идваш да вземеш — или избираш доставка до дома. Така пазарът работи и през останалите дни от седмицата.' },
        ]},
        { id: 'about.values', label: 'Ценности', slots: [
          { kind: 'text', key: 'about.values.eyebrow', label: 'Надпис', default: 'Нашите ценности' },
          { kind: 'text', key: 'about.values.title', label: 'Заглавие', default: 'В какво вярваме' },
          { kind: 'text', key: 'about.values.1.title', label: 'Карта 1 · заглавие', default: 'Местно и сезонно' },
          { kind: 'text', key: 'about.values.1.text', label: 'Карта 1 · текст', multiline: true, default: 'Продукти от региона на Варна — толкова свежи, колкото е възможно.' },
          { kind: 'text', key: 'about.values.2.title', label: 'Карта 2 · заглавие', default: 'Директно от фермера' },
          { kind: 'text', key: 'about.values.2.text', label: 'Карта 2 · текст', multiline: true, default: 'Без вериги и посредници — парите отиват при стопанина.' },
          { kind: 'text', key: 'about.values.3.title', label: 'Карта 3 · заглавие', default: 'Общност' },
          { kind: 'text', key: 'about.values.3.text', label: 'Карта 3 · текст', multiline: true, default: 'Познаваме си хората — стопани и клиенти, които се срещат всеки петък.' },
          { kind: 'text', key: 'about.values.4.title', label: 'Карта 4 · заглавие', default: 'Честно и ясно' },
          { kind: 'text', key: 'about.values.4.text', label: 'Карта 4 · текст', multiline: true, default: 'Знаеш кой, къде и как е произвел това, което купуваш.' },
        ]},
        { id: 'about.gallery', label: 'Галерия', slots: [
          { kind: 'text', key: 'about.gallery.eyebrow', label: 'Надпис', default: 'От пазара' },
          { kind: 'text', key: 'about.gallery.title', label: 'Заглавие', default: 'Един петък на Чайка' },
          { kind: 'image', key: 'about.gallery_stalls', label: 'Щандовете на пазара', ratio: '2/1' },
          { kind: 'image', key: 'about.gallery_basket', label: 'Кошница с плодове', ratio: '1/1' },
          { kind: 'image', key: 'about.gallery_honey', label: 'Буркани с мед', ratio: '1/2' },
          { kind: 'image', key: 'about.gallery_dairy', label: 'Сирене и мляко', ratio: '1/1' },
          { kind: 'image', key: 'about.gallery_farmer', label: 'Фермер на щанда', ratio: '1/1' },
          { kind: 'image', key: 'about.gallery_sweets', label: 'Домашни сладка', ratio: '1/1' },
          { kind: 'image', key: 'about.gallery_customers', label: 'Клиенти на пазара', ratio: '1/1' },
        ]},
        { id: 'about.quote', label: 'Цитат', slots: [
          { kind: 'text', key: 'about.quote', label: 'Цитат', multiline: true, default: 'Не продаваме просто храна. Свързваме хората, които я отглеждат, с хората, които я ядат — лице в лице, всеки петък.”' },
        ]},
      ],
    },
    {
      route: '/orders', label: 'Поръчки',
      sections: [
        { id: 'orders.head', label: 'Заглавна', slots: [
          { kind: 'text', key: 'orders.head.eyebrow', label: 'Надпис', default: 'Поръчки' },
          { kind: 'text', key: 'orders.head.title', label: 'Заглавие', default: 'Как стига храната до теб' },
          { kind: 'text', key: 'orders.head.text', label: 'Текст', multiline: true, default: 'Два начина да вземеш продуктите от фермерите — ела на пазара на Чайка всеки петък, или запази онлайн и получи доставка до дома. Ти избираш.' },
        ]},
        { id: 'orders.pickup', label: 'Вземане от пазара', slots: [
          { kind: 'text', key: 'orders.pickup.title', label: 'Заглавие', default: 'Вземане от пазара' },
          { kind: 'text', key: 'orders.pickup.text', label: 'Текст', multiline: true, default: 'Запази продуктите си онлайн и ги вземи лично в петък от щандовете на Чайка — без такса за доставка.' },
        ]},
        { id: 'orders.delivery', label: 'Доставка до адрес', slots: [
          { kind: 'text', key: 'orders.delivery.title', label: 'Заглавие', default: 'Доставка до адрес' },
          { kind: 'text', key: 'orders.delivery.text', label: 'Текст', multiline: true, default: 'Поръчай онлайн и получи свежите продукти удобно вкъщи в петък между 11:00 и 20:00 ч.' },
        ]},
        { id: 'orders.steps', label: 'Стъпки', slots: [
          { kind: 'text', key: 'orders.steps.eyebrow', label: 'Надпис', default: 'Стъпка по стъпка' },
          { kind: 'text', key: 'orders.steps.title', label: 'Заглавие', default: 'Поръчката за 4 стъпки' },
          { kind: 'text', key: 'orders.steps.1.title', label: 'Стъпка 1 · заглавие', default: '1 · Разгледай' },
          { kind: 'text', key: 'orders.steps.1.text', label: 'Стъпка 1 · текст', multiline: true, default: 'Избери фермер или категория и виж какво е свежо тази седмица.' },
          { kind: 'text', key: 'orders.steps.2.title', label: 'Стъпка 2 · заглавие', default: '2 · Добави' },
          { kind: 'text', key: 'orders.steps.2.text', label: 'Стъпка 2 · текст', multiline: true, default: 'Сложи продуктите в количката и избери количество.' },
          { kind: 'text', key: 'orders.steps.3.title', label: 'Стъпка 3 · заглавие', default: '3 · Избери начин' },
          { kind: 'text', key: 'orders.steps.3.text', label: 'Стъпка 3 · текст', multiline: true, default: 'Вземане от пазара на Чайка или доставка до адрес.' },
          { kind: 'text', key: 'orders.steps.4.title', label: 'Стъпка 4 · заглавие', default: '4 · Готово' },
          { kind: 'text', key: 'orders.steps.4.text', label: 'Стъпка 4 · текст', multiline: true, default: 'Потвърждаваме поръчката и я приготвяме за петък.' },
        ]},
        { id: 'orders.know', label: 'Добре е да знаеш', slots: [
          { kind: 'text', key: 'orders.know.eyebrow', label: 'Надпис', default: 'Доставка и плащане' },
          { kind: 'text', key: 'orders.know.title', label: 'Заглавие', default: 'Добре е да знаеш' },
          { kind: 'image', key: 'orders.box', label: 'Кашон с поръчка', ratio: '4/3', rounded: true },
        ]},
      ],
    },
    {
      route: '/contact', label: 'Контакти',
      sections: [
        { id: 'contact.head', label: 'Заглавна', slots: [
          { kind: 'text', key: 'contact.head.eyebrow', label: 'Надпис', default: 'Контакти' },
          { kind: 'text', key: 'contact.head.title', label: 'Заглавие', default: 'Ще се радваме да чуем' },
          { kind: 'text', key: 'contact.head.text', label: 'Текст', multiline: true, default: 'Въпрос за поръчка, продукт от пазара или просто здравей — пиши ни по който начин ти е удобен. Ще се радваме да те видим и на живо в петък на Чайка.' },
        ]},
        { id: 'contact.form', label: 'Форма', slots: [
          { kind: 'text', key: 'contact.form.title', label: 'Заглавие', default: 'Изпрати съобщение' },
          { kind: 'text', key: 'contact.form.note', label: 'Бележка', default: 'Отговаряме в рамките на работния ден.' },
        ]},
      ],
    },
    {
      route: '/faq', label: 'FAQ', faq: true,
      sections: [
        { id: 'faq.head', label: 'Заглавна', slots: [
          { kind: 'text', key: 'faq.head.eyebrow', label: 'Надпис', default: 'Често задавани въпроси' },
          { kind: 'text', key: 'faq.head.title', label: 'Заглавие', default: 'Каквото обикновено ни питат' },
        ]},
      ],
    },
  ],
};

/** Flat key → slot lookup, derived once. */
export const SLOTS: Record<string, Slot> = Object.fromEntries(
  MANIFEST.pages.flatMap((p) => p.sections.flatMap((s) => s.slots.map((sl) => [sl.key, sl] as const))),
);

/** Section id for a slot key (for data-copy-section / preview scroll). */
export const SECTION_OF: Record<string, string> = Object.fromEntries(
  MANIFEST.pages.flatMap((p) => p.sections.flatMap((s) => s.slots.map((sl) => [sl.key, s.id] as const))),
);
```

- [ ] **Step 2: Verify it parses + every v1 key is present**

Create a temp check (then delete it): in chaika run `npx tsx -e "import('./src/lib/editable-manifest.ts').then(m=>{const keys=Object.keys(m.SLOTS); console.log('slots',keys.length); console.log('hasHero', !!m.SLOTS['home.hero.title'], !!m.SLOTS['home.hero']);})"` — expect `slots 94` (82 text + 12 image), `hasHero true true`. If `tsx` unavailable, instead `npx astro check` (Step in Task 3 will compile it). Cross-check the 94 keys against the two FarmFlow catalog files (82 + 12).

- [ ] **Step 3: Commit**

```bash
cd ../fermerski-pazar-chaika && git switch -c feat/autonomous-site-editor 2>/dev/null || git switch feat/autonomous-site-editor
git add src/lib/editable-manifest.ts
git commit -m "feat: editable-manifest registry (single source for editable slots)"
```

---

## Task 2: chaika — manifest JSON endpoint (CORS)

**Files:**
- Create: `../fermerski-pazar-chaika/src/pages/editable-manifest.json.ts`

- [ ] **Step 1: Create the endpoint**

```ts
// src/pages/editable-manifest.json.ts
import type { APIRoute } from 'astro';
import { MANIFEST } from '../lib/editable-manifest';

// The admin panel (cross-origin) fetches this to render the editor. Public data
// (labels/defaults only, no secrets). CORS limited to the configured admin URL.
const ADMIN = import.meta.env.PUBLIC_ADMIN_URL || '';

export const prerender = false;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(MANIFEST), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
      ...(ADMIN ? { 'access-control-allow-origin': ADMIN, vary: 'Origin' } : {}),
    },
  });
```

- [ ] **Step 2: Build to verify the route compiles**

Run: `cd ../fermerski-pazar-chaika && npx astro build`
Expected: build succeeds; route `/editable-manifest.json` present.

- [ ] **Step 3: Commit**

```bash
git add src/pages/editable-manifest.json.ts
git commit -m "feat: serve editable-manifest.json (CORS for admin)"
```

---

## Task 3: chaika — registry-driven CopySlot + MediaSlot

**Files:**
- Modify: `../fermerski-pazar-chaika/src/components/CopySlot.astro`
- Modify: `../fermerski-pazar-chaika/src/components/MediaSlot.astro`

- [ ] **Step 1: Rewrite CopySlot.astro (registry-driven, emits anchor)**

```astro
---
/**
 * Editable text slot. Default text + multiline come from the editable-manifest
 * registry (SLOTS[slot]); renders the tenant override copy[slot] when non-empty,
 * else the registry default. Emits data-editable-slot so the admin preview can
 * locate it. Bare text node unless multiline (composes inside <h1>/<h2>/<p>).
 */
import { SLOTS } from '../lib/editable-manifest';
interface Props { slot: string; copy?: Record<string, string> | null }
const { slot, copy } = Astro.props;
const def = SLOTS[slot];
if (!def || def.kind !== 'text') console.warn('[CopySlot] unknown text slot:', slot);
const fallback = def && def.kind === 'text' ? def.default : '';
const multiline = !!(def && def.kind === 'text' && def.multiline);
const raw = copy?.[slot];
const text = typeof raw === 'string' && raw.trim() ? raw : fallback;
---
{multiline
  ? <span style="white-space:pre-line" data-editable-slot={slot}>{text}</span>
  : <span data-editable-slot={slot}>{text}</span>}
```

(Note: v1 emitted a bare `<Fragment>` for single-line; v2 wraps in a `<span data-editable-slot>` so the preview can target the exact text. A `<span>` inside `<h1>/<h2>/<p>` is valid inline content and inherits styles — no visual change.)

- [ ] **Step 2: Rewrite MediaSlot.astro (registry-driven, emits anchor)**

```astro
---
/**
 * Decorative image slot. label/ratio/rounded come from the editable-manifest
 * registry (SLOTS[slot]); renders the tenant photo media[slot] or the .ph mock.
 * `priority`/`klass` stay props (layout the registry can't know). Emits
 * data-editable-slot for the admin preview.
 */
import { cfImage, cfSrcset } from '../lib/img';
import { SLOTS } from '../lib/editable-manifest';
interface Props {
  slot: string;
  media?: Record<string, { url?: string }> | null;
  klass?: string;
  priority?: boolean;
}
const { slot, media, klass = '', priority = false } = Astro.props;
const def = SLOTS[slot];
if (!def || def.kind !== 'image') console.warn('[MediaSlot] unknown image slot:', slot);
const label = def && def.kind === 'image' ? def.label : slot;
const ratio = def && def.kind === 'image' ? def.ratio : undefined;
const rounded = !!(def && def.kind === 'image' && def.rounded);
const url = media?.[slot]?.url;
const cls = ['ph', rounded ? 'ph--rounded' : '', klass].filter(Boolean).join(' ');
const style = ratio ? `aspect-ratio:${ratio}` : undefined;
---
<div class={cls} style={style} data-editable-slot={slot}>
  {url ? (
    <img src={cfImage(url, 1600)} srcset={cfSrcset(url, [800, 1600])} sizes="100vw" alt={label}
      loading={priority ? 'eager' : 'lazy'} decoding="async" fetchpriority={priority ? 'high' : undefined}
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />
  ) : (
    <span class="ph__label">{label}</span>
  )}
</div>
```

- [ ] **Step 3: Build (will fail until pages stop passing removed props — that's Task 4; for now just typecheck the components compile)**

Run: `cd ../fermerski-pazar-chaika && npx astro check 2>&1 | head -30`
Expected: errors ONLY of the form "pages pass `fallback`/`label`/`ratio` which no longer exist in Props" (fixed in Task 4). If other errors, fix them. (Astro may not hard-fail on extra props; if build passes, fine.)

- [ ] **Step 4: Commit**

```bash
git add src/components/CopySlot.astro src/components/MediaSlot.astro
git commit -m "feat: CopySlot/MediaSlot read defaults from registry + emit data-editable-slot"
```

---

## Task 4: chaika — strip redundant props + add section anchors (5 pages)

**Files:** `../fermerski-pazar-chaika/src/pages/{index,about,orders,contact,faq}.astro`

For each page: (a) remove the now-removed props from every `<CopySlot>` (drop `fallback=…` and `multiline`) and `<MediaSlot>` (drop `label=…` and `ratio=…`; KEEP `slot`, `copy`/`media`, `priority`, `klass`); (b) wrap/tag each section container with `data-copy-section="<section.id>"` matching the manifest section ids.

- [ ] **Step 1: index.astro**

For every CopySlot, reduce to `<CopySlot slot="…" copy={sf.copy} />`. For every MediaSlot, reduce to `<MediaSlot slot="…" media={sf.media} [priority] [klass="…"] />`. Then add `data-copy-section` to the section wrapper for each id: add the attribute to the nearest stable container element of each section.

Section id → container (match by current markup):
- `home.hero` → the `<section class="hero section">`
- `home.twoways` → the `<section class="section--tight">` containing „Два начина"
- `home.categories` → the categories `<section class="section">`
- `home.farmers` → the farmers `<section>`
- `home.latest` → the featured `<section class="section--tight">`
- `home.reviews` → the reviews `<section class="section--tight">`
- `home.how` → the how-it-works `<section class="section">`
- `home.location` → the market-location `<section class="section">`
- `home.trust` → the trust `<section class="section--tight">`
- `home.newsletter` → the newsletter `<section class="section--tight">`

Example (hero): `<section class="hero section" data-copy-section="home.hero">` and inside `<span class="eyebrow"><CopySlot slot="home.hero.eyebrow" copy={sf.copy} /></span>`, `<MediaSlot slot="home.hero" media={sf.media} priority />`.

Run: `cd ../fermerski-pazar-chaika && npx astro build` → must succeed. Commit:
```bash
git add src/pages/index.astro && git commit -m "feat: index.astro registry slots + section anchors"
```

- [ ] **Step 2: about.astro** — same reduction. `data-copy-section` ids: `about.hero` (hero `<section>`), `about.story` (prose `<section--tight>`), `about.values` (values `<section>`), `about.gallery` (the „От пазара" gallery `<section>` — contains both the heading texts and all `about.gallery_*` MediaSlots), `about.quote` (quote `<section--tight>`). Keep `{sf.name}` outside CopySlot in `about.hero.lead` + the quote footer. Build → commit `feat: about.astro registry slots + section anchors`.

- [ ] **Step 3: orders.astro** — ids: `orders.head`, `orders.pickup` (the pickup pillar article — also holds `site.pillar_market` MediaSlot), `orders.delivery` (delivery pillar — holds `site.pillar_delivery` MediaSlot), `orders.steps`, `orders.know` (holds `orders.box` MediaSlot). Build → commit `feat: orders.astro registry slots + section anchors`.

- [ ] **Step 4: contact.astro** — ids: `contact.head`, `contact.form`. Build → commit `feat: contact.astro registry slots + section anchors`.

- [ ] **Step 5: faq.astro** — id `faq.head` on the heading `<section>`. The `DEFAULT_FAQ`/`sf.faq` logic from v1 stays. Build → commit `feat: faq.astro section anchor`.

> NOTE for all: the `site.pillar_market`/`site.pillar_delivery` MediaSlots appear on BOTH index and orders. Tag the index occurrences inside `home.twoways` and the orders occurrences inside `orders.pickup`/`orders.delivery`. The manifest lists these image slots once (under `home.twoways`); that's fine — editing updates both pages.

---

## Task 5: chaika — preview-mode framing + listener

**Files:**
- Modify: `../fermerski-pazar-chaika/src/middleware.ts`
- Modify: `../fermerski-pazar-chaika/src/components/Layout.astro`

- [ ] **Step 1: middleware preview branch**

In `middleware.ts`, replace the two unconditional framing lines with a preview-aware block:

```ts
  const isPreview = ctx.url.searchParams.get('preview') === '1';
  const ADMIN = import.meta.env.PUBLIC_ADMIN_URL || '';
  if (isPreview && ADMIN) {
    // Allow embedding ONLY in the admin „Промени сайта" preview, ONLY from the
    // configured admin origin. No X-Frame-Options (it has no multi-origin form);
    // frame-ancestors is the authoritative control. Never cache a preview render.
    res.headers.set('Content-Security-Policy', `frame-ancestors ${ADMIN}`);
    res.headers.set('Cache-Control', 'no-store');
  } else {
    res.headers.set('X-Frame-Options', 'DENY');
    res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  }
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
```

Then guard the existing HTML edge-cache block so it does NOT run in preview (preview already set `no-store`): change its `if` to also require `!isPreview`.

- [ ] **Step 2: Layout preview listener**

In `Layout.astro` frontmatter add: `const isPreview = Astro.url.searchParams.get('preview') === '1';` and `const adminOrigin = import.meta.env.PUBLIC_ADMIN_URL || '';`. Before `</body>` (after the existing `<script>import '../scripts/ui.ts'</script>`), add:

```astro
{isPreview && adminOrigin && (
  <script is:inline define:vars={{ adminOrigin }}>
    (function () {
      var last;
      function outline(el) {
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (last) last.style.outline = '';
        last = el;
        el.style.outline = '3px solid #3F7D43';
        el.style.outlineOffset = '3px';
        setTimeout(function () { if (el) { el.style.outline = ''; el.style.outlineOffset = ''; } }, 1600);
      }
      window.addEventListener('message', function (e) {
        if (e.origin !== adminOrigin) return;
        var d = e.data || {};
        if (d.type === 'ff-preview-scroll' && typeof d.section === 'string') {
          outline(document.querySelector('[data-copy-section="' + d.section.replace(/"/g, '') + '"]'));
        }
      });
      // Announce ready so the admin can flush a queued scroll after navigation.
      try { parent.postMessage({ type: 'ff-preview-ready' }, adminOrigin); } catch (_) {}
    })();
  </script>
)}
```

- [ ] **Step 3: Build + commit**

Run: `cd ../fermerski-pazar-chaika && npx astro build` → success.
```bash
git add src/middleware.ts src/components/Layout.astro
git commit -m "feat: preview-mode framing + postMessage scroll listener"
```

---

## Task 6: server — slot-agnostic helpers (delete catalogs, cleanCopy, sanitizeSiteUrl)

**Files:**
- Delete: `server/src/modules/tenants/copy-slots.catalog.ts`, `copy-slots.catalog.spec.ts`, `media-slots.catalog.ts`
- Modify: `server/src/modules/tenants/site-copy.ts` (+ `site-copy.spec.ts`)

- [ ] **Step 1: Rewrite `site-copy.ts`**

```ts
// server/src/modules/tenants/site-copy.ts
export interface PublicFaqItem { q: string; a: string; }

/** Allowed override-key shape. The storefront's registry decides which keys are
 *  real; the server only guards against absurd/injection-y keys. */
export const SLOT_KEY_RE = /^[a-z0-9._-]{1,80}$/i;

/** Clean an incoming copy map: keep only pattern-valid keys, trim, drop empty. */
export function cleanCopy(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SLOT_KEY_RE.test(k) || typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out[k] = t;
  }
  return out;
}

export function buildPublicCopy(raw: unknown): Record<string, string> {
  return cleanCopy(raw);
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
export const buildPublicFaq = normalizeFaq;

/** Sanitize the farm's storefront URL — it becomes an iframe src in the admin,
 *  so only http/https absolute URLs are allowed; everything else → ''. */
export function sanitizeSiteUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const v = raw.trim();
  if (!v || v.length > 300) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** True if a key is a structurally valid slot key (used by media upload). */
export function isValidSlotKey(key: string): boolean {
  return SLOT_KEY_RE.test(key);
}
```

- [ ] **Step 2: Delete the catalog files**

```bash
cd C:/Users/Lenovo/source/repos/FarmFlow
git rm server/src/modules/tenants/copy-slots.catalog.ts server/src/modules/tenants/copy-slots.catalog.spec.ts server/src/modules/tenants/media-slots.catalog.ts
```

- [ ] **Step 3: Rewrite `site-copy.spec.ts`**

```ts
// server/src/modules/tenants/site-copy.spec.ts
import { cleanCopy, normalizeFaq, sanitizeSiteUrl, isValidSlotKey } from './site-copy';

describe('site-copy helpers (slot-agnostic)', () => {
  it('cleanCopy keeps pattern-valid keys, trims, drops empty/bad', () => {
    expect(cleanCopy({ 'home.hero.title': '  Hi  ', 'home.hero.lead': '  ', 'bad key!': 'x', n: 5 }))
      .toEqual({ 'home.hero.title': 'Hi' });
  });
  it('cleanCopy returns {} for non-objects', () => {
    expect(cleanCopy(null)).toEqual({});
    expect(cleanCopy(['a'])).toEqual({});
  });
  it('normalizeFaq trims, drops empty, caps 50', () => {
    expect(normalizeFaq([{ q: ' Q ', a: ' A ' }, { q: '', a: '' }])).toEqual([{ q: 'Q', a: 'A' }]);
    expect(normalizeFaq(Array(60).fill({ q: 'x', a: 'y' })).length).toBe(50);
  });
  it('sanitizeSiteUrl allows http(s), strips trailing slash, rejects others', () => {
    expect(sanitizeSiteUrl('https://pazar.bg/')).toBe('https://pazar.bg');
    expect(sanitizeSiteUrl('http://a.test/x')).toBe('http://a.test/x');
    expect(sanitizeSiteUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeSiteUrl('data:text/html,x')).toBe('');
    expect(sanitizeSiteUrl('not a url')).toBe('');
    expect(sanitizeSiteUrl('')).toBe('');
  });
  it('isValidSlotKey guards', () => {
    expect(isValidSlotKey('about.gallery_stalls')).toBe(true);
    expect(isValidSlotKey('site.pillar_market')).toBe(true);
    expect(isValidSlotKey('bad key')).toBe(false);
  });
});
```

- [ ] **Step 4: Run + commit**

Run: `cd server; npx jest site-copy --runInBand` → PASS. (copy-slots.catalog.spec is gone.)
```bash
git add server/src/modules/tenants/site-copy.ts server/src/modules/tenants/site-copy.spec.ts
git commit -m "feat(tenants): slot-agnostic copy helpers + sanitizeSiteUrl; delete catalogs"
```

---

## Task 7: server — service + DTO + controller reshape

**Files:**
- Modify: `server/src/modules/tenants/dto/site-copy.dto.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts`
- Modify: `server/src/modules/tenants/tenants.controller.ts`

- [ ] **Step 1: DTO — add siteUrl**

In `dto/site-copy.dto.ts` add to `SiteCopyDto` (keep `copy` + `faq` as-is):
```ts
  @IsOptional()
  @IsString()
  @MaxLength(300)
  siteUrl?: string;
```
(Add `IsOptional` to the class-validator import.)

- [ ] **Step 2: service — imports + getSiteCopy + setSiteCopy + media validation**

In `tenants.service.ts`:
- Remove the catalog imports (`getCopyCatalog`/`CopySlotDef` from copy-slots.catalog; `getMediaCatalog`/`isValidSlot`/`MediaSlotDef` from media-slots.catalog). Update the site-copy import to: `import { buildPublicCopy, buildPublicFaq, cleanCopy, normalizeFaq, sanitizeSiteUrl, isValidSlotKey, type PublicFaqItem } from './site-copy';`
- Replace `getSiteCopy` with:
```ts
  /** Current overrides for the unified „Промени сайта" editor. Slot definitions
   *  come from the storefront manifest (admin fetches it client-side). */
  async getSiteCopy(tenantId: string): Promise<{
    copy: Record<string, string>;
    media: Record<string, { url: string }>;
    faq: PublicFaqItem[];
    siteUrl: string;
  }> {
    const settings = await this.loadSettings(tenantId);
    return {
      copy: buildPublicCopy(settings.copy),
      media: toPublicMedia(settings.media),
      faq: buildPublicFaq(settings.faq),
      siteUrl: sanitizeSiteUrl(settings.siteUrl),
    };
  }
```
  (`toPublicMedia` already exists — the helper used by the old `getSiteMedia`. Confirm it's still defined; keep it.)
- Replace `setSiteCopy` to also write siteUrl:
```ts
  async setSiteCopy(
    tenantId: string,
    dto: SiteCopyDto,
  ): Promise<{ copy: Record<string, string>; faq: PublicFaqItem[]; siteUrl: string }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const copy = cleanCopy(dto.copy);
    const faq = normalizeFaq(dto.faq);
    const siteUrl = sanitizeSiteUrl(dto.siteUrl);
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          jsonb_set(
            jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['copy'], ${JSON.stringify(copy)}::jsonb, true),
            array['faq'], ${JSON.stringify(faq)}::jsonb, true),
          array['siteUrl'], ${JSON.stringify(siteUrl)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { copy, faq, siteUrl };
  }
```
- In `setSiteMedia` replace `if (!isValidSlot(this.themeOf(settings), slotKey)) throw …` with `if (!isValidSlotKey(slotKey)) throw new BadRequestException('Непознат слот');`. In `deleteSiteMedia` the guard (if any) likewise uses `isValidSlotKey`. Remove the now-unused `getSiteMedia` method (the one returning `{catalog, values}`).
- Remove `themeOf` ONLY if it's now unused (check: it was used by getSiteMedia/getSiteCopy/setSiteMedia for theme; if nothing else references it, delete it; otherwise leave).

- [ ] **Step 3: controller — drop GET me/media; keep upload/delete; getSiteCopy unchanged route**

In `tenants.controller.ts` remove the `@Get('me/media') getMedia(...)` handler (its service method is gone). KEEP `@Post('me/media/:slotKey')` and `@Delete('me/media/:slotKey')`. The `GET/PATCH me/site-copy` handlers stay (service shapes changed, route unchanged). Remove now-unused imports if any.

- [ ] **Step 4: build + targeted tests**

Run: `cd server; npx tsc --noEmit` → 0 errors (this catches every dangling catalog reference; fix each until clean).
Run: `cd server; npx jest tenants --runInBand` (and any spec that imported the catalogs — fix/adjust them; e.g. if `tenants.service.spec.ts` or `public-cache.service.spec.ts` referenced the catalog, update to the new shapes).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants
git commit -m "feat(tenants): slot-agnostic getSiteCopy/setSiteCopy(+siteUrl); pattern-validate media; drop GET me/media"
```

---

## Task 8: server — full suite + builds gate

- [ ] **Step 1:** `cd server; npx jest --runInBand` → all green (catalog specs gone; site-copy + tenants pass). Fix any spec still importing deleted files.
- [ ] **Step 2:** `cd packages/db; npm run build; cd ../types; npm run build; cd ../../server; npm run build` → clean.
- [ ] **Step 3:** Commit if any spec fixes: `git add server && git commit -m "test(tenants): align specs with slot-agnostic store"` (skip if none).

---

## Task 9: admin — api-client (manifest + reshaped site-copy)

**Files:** `client/src/lib/api-client.ts`

- [ ] **Step 1: Replace the site-media + site-copy blocks**

Remove `SiteMediaSlotDef`, `SiteMediaResponse`, `getSiteMedia` (KEEP `uploadSiteMedia`, `deleteSiteMedia`). Replace the v1 site-copy block with:

```ts
// ---- Unified site editor (manifest + overrides) ----
export interface ManifestTextSlot { kind: 'text'; key: string; label: string; default: string; multiline?: boolean }
export interface ManifestImageSlot { kind: 'image'; key: string; label: string; ratio: string; rounded?: boolean; note?: string }
export type ManifestSlot = ManifestTextSlot | ManifestImageSlot;
export interface ManifestSection { id: string; label: string; slots: ManifestSlot[] }
export interface ManifestPage { route: string; label: string; sections: ManifestSection[]; faq?: boolean }
export interface EditableManifest { theme: string; pages: ManifestPage[] }

export interface SiteFaqItem { q: string; a: string; }
export interface SiteCopyData {
  copy: Record<string, string>;
  media: Record<string, { url: string }>;
  faq: SiteFaqItem[];
  siteUrl: string;
}

export const getSiteCopy = () => apiFetch<SiteCopyData>('tenants/me/site-copy');

export const updateSiteCopy = (data: { copy: Record<string, string>; faq: SiteFaqItem[]; siteUrl: string }) =>
  apiFetch<{ copy: Record<string, string>; faq: SiteFaqItem[]; siteUrl: string }>(
    'tenants/me/site-copy',
    { method: 'PATCH', ...json(data) },
    'Неуспешно записване',
  );

/** Fetch the storefront's editable manifest directly (cross-origin, CORS-gated).
 *  Throws on network/HTTP error so the caller can show a friendly fallback. */
export async function getEditableManifest(siteUrl: string): Promise<EditableManifest> {
  const res = await fetch(`${siteUrl.replace(/\/$/, '')}/editable-manifest.json`, { mode: 'cors' });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  return (await res.json()) as EditableManifest;
}
```

- [ ] **Step 2:** `cd client; npx tsc --noEmit` → 0 errors (will surface usages of removed `getSiteMedia` in `page.tsx`/`copy-tab.tsx` — those are replaced in Task 10/11).
  - If tsc fails only due to those soon-to-be-replaced files, proceed; otherwise fix.
- [ ] **Step 3: Commit**
```bash
git add client/src/lib/api-client.ts
git commit -m "feat(admin): manifest + reshaped site-copy api-client"
```

---

## Task 10: admin — preview pane (iframe + focus→postMessage)

**Files:** Create `client/src/app/(admin)/site-media/preview-pane.tsx`

- [ ] **Step 1: Create the component**

```tsx
'use client';

import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { RefreshCw } from 'lucide-react';

export interface PreviewHandle {
  /** Navigate (if needed) to the page for `route` and scroll/outline `section`. */
  focusSection: (route: string, section: string) => void;
  /** Reload the current preview (after a save). */
  reload: () => void;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

export const PreviewPane = forwardRef<PreviewHandle, { siteUrl: string }>(function PreviewPane(
  { siteUrl },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [route, setRoute] = useState('/');
  const pending = useRef<string | null>(null);
  const origin = originOf(siteUrl);

  function src(r: string) {
    return `${siteUrl.replace(/\/$/, '')}${r}?preview=1`;
  }

  function postScroll(section: string) {
    if (!origin) return;
    iframeRef.current?.contentWindow?.postMessage({ type: 'ff-preview-scroll', section }, origin);
  }

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== origin) return;
      if ((e.data || {}).type === 'ff-preview-ready' && pending.current) {
        postScroll(pending.current);
        pending.current = null;
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origin]);

  useImperativeHandle(ref, () => ({
    focusSection(r, section) {
      if (r !== route) {
        pending.current = section;     // flushed on ff-preview-ready
        setRoute(r);
      } else {
        postScroll(section);
      }
    },
    reload() {
      const f = iframeRef.current;
      if (f) f.src = src(route);
    },
  }), [route, origin]);

  if (!siteUrl) {
    return (
      <div className="grid h-full place-items-center rounded-2xl border border-dashed border-ff-border bg-ff-surface p-6 text-center text-[13.5px] text-ff-muted">
        Въведи „Адрес на сайта", за да виждаш преглед на живо.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <div className="flex items-center justify-between gap-2 border-b border-ff-border px-3 py-2">
        <span className="truncate text-[12px] text-ff-muted">{src(route)}</span>
        <button type="button" onClick={() => iframeRef.current && (iframeRef.current.src = src(route))}
          title="Опресни" className="p-1 text-ff-muted hover:text-ff-ink"><RefreshCw size={14} /></button>
      </div>
      <iframe ref={iframeRef} src={src(route)} title="Преглед на сайта"
        className="h-full w-full flex-1 bg-white" />
    </div>
  );
});
```

- [ ] **Step 2:** `cd client; npx tsc --noEmit` (it compiles standalone; page wiring is Task 11). Commit:
```bash
git add "client/src/app/(admin)/site-media/preview-pane.tsx"
git commit -m "feat(admin): live storefront preview pane (iframe + postMessage scroll)"
```

---

## Task 11: admin — unified site editor + page shell

**Files:**
- Create: `client/src/app/(admin)/site-media/site-editor.tsx`
- Replace: `client/src/app/(admin)/site-media/page.tsx`
- Delete: `client/src/app/(admin)/site-media/copy-tab.tsx`

- [ ] **Step 1: Create `site-editor.tsx`**

```tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, RotateCcw, Upload, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  getSiteCopy, updateSiteCopy, getEditableManifest, uploadSiteMedia, deleteSiteMedia,
  type EditableManifest, type ManifestSlot, type SiteFaqItem,
} from '@/lib/api-client';
import { PreviewPane, type PreviewHandle } from './preview-pane';

const ACCEPT = 'image/jpeg,image/png,image/webp';

export function SiteEditor() {
  const [manifest, setManifest] = useState<EditableManifest | null>(null);
  const [manifestErr, setManifestErr] = useState(false);
  const [copy, setCopy] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<Record<string, { url: string }>>({});
  const [faq, setFaq] = useState<SiteFaqItem[]>([]);
  const [siteUrl, setSiteUrl] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busyMedia, setBusyMedia] = useState<Record<string, boolean>>({});
  const [showPreview, setShowPreview] = useState(false); // mobile toggle
  const preview = useRef<PreviewHandle>(null);

  // Load overrides, then the manifest from the storefront.
  useEffect(() => {
    getSiteCopy().then((d) => {
      setCopy(d.copy); setMedia(d.media); setFaq(d.faq); setSiteUrl(d.siteUrl); setUrlDraft(d.siteUrl);
      if (d.siteUrl) {
        getEditableManifest(d.siteUrl)
          .then((m) => { setManifest(m); try { localStorage.setItem('ff-manifest:' + d.siteUrl, JSON.stringify(m)); } catch {} })
          .catch(() => {
            const cached = (() => { try { return JSON.parse(localStorage.getItem('ff-manifest:' + d.siteUrl) || 'null'); } catch { return null; } })();
            if (cached) setManifest(cached); else setManifestErr(true);
          });
      }
    }).catch(() => toast.error('Неуспешно зареждане')).finally(() => setLoading(false));
  }, []);

  function setField(key: string, value: string) { setCopy((c) => ({ ...c, [key]: value })); setDirty(true); }
  function resetField(key: string) { setCopy((c) => { const n = { ...c }; delete n[key]; return n; }); setDirty(true); }
  function setFaqItem(i: number, patch: Partial<SiteFaqItem>) { setFaq((f) => f.map((it, idx) => idx === i ? { ...it, ...patch } : it)); setDirty(true); }
  function addFaq() { setFaq((f) => [...f, { q: '', a: '' }]); setDirty(true); }
  function removeFaq(i: number) { setFaq((f) => f.filter((_, idx) => idx !== i)); setDirty(true); }
  function moveFaq(i: number, dir: -1 | 1) {
    setFaq((f) => { const j = i + dir; if (j < 0 || j >= f.length) return f; const n = [...f]; [n[i], n[j]] = [n[j], n[i]]; return n; });
    setDirty(true);
  }

  // route per page comes straight from the manifest; section is the slot's section id.
  const routeOfSection = useMemo(() => {
    const m: Record<string, string> = {};
    manifest?.pages.forEach((p) => p.sections.forEach((s) => { m[s.id] = p.route; }));
    return m;
  }, [manifest]);
  function focusSlot(sectionId: string) {
    preview.current?.focusSection(routeOfSection[sectionId] ?? '/', sectionId);
    setShowPreview(true);
  }

  async function uploadPhoto(slotKey: string, file: File) {
    setBusyMedia((b) => ({ ...b, [slotKey]: true }));
    try {
      const { url } = await uploadSiteMedia(slotKey, file);
      setMedia((m) => ({ ...m, [slotKey]: { url } }));
      toast.success('Снимката е качена');
      preview.current?.reload();
    } catch { toast.error('Неуспешно качване'); }
    finally { setBusyMedia((b) => ({ ...b, [slotKey]: false })); }
  }
  async function removePhoto(slotKey: string) {
    setBusyMedia((b) => ({ ...b, [slotKey]: true }));
    try {
      await deleteSiteMedia(slotKey);
      setMedia((m) => { const n = { ...m }; delete n[slotKey]; return n; });
      toast.success('Снимката е премахната');
      preview.current?.reload();
    } catch { toast.error('Неуспешно изтриване'); }
    finally { setBusyMedia((b) => ({ ...b, [slotKey]: false })); }
  }

  async function save() {
    setSaving(true);
    try {
      const cleanCopy: Record<string, string> = {};
      for (const [k, v] of Object.entries(copy)) if (v.trim()) cleanCopy[k] = v.trim();
      const cleanFaq = faq.map((f) => ({ q: f.q.trim(), a: f.a.trim() })).filter((f) => f.q || f.a);
      const res = await updateSiteCopy({ copy: cleanCopy, faq: cleanFaq, siteUrl: urlDraft.trim() });
      setCopy(res.copy); setFaq(res.faq); setSiteUrl(res.siteUrl); setUrlDraft(res.siteUrl);
      setDirty(false);
      toast.success('Промените са запазени');
      preview.current?.reload();
    } catch { toast.error('Неуспешно записване'); }
    finally { setSaving(false); }
  }

  if (loading) return <p className="text-[14px] text-ff-muted">Зареждане…</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* LEFT: editor */}
      <div className="flex min-w-0 flex-col gap-6">
        {/* Site URL */}
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
          <label htmlFor="ff-site-url" className="text-[13px] font-semibold text-ff-ink">Адрес на сайта</label>
          <p className="mb-2 mt-0.5 text-[12px] text-ff-muted">За преглед на живо до полетата. Напр. https://moqta-ferma.bg</p>
          <input id="ff-site-url" type="url" inputMode="url" placeholder="https://…" value={urlDraft}
            onChange={(e) => { setUrlDraft(e.target.value); setDirty(true); }}
            className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink" />
        </div>

        {manifestErr && (
          <div className="rounded-2xl border border-ff-border bg-ff-surface p-4 text-[13.5px] text-ff-muted shadow-ff-sm">
            Структурата на сайта не можа да се зареди. Провери адреса и опитай пак.
          </div>
        )}

        {manifest?.pages.map((page) => (
          <section key={page.route}>
            <h2 className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2">{page.label}</h2>
            <div className="flex flex-col gap-5">
              {page.sections.map((sec) => (
                <div key={sec.id} className="flex flex-col gap-3 rounded-2xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
                  <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted-2">{sec.label}</div>
                  {sec.slots.map((slot) => <SlotField key={slot.key} slot={slot} sectionId={sec.id}
                    value={copy[slot.key] ?? ''} mediaUrl={media[slot.key]?.url} busy={!!busyMedia[slot.key]}
                    onText={setField} onReset={resetField} onFocus={focusSlot}
                    onUpload={uploadPhoto} onRemove={removePhoto} />)}
                </div>
              ))}
              {page.faq && (
                <FaqEditor faq={faq} onItem={setFaqItem} onAdd={addFaq} onRemove={removeFaq} onMove={moveFaq} />
              )}
            </div>
          </section>
        ))}

        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-ff-border bg-ff-surface py-3 shadow-[0_-6px_16px_-12px_rgba(0,0,0,0.3)]">
          <button type="button" onClick={() => setShowPreview((v) => !v)}
            className="flex items-center gap-1.5 rounded-sm px-3 py-2 text-[13.5px] text-ff-muted hover:text-ff-ink lg:hidden">
            <Eye size={15} /> {showPreview ? 'Скрий преглед' : 'Преглед'}
          </button>
          <span className="hidden lg:block" />
          <Button type="button" disabled={!dirty || saving} onClick={save} className="rounded-sm px-6 py-2.5 text-[14px]">
            {saving ? 'Записване…' : 'Запази промените'}
          </Button>
        </div>
      </div>

      {/* RIGHT: preview (sticky on desktop; toggle on mobile) */}
      <div className={`${showPreview ? 'block' : 'hidden'} lg:block`}>
        <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-7rem)]">
          <PreviewPane ref={preview} siteUrl={siteUrl} />
        </div>
      </div>
    </div>
  );
}

function SlotField({ slot, sectionId, value, mediaUrl, busy, onText, onReset, onFocus, onUpload, onRemove }: {
  slot: ManifestSlot; sectionId: string; value: string; mediaUrl?: string; busy: boolean;
  onText: (k: string, v: string) => void; onReset: (k: string) => void; onFocus: (sectionId: string) => void;
  onUpload: (k: string, f: File) => void; onRemove: (k: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (slot.kind === 'image') {
    return (
      <div className="flex items-center gap-3">
        <div className="grid h-14 w-20 shrink-0 place-items-center overflow-hidden rounded-sm border border-ff-border bg-[#E4EADF]" style={{ aspectRatio: slot.ratio }}>
          {mediaUrl ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={mediaUrl} alt={slot.label} className="h-full w-full object-cover" /> : <span className="px-1 text-center text-[9px] uppercase text-[#76836E]">{slot.label}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ff-ink">{slot.label}</div>
          <div className="text-[12px] text-ff-muted">Снимка {slot.ratio.replace('/', ':')}{slot.note ? ` · ${slot.note}` : ''}</div>
        </div>
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(slot.key, f); e.target.value = ''; }} />
        <Button variant="soft" type="button" disabled={busy} onClick={() => { onFocus(sectionId); inputRef.current?.click(); }}
          className="gap-1.5 rounded-sm px-3 py-2 text-[13px]"><Upload size={14} /> {mediaUrl ? 'Смени' : 'Качи'}</Button>
        {mediaUrl && <button type="button" disabled={busy} onClick={() => onRemove(slot.key)} title="Премахни" className="p-1 text-ff-red hover:bg-ff-red/10 rounded-sm"><Trash2 size={14} /></button>}
      </div>
    );
  }
  const overridden = value.trim().length > 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={slot.key} className="text-[13px] font-semibold text-ff-ink">{slot.label}</label>
        {overridden && <button type="button" onClick={() => onReset(slot.key)} className="flex items-center gap-1 text-[12px] text-ff-muted hover:text-ff-ink" title="Върни оригинала"><RotateCcw size={12} /> Върни оригинала</button>}
      </div>
      {slot.multiline
        ? <textarea id={slot.key} rows={3} value={value} placeholder={slot.default} onFocus={() => onFocus(sectionId)} onChange={(e) => onText(slot.key, e.target.value)} className="w-full resize-y rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2" />
        : <input id={slot.key} type="text" value={value} placeholder={slot.default} onFocus={() => onFocus(sectionId)} onChange={(e) => onText(slot.key, e.target.value)} className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2" />}
    </div>
  );
}

function FaqEditor({ faq, onItem, onAdd, onRemove, onMove }: {
  faq: SiteFaqItem[]; onItem: (i: number, p: Partial<SiteFaqItem>) => void; onAdd: () => void; onRemove: (i: number) => void; onMove: (i: number, d: -1 | 1) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="text-[12px] font-bold uppercase tracking-[0.04em] text-ff-muted-2">Въпроси и отговори</div>
      {faq.length === 0 && <p className="text-[13px] text-ff-muted">Няма въпроси. Добави първия.</p>}
      {faq.map((item, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-sm border border-ff-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-ff-muted-2">Въпрос {i + 1}</span>
            <div className="flex gap-1">
              <button type="button" onClick={() => onMove(i, -1)} disabled={i === 0} title="Нагоре" className="p-1 text-ff-muted hover:text-ff-ink disabled:opacity-30"><ArrowUp size={14} /></button>
              <button type="button" onClick={() => onMove(i, 1)} disabled={i === faq.length - 1} title="Надолу" className="p-1 text-ff-muted hover:text-ff-ink disabled:opacity-30"><ArrowDown size={14} /></button>
              <button type="button" onClick={() => onRemove(i)} title="Изтрий" className="p-1 text-ff-red hover:bg-ff-red/10 rounded-sm"><Trash2 size={14} /></button>
            </div>
          </div>
          <input type="text" value={item.q} placeholder="Въпрос" onChange={(e) => onItem(i, { q: e.target.value })} className="w-full rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2" />
          <textarea rows={2} value={item.a} placeholder="Отговор" onChange={(e) => onItem(i, { a: e.target.value })} className="w-full resize-y rounded-sm border border-ff-border bg-white px-3 py-2 text-[14px] text-ff-ink placeholder:text-ff-muted-2" />
        </div>
      ))}
      <Button variant="soft" type="button" onClick={onAdd} className="self-start gap-1.5 rounded-sm py-2 text-[13.5px]"><Plus size={15} /> Добави въпрос</Button>
    </div>
  );
}
```

(Remove the stray `{page.faq && sec.id === … && null}` line if your linter flags it — it's a no-op guard; the FAQ editor is rendered once per faq page below the sections.)

- [ ] **Step 2: Replace `page.tsx`**

```tsx
import { SiteEditor } from './site-editor';

export default function SiteEditorPage() {
  return (
    <div className="max-w-[1400px]">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Промени сайта</h1>
        <p className="text-[13.5px] text-ff-muted">
          Смени текстовете и снимките на сайта. Фокусирай поле, за да видиш къде е на живо вдясно.
        </p>
      </div>
      <SiteEditor />
    </div>
  );
}
```

- [ ] **Step 3: Delete the old copy-tab**

```bash
cd C:/Users/Lenovo/source/repos/FarmFlow
git rm "client/src/app/(admin)/site-media/copy-tab.tsx"
```

- [ ] **Step 4: typecheck + build**

Run: `cd client; npx tsc --noEmit` → 0 errors.
Run: `cd client; npm run build` → success.

- [ ] **Step 5: Commit**

```bash
git add "client/src/app/(admin)/site-media"
git commit -m "feat(admin): unified manifest-driven site editor + live preview (drop tabs)"
```

---

## Task 12: docs

**Files:** `docs/admin-panel-guide.md`, `client/src/app/(admin)/help/page.tsx`

- [ ] **Step 1:** Update the „Промени сайта" entry: it's now ONE editor (no tabs) with text + photos per section and a live preview; note that the editable structure comes from the storefront (adding a new section/photo/page on the site appears here automatically) and that the farmer sets „Адрес на сайта" once for the preview. Run `cd client; npx tsc --noEmit` if you touch the tsx.
- [ ] **Step 2:** Commit `docs: document unified autonomous site editor + live preview`.

---

## Task 13: full verification + live E2E

- [ ] **Step 1:** Server: `cd server; npx jest --runInBand` → green. Builds: `cd packages/db; npm run build; cd ../types; npm run build; cd ../../server; npm run build` → clean.
- [ ] **Step 2:** Admin: `cd client; npx tsc --noEmit; npm run build` → clean.
- [ ] **Step 3:** chaika: `cd ../fermerski-pazar-chaika; npx astro build` → clean. Confirm `/editable-manifest.json` returns the full manifest (94 slots) and that a normal page still returns `X-Frame-Options: DENY` while `?preview=1` returns `frame-ancestors <admin>` + `no-store`.
- [ ] **Step 4: Live E2E** (start API from dist `node dist/main.js`; run chaika dev with `PUBLIC_ADMIN_URL` set to the admin origin; run admin dev). Verify with the API-level harness pattern (login → PATCH/GET) AND a browser pass:
  - `getSiteCopy` returns `{copy,media,faq,siteUrl}`; PATCH with `siteUrl` persists + sanitizes (set `javascript:…` → stored `''`).
  - In the admin „Промени сайта": set a valid „Адрес на сайта" → editor renders sections from the live manifest; focusing a text field scrolls + outlines the section in the iframe; editing + Запази reflects after reload; uploading a photo reflects; adding an FAQ item shows on `/faq`.
  - Invalid/empty siteUrl → guarded (no iframe, hint shown).
  - `setSiteMedia` with a bad slot key (`bad key`) → 400; with `home.hero` → ok.
- [ ] **Step 5:** Report results with command output.

---

## Self-Review notes (for the executor)

- **Key preservation:** every manifest slot key MUST equal the v1 key (cross-check Task 1 against the two deleted catalog files) — otherwise existing tenant overrides orphan. 82 text + 12 image = 94.
- **`toPublicMedia` / `loadSettings` / `loadTenantForMedia`** already exist in `tenants.service.ts` — reuse them; don't recreate.
- **Cross-origin:** `PUBLIC_ADMIN_URL` must be set on the chaika deploy (CORS on the manifest endpoint, preview framing, postMessage origin checks). The admin's `siteUrl` is the farm's storefront origin; postMessage uses that exact origin (never `'*'`).
- **No DB migration** (`settings.siteUrl` is a new jsonb leaf).
- **Astro `<span>` around single-line CopySlot:** inline + style-inherited → no visual change vs v1's bare text node; needed so the preview can target text too (though section-level highlight is the primary mechanism).
- If any v1 spec (`public-cache.service.spec.ts`, tenants service spec) imported a now-deleted catalog, update it to the slot-agnostic shapes.
