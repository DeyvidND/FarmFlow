# Help Hub refactor — FAQ search + AI Q&A (client + delivery-web)

## Problem

Both farmer-facing apps have a central "Помощ" page, but it's thin:

- `client` (farmer panel, `client/src/app/(admin)/help/page.tsx`): walkthrough accordion per screen, no search, no FAQ. Content is hand-synced with `docs/admin-panel-guide.md` (flagged as a known drift risk in a code comment).
- `delivery-web` (dostavki, `delivery-web/src/components/help-client.tsx`): walkthrough sections + a single hardcoded 5-question FAQ block, no search.

Neither scales to "many niche questions" (how farmer management works, per-farmer courier disable, how promotions/Продукт на седмицата work, how to turn a feature off, etc.) alongside the basics. Users can't search; there's no way to ask a free-form question.

## Goals

1. Large, well-organized FAQ bank per app (60-100+ entries for the panel, 30-50 for delivery), covering both basic screens and niche/advanced behavior.
2. Search bar with category-chip filtering so the FAQ list stays browsable at that scale.
3. "Ask AI" box on the same Help page, grounded strictly in the FAQ + walkthrough corpus (no invented behavior, no live tenant data access).
4. Fix the content-drift problem by making the FAQ corpus the single source of truth, reused by both frontends and the AI backend.

## Non-goals

- No AI access to a farmer's live data (products, orders, Stripe status). Confirmed with user — docs-only grounding.
- No vector DB / embeddings / RAG infra. Corpus size is small enough to stuff directly into the model's context.
- No chat history / persistent conversation — single question in, single answer out.
- No floating chat widget across the whole panel — AI box lives only on the Help page.
- Existing per-screen `<HelpModal>` system (`client/src/lib/help-content.ts`, the "Обяснения" buttons) is untouched by this refactor.

## Architecture

### New package: `packages/help-content` (pure data, no React, no server deps)

```
packages/help-content/
  src/
    types.ts        // FaqEntry, Category
    panel.faq.ts     // FAQ entries for client (farmer panel)
    delivery.faq.ts   // FAQ entries for delivery-web (dostavki)
    categories.ts     // category id -> label, per surface
    index.ts
```

```ts
export interface FaqEntry {
  id: string;
  category: string;   // category id, see categories.ts
  question: string;
  answer: string;      // plain text, no HTML/markdown rendering
  keywords?: string[]; // extra search terms not present in question/answer
}
```

This package is imported by:
- `client` and `delivery-web` — to render the FAQ UI
- `server` — to build the AI system prompt (grounding corpus)

This removes the manual sync between `client`'s help page and `docs/admin-panel-guide.md`: the FAQ corpus becomes the authoritative text, and that doc can start slot in the same content.

### New package: `packages/help-ui` (shared React components)

Both apps already share the same `ff-*` Tailwind design tokens (`ff-green-700`, `ff-border`, `ff-surface`, etc. — confirmed identical usage in both apps' current help pages), so a shared UI package is viable.

Exports:
- `<HelpSearchBar value onChange />` — controlled text input.
- `<CategoryChips categories active onToggle />` — multi-select chip row + "Всички" reset.
- `<FaqAccordion entries />` — renders a filtered `FaqEntry[]` as `<details>` groups (matches existing accordion pattern in both apps).
- `useFaqFilter(entries, query, activeCategories)` — hook, client-side substring/keyword scorer over `question + keywords + answer`. No server round trip.
- `<AskAiBox onAsk={(question) => Promise<string>} />` — question input + answer panel + loading/error states. Takes `onAsk` as a prop so each app wires it to its own existing `apiFetch` (keeps auth/base-URL logic where it already lives, doesn't duplicate it in the shared package).

### Backend: one new endpoint

`POST /help/ai/ask` on the existing NestJS server.

- Guard: existing JWT auth guard (any authenticated farmer/operator — no new role needed) + `@Throttle` (reuse existing pattern from e.g. `econt.controller.ts`; suggested 10/min per user).
- Body: `{ surface: 'panel' | 'delivery'; question: string }`, question capped at 500 chars, `BadRequestException` if empty/too long.
- Implementation mirrors `ProductExtractService`'s OpenAI client init (same `OPENAI_API_KEY` config key, `gpt-4o-mini` default, bounded timeout, `maxRetries: 1`).
- System prompt = the entire `panel.faq.ts` or `delivery.faq.ts` corpus for the given `surface`, serialized as Q&A pairs (a few tens of KB — well inside context window, no chunking/RAG needed).
- Instructs the model: answer ONLY using the supplied corpus; if the answer isn't covered, say so explicitly and point to the FAQ list / support contact — never invent panel behavior.
- Response: `{ answer: string }`. On OpenAI failure/timeout/missing key: `ServiceUnavailableException`, surfaced by `<AskAiBox>` as "AI помощникът не е достъпен в момента, виж въпросите по-долу" — the FAQ list keeps working regardless.

### Page composition

Both Help pages get the same shape, keeping their existing walkthrough sections:

1. Existing intro + walkthrough accordion sections (unchanged).
2. New: `<HelpSearchBar>` + `<CategoryChips>` + `<FaqAccordion>` — the FAQ bank.
3. New: `<AskAiBox>` below the FAQ list, for anything not found by search.

## Content plan

*Panel (`panel.faq.ts`) categories:* Продукти, Поръчки, Фермери, Категории, Наличност, Промоции/Продукт на седмицата, Доставка и часове, Куриер (Еконт/per-farmer disable), Плащания/Stripe, Статии, Отзиви, Сайт и редактор, Маркетинг, Настройки.

*Delivery (`delivery.faq.ts`) categories:* Econt/Speedy връзка, Внос на пратки, Предаване, COD/риск проверка, Проследяване.

Each category mixes basic screen explanations with the niche questions the user flagged (per-farmer courier management, how promotions/Продукт на седмицата work, how to disable a feature, etc.). Actual question/answer text is drafted during implementation, sourced from the existing code and `docs/admin-panel-guide.md` to keep answers accurate — not invented filler.

## Error handling

- AI endpoint unavailable/misconfigured (`OPENAI_API_KEY` missing) → clean 503, inline message in `<AskAiBox>`, FAQ list unaffected.
- Empty search/filter result → `<FaqAccordion>` shows an empty state pointing at `<AskAiBox>`.
- Throttled → 429 surfaced as "Твърде много въпроси, опитай пак след малко."

## Testing

- `packages/help-ui`: unit tests for `useFaqFilter` (query matching, category filter, combined).
- Server: spec for the new `/help/ai/ask` endpoint following `product-extract.service.spec.ts`'s pattern (stubbed OpenAI client) — auth required, throttle respected, grounded-refusal behavior when corpus doesn't cover the question.
- Manual verification in both apps' Help pages (dev server) once implemented.
