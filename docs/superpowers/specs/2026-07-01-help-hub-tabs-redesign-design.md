# Help Hub tabs redesign (3-part separation + AI chat polish)

## Problem

The Help pages in `client` (farmer panel) and `delivery-web` (dostavki) — shipped in the [2026-07-01 help hub refactor](./2026-07-01-help-hub-refactor-design.md) — stack three visually similar blocks on one long scrolling page: walkthrough sections, FAQ search, and the "Ask AI" box. They blend together with no clear separation. The AI box's loading state is a bare button-label swap (`'…'`) with no visual feedback while waiting for a response.

## Goals

1. Split the Help page into 3 clearly separated parts: **Ръководство** (walkthrough), **Често задавани въпроси** (FAQ), **Питай AI** (AI chat) — via tabs.
2. Redesign `AskAiBox` with a real loading state (typing indicator + skeleton) and a chat-bubble visual style.
3. Apply consistently to both `client` and `delivery-web`, reusing shared `@fermeribg/help-ui` components — no duplicated tab logic between the two apps.

## Non-goals

- No chat history / multi-turn conversation — still single question in, single answer out (unchanged from the original spec).
- No changes to FAQ content, search logic, or the `/help/ai/ask` backend endpoint.
- No unit test infrastructure added (matches the existing `help-ui` package convention — no `@testing-library/react` in this repo).

## Architecture

### New shared component: `packages/help-ui/src/HelpTabs.tsx`

```tsx
export function HelpTabs({
  guide,
  faq,
  ai,
}: {
  guide: React.ReactNode;
  faq: React.ReactNode;
  ai: React.ReactNode;
}) {
  const [active, setActive] = useState<'guide' | 'faq' | 'ai'>('guide');
  // tab bar: 3 buttons, active tab styled with ff-green-700 underline/pill
  // conditional render: only the active tab's content mounts
}
```

- `'use client'` — owns `active` tab state.
- Tab bar buttons: "Ръководство", "Често задавани въпроси", "Питай AI" — styled consistently with the existing `CategoryChips` pill pattern (`ff-border`/`ff-green-500`/`ff-green-50` tokens) but as a horizontal tab row with an active-state underline, not a multi-select chip group.
- Default active tab: `'guide'`.
- Only the active tab's children are rendered (not CSS-hidden) — cheaper, and naturally resets FAQ search/AI question state when a user navigates away and back (acceptable: no persistence requirement).
- Exported from `packages/help-ui/src/index.ts` alongside the existing components.

### `AskAiBox` redesign — chat bubbles + real loading state

Same file (`packages/help-ui/src/AskAiBox.tsx`), same props (`{ onAsk }`), same internal state shape (`question`, `answer`, `error`, `loading`) — visual/JSX rewrite only, no logic changes:

- Header unchanged: `Sparkles` icon + "Не намери отговор? Питай AI".
- Input + "Питай" button row unchanged in position, but the input is now also `disabled` while `loading` (not just the button).
- Below the input, a chat transcript area (only rendered once a question has been submitted at least once — i.e. `question` was submitted, tracked via a new local `submittedQuestion` state or reusing `answer`/`error`/`loading` presence):
  - **User bubble** (right-aligned): the submitted question, `bg-ff-green-700 text-white`, rounded with a flattened corner on the right to read as "sent".
  - **Loading state** (left-aligned, shown while `loading`): an AI-style bubble (`bg-ff-surface-2`) containing 3 animated pulsing dots (staggered `animate-pulse` with delay classes) plus 2-3 skeleton lines (`animate-pulse bg-ff-border-2 rounded h-3`) below it, simulating "AI is typing".
  - **Answer bubble** (left-aligned, replaces the loading bubble once resolved): same `bg-ff-surface-2` container, plain answer text inside.
  - **Error state**: replaces the AI bubble with a red-tinted inline bubble/banner containing the existing fallback message text (unchanged copy: "AI помощникът не е достъпен в момента, виж въпросите по-горе.").

### Page integration

**`client/src/app/(admin)/help/page.tsx`:**
- Remove the `#faq` anchor + quick-nav chip added in the prior small fix (commit `d5b8d72`) — no longer needed, tabs solve discoverability.
- `HelpPage()` renders: title + intro card (unchanged, stays above tabs) → `<HelpTabs guide={...} faq={...} ai={<AskAiBox .../>} />`.
- `guide` slot = the existing walkthrough quick-nav (`SECTIONS.map(...)` chips, minus the FAQ chip just added) + the existing `<details>` accordion list — moved as-is into the tab, no content changes.
- `faq` slot = `FaqSection`'s search bar + category chips + `FaqAccordion` — `FaqSection` stops rendering `AskAiBox` itself (that moves to the `ai` slot at the `HelpTabs` call site).

**`delivery-web/src/components/help-client.tsx`:**
- `HelpClient()` renders: header + intro (unchanged) → `<HelpTabs guide={...} faq={...} ai={<AskAiBox .../>} />`.
- `guide` slot = the existing `overview`/`econt`/`speedy`/`import`/`handover`/`cod` `<Section>` blocks plus their internal `TOC` quick-nav (drop the `#faq` TOC entry — FAQ is now a tab, not an anchor).
- `faq` slot = `FaqExplorer`'s search bar + category chips + `FaqAccordion` — stops rendering `AskAiBox`.
- The closing "Нужда от още помощ?" contact section stays outside/below `HelpTabs` (applies to all three tabs equally, not walkthrough-specific).

## Error handling

Unchanged from the original spec — `AskAiBox`'s error path still shows the same Bulgarian fallback text; only the container styling around it changes (bubble instead of plain paragraph).

## Testing

- No new unit tests — `HelpTabs` is pure presentational state (active tab index), and `AskAiBox`'s only logic (`submit`, error handling) is unchanged from the already-shipped version. Matches the existing `help-ui` package testing convention (no `@testing-library/react` in this repo; `searchFaq` remains the only unit-tested logic, per the original help-hub-refactor spec).
- Manual verification in both apps' dev servers: tab switching works and defaults to "Ръководство"; FAQ search/filter still work inside their tab; submitting a question shows the typing/skeleton loading bubble then the answer bubble (or error bubble when `OPENAI_API_KEY` is unset); no console errors; walkthrough content is unchanged from before this redesign.
