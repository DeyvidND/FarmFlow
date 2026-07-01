# Help Hub Tabs Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the `client` and `delivery-web` Help pages into 3 visually separated tabs (Ръководство / Често задавани въпроси / Питай AI) via a new shared `HelpTabs` component, and redesign `AskAiBox` with a real loading state (typing dots + skeleton) and a chat-bubble visual style.

**Architecture:** One new presentational component (`HelpTabs`) added to the existing `@fermeribg/help-ui` package, plus a visual-only rewrite of the existing `AskAiBox` component (same props/logic, new JSX). Both `client/src/app/(admin)/help/page.tsx` and `delivery-web/src/components/help-client.tsx` are restructured to wrap their existing walkthrough/FAQ content in `<HelpTabs>` instead of stacking it on one page.

**Tech Stack:** TypeScript, React 18, Next.js 14, Tailwind (ff-* design tokens), pnpm workspaces.

---

## Spec reference

Full design: `docs/superpowers/specs/2026-07-01-help-hub-tabs-redesign-design.md`.

---

## Task 1: `HelpTabs` shared component (`@fermeribg/help-ui`)

**Files:**
- Create: `packages/help-ui/src/HelpTabs.tsx`
- Modify: `packages/help-ui/src/index.ts`

- [ ] **Step 1: Write `HelpTabs.tsx`**

```tsx
// packages/help-ui/src/HelpTabs.tsx
'use client';
import { useState } from 'react';

type TabKey = 'guide' | 'faq' | 'ai';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'guide', label: 'Ръководство' },
  { key: 'faq', label: 'Често задавани въпроси' },
  { key: 'ai', label: 'Питай AI' },
];

/** Splits a Help page into 3 tabs so the walkthrough, FAQ search, and AI chat
 *  don't blend into one long scroll. Only the active tab's content is rendered
 *  (not CSS-hidden) — cheap, and naturally resets each tab's local state
 *  (FAQ search query, AI question) when the user navigates away and back. */
export function HelpTabs({
  guide,
  faq,
  ai,
}: {
  guide: React.ReactNode;
  faq: React.ReactNode;
  ai: React.ReactNode;
}) {
  const [active, setActive] = useState<TabKey>('guide');
  const panels: Record<TabKey, React.ReactNode> = { guide, faq, ai };

  return (
    <div>
      <div className="flex gap-1 border-b border-ff-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`relative px-4 py-2.5 text-[13.5px] font-bold transition-colors ${
              active === t.key ? 'text-ff-green-800' : 'text-ff-muted hover:text-ff-ink-2'
            }`}
          >
            {t.label}
            {active === t.key && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-ff-green-700" />}
          </button>
        ))}
      </div>
      <div className="pt-5">{panels[active]}</div>
    </div>
  );
}
```

- [ ] **Step 2: Export it from the package barrel**

Current `packages/help-ui/src/index.ts`:
```typescript
export { HelpSearchBar } from './HelpSearchBar';
export { CategoryChips } from './CategoryChips';
export { FaqAccordion } from './FaqAccordion';
export { AskAiBox } from './AskAiBox';
```

Replace with:
```typescript
export { HelpSearchBar } from './HelpSearchBar';
export { CategoryChips } from './CategoryChips';
export { FaqAccordion } from './FaqAccordion';
export { AskAiBox } from './AskAiBox';
export { HelpTabs } from './HelpTabs';
```

- [ ] **Step 3: Build the package**

Run: `pnpm --filter @fermeribg/help-ui build`
Expected: `tsc` succeeds, no type errors, `dist/HelpTabs.js`/`.d.ts` produced alongside the existing files.

- [ ] **Step 4: Commit**

```bash
git add packages/help-ui/src/HelpTabs.tsx packages/help-ui/src/index.ts
git commit -m "feat: add HelpTabs shared component for 3-way Help page separation"
```

---

## Task 2: `AskAiBox` redesign — chat bubbles + loading skeleton

**Files:**
- Modify: `packages/help-ui/src/AskAiBox.tsx` (full rewrite, same props/exported name)

No test changes — this component has no unit tests today (thin presentational component, no `@testing-library/react` in the repo), and the internal `submit`/error-handling logic is unchanged; only the JSX and one new local state variable (`submittedQuestion`, needed to render the "sent" question as a chat bubble) are added.

- [ ] **Step 1: Replace the whole file**

Current `packages/help-ui/src/AskAiBox.tsx`:
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
          aria-label="Въпрос към AI помощника"
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

Replace the entire file with:
```tsx
// packages/help-ui/src/AskAiBox.tsx
'use client';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';

export function AskAiBox({ onAsk }: { onAsk: (question: string) => Promise<string> }) {
  const [question, setQuestion] = useState('');
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const q = question.trim();
    if (!q || loading) return;
    setSubmittedQuestion(q);
    setQuestion('');
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

      {submittedQuestion && (
        <div className="mt-3.5 flex flex-col gap-3">
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-ff-green-700 px-3.5 py-2.5 text-[13px] text-white">
              {submittedQuestion}
            </div>
          </div>

          {loading && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-ff-surface-2 px-3.5 py-3">
                <div className="flex gap-1">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ff-muted" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ff-muted" style={{ animationDelay: '150ms' }} />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ff-muted" style={{ animationDelay: '300ms' }} />
                </div>
                <div className="mt-2.5 flex flex-col gap-1.5">
                  <span className="h-3 w-48 animate-pulse rounded bg-ff-border-2" />
                  <span className="h-3 w-40 animate-pulse rounded bg-ff-border-2" />
                  <span className="h-3 w-32 animate-pulse rounded bg-ff-border-2" />
                </div>
              </div>
            </div>
          )}

          {!loading && answer && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-ff-surface-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-ff-ink-2">
                {answer}
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-ff-red bg-[#FBE9E7] px-3.5 py-2.5 text-[12.5px] text-ff-red">
                {error}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3.5 flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Напиши въпроса си…"
          aria-label="Въпрос към AI помощника"
          disabled={loading}
          className="w-full rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2 text-[13px] text-ff-ink outline-none disabled:opacity-60"
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
    </div>
  );
}
```

Notes for the implementer:
- `border-ff-red bg-[#FBE9E7] text-ff-red` for the error bubble is copy-pasted verbatim from the existing "Висок риск" COD callout in `delivery-web/src/components/help-client.tsx` (search for `#FBE9E7]` in that file) — reuse this exact combo, don't invent a new opacity-modifier variant like `border-ff-red/30`. The `--ff-red` CSS variable is a plain color reference (not an rgb-channels token), so Tailwind's `/opacity` modifier syntax does not apply to it correctly.
- The typing-dots and skeleton lines use inline `style={{ animationDelay: ... }}` rather than Tailwind arbitrary-value classes — simpler to read and avoids any JIT/arbitrary-value edge cases.
- `submit()` now clears the input (`setQuestion('')`) immediately after capturing `submittedQuestion` — the previous version left the typed text sitting in the input after submission; clearing it matches normal chat-input UX and was implied by the chat-bubble style. Flag this to the controller as an intentional minor UX improvement if asked — it's not a scope violation, it's required for the bubble model to make sense (otherwise the same text would appear both in the input and in the sent bubble).

- [ ] **Step 2: Build the package**

Run: `pnpm --filter @fermeribg/help-ui build`
Expected: `tsc` succeeds, no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/help-ui/src/AskAiBox.tsx
git commit -m "feat: redesign AskAiBox with chat bubbles and a typing/skeleton loading state"
```

---

## Task 3: Wire `HelpTabs` into the farmer panel (`client`)

**Files:**
- Modify: `client/src/app/(admin)/help/page.tsx`

This task also reverts the small nav-chip fix from commit `d5b8d72` (the `#faq` anchor link) — it's superseded by the FAQ now being its own tab.

- [ ] **Step 1: Update the `@fermeribg/help-ui` import**

Current line 6:
```typescript
import { HelpSearchBar, CategoryChips, FaqAccordion, AskAiBox } from '@fermeribg/help-ui';
```

Replace with:
```typescript
import { HelpSearchBar, CategoryChips, FaqAccordion, AskAiBox, HelpTabs } from '@fermeribg/help-ui';
```

- [ ] **Step 2: Remove the `#faq` quick-nav chip**

Current (inside the intro card's `<nav>`, right after the `SECTIONS.map(...)` block):
```tsx
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="rounded-full border border-ff-border bg-ff-surface-2 px-3 py-1.5 text-[12.5px] font-bold text-ff-ink-2 transition-colors hover:border-ff-green-500 hover:bg-ff-green-50 hover:text-ff-green-800"
            >
              {s.title}
            </a>
          ))}
          <a
            href="#faq"
            className="rounded-full border border-ff-border bg-ff-surface-2 px-3 py-1.5 text-[12.5px] font-bold text-ff-ink-2 transition-colors hover:border-ff-green-500 hover:bg-ff-green-50 hover:text-ff-green-800"
          >
            Често задавани въпроси
          </a>
        </nav>
```

Replace with:
```tsx
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
```

- [ ] **Step 3: Replace the walkthrough+FAQ+AI body with `HelpTabs`**

Current (from `{/* Sections — each is a click-to-open dropdown... */}` through the end of the file):
```tsx
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
    <div id="faq" className="mt-7 flex scroll-mt-4 flex-col gap-3">
      <h2 className="text-[18px] font-extrabold tracking-[-0.01em]">Често задавани въпроси</h2>
      <HelpSearchBar value={query} onChange={setQuery} />
      <CategoryChips categories={PANEL_CATEGORIES} active={active} onToggle={toggle} />
      <FaqAccordion entries={results} />
      <AskAiBox onAsk={(q) => askHelpAi(q).then((r) => r.answer)} />
    </div>
  );
}
```

Replace with:
```tsx
      <HelpTabs
        guide={
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
        }
        faq={<FaqPanel />}
        ai={<AskAiBox onAsk={(q) => askHelpAi(q).then((r) => r.answer)} />}
      />

      <p className="mt-7 text-center text-[12.5px] text-ff-muted">ФермериБГ · Помощ</p>
    </div>
  );
}

function FaqPanel() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string[]>([]);
  const toggle = (id: string) =>
    setActive((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const results = searchFaq(PANEL_FAQ, query, active);

  return (
    <div className="flex flex-col gap-3">
      <HelpSearchBar value={query} onChange={setQuery} />
      <CategoryChips categories={PANEL_CATEGORIES} active={active} onToggle={toggle} />
      <FaqAccordion entries={results} />
    </div>
  );
}
```

Note: `FaqPanel` no longer renders its own "Често задавани въпроси" `<h2>` — the tab label already says that, an inner heading would be redundant.

- [ ] **Step 4: Verify it builds**

Run: `pnpm --filter @fermeribg/web build`
Expected: build succeeds, no type errors, no unused-import warnings (all of `HelpSearchBar`, `CategoryChips`, `FaqAccordion`, `AskAiBox`, `HelpTabs`, `searchFaq`, `PANEL_FAQ`, `PANEL_CATEGORIES`, `askHelpAi` are still used).

- [ ] **Step 5: Commit**

```bash
git add "client/src/app/(admin)/help/page.tsx"
git commit -m "feat(client): split Help page into Ръководство/ЧЗВ/AI tabs"
```

---

## Task 4: Wire `HelpTabs` into dostavki (`delivery-web`)

**Files:**
- Modify: `delivery-web/src/components/help-client.tsx`

- [ ] **Step 1: Update the `@fermeribg/help-ui` import**

Current line 9:
```typescript
import { HelpSearchBar, CategoryChips, FaqAccordion, AskAiBox } from '@fermeribg/help-ui';
```

Replace with:
```typescript
import { HelpSearchBar, CategoryChips, FaqAccordion, AskAiBox, HelpTabs } from '@fermeribg/help-ui';
```

- [ ] **Step 2: Simplify `FaqExplorer` — drop the `AskAiBox` it currently renders**

Current:
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

Replace with:
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
    </div>
  );
}
```

- [ ] **Step 3: Rename `TOC` to `GUIDE_TOC` and drop the FAQ entry**

Current:
```tsx
const TOC = [
  { href: '#overview', label: 'Как работи' },
  { href: '#econt', label: 'Econt акаунт' },
  { href: '#speedy', label: 'Speedy акаунт' },
  { href: '#import', label: 'Внос на пратки' },
  { href: '#handover', label: 'Предаване' },
  { href: '#cod', label: 'Проверка на клиент' },
  { href: '#faq', label: 'Въпроси' },
];
```

Replace with:
```tsx
const GUIDE_TOC = [
  { href: '#overview', label: 'Как работи' },
  { href: '#econt', label: 'Econt акаунт' },
  { href: '#speedy', label: 'Speedy акаунт' },
  { href: '#import', label: 'Внос на пратки' },
  { href: '#handover', label: 'Предаване' },
  { href: '#cod', label: 'Проверка на клиент' },
];
```

- [ ] **Step 4: Restructure `HelpClient()` around `HelpTabs`**

Current (the entire `HelpClient` function body):
```tsx
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
              { icon: Truck, t: 'Пратки', d: 'Поръчки от магазина чакат тук като чернови. Създаваш товарителница, сваляш етикет и предаваш — сам до офис или с куриер до адреса ти.' },
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
                Пиши на <ExtLink href="mailto:api.registration@speedy.bg">api.registration@speedy.bg</ExtLink> за <b>API потребител и парола</b> (за проба поискай тестов акаунт).
                Документация: <ExtLink href="https://api.speedy.bg/web-api.html">api.speedy.bg</ExtLink>.
              </Step>
              <Step n={3} title="Въведи данните в „Настройки“">
                „Настройки" → карта <b>Speedy</b>: <b>Среда</b>, <b>Потребител</b> (API user) и <b>Парола</b>. Това е всичко —
                услугата за доставка е настроена по подразбиране.
              </Step>
            </div>
            <div className="flex flex-col gap-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
              <BrowserMock url="api.speedy.bg" fields={['API потребител', 'Парола']} highlight={0} button="API достъп" />
              <HelpShot src="/help/speedy-api-user.png" alt="Speedy API потребител" caption="Снимка: API данни (добави при желание)" />
            </div>
          </div>
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
        <Section id="handover" icon={Truck} tone="bg-ff-green-50 text-ff-green-700" title="Предаване на пратки"
          intro="Щом товарителницата е готова, я предаваш по един от два начина — ти решаваш за всяка партида.">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
              <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-ink">
                <Download size={17} className="text-ff-green-700" /> Принтираш и занасяш
              </div>
              <p className="mt-1 text-[12.5px] leading-snug text-ff-muted">
                Сваляш етикета (бутон „Свали етикет" на екран „Пратки"), лепиш го на кашона и сам го носиш до офис на куриера — или го даваш на минаващ куриер. Без чакане.
              </p>
            </div>
            <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
              <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-ink">
                <Truck size={17} className="text-ff-green-700" /> Заявяваш куриер да вземе
              </div>
              <p className="mt-1 text-[12.5px] leading-snug text-ff-muted">
                На екран „Пратки" маркираш готовите пратки (чекбоксове) и натискаш „Заяви куриер да вземе". Куриерът минава и ги взема от адреса ти — не ставаш от фермата.
              </p>
            </div>
          </div>
          <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
            <Callout tone="info" title="Кое да избера?">
              Зависи от теб и деня. При 1–2 пратки често е по-бързо да отскочиш до офиса, особено ако бездруго минаваш натам. Съберат ли се повече (горе-долу от 3–4 нагоре) или офисът е далеч — заявката за куриер обикновено си струва.
            </Callout>
            <Callout tone="tip" title="Поръчки от магазина идват тук готови">
              Когато клиент избере „Куриер" в магазина ти, поръчката се появява на екран „Пратки" като <b>чернова</b>. Избираш куриер и натискаш „Създай товарителница" — после я предаваш по един от двата начина горе. Преди това бутонът <b>„Детайли"</b> отваря тегло, брой колети, съдържание и обявена стойност (застраховка) — всяко поле с кратко обяснение; празно = по подразбиране от фермата.
            </Callout>
          </div>
          <div className="mt-4">
            <Callout tone="tip" title="Клиентът следи пратката сам">
              Щом пратката тръгне, клиентът автоматично получава имейл с линк за проследяване — и за Еконт, и за Speedy. По-малко обаждания „къде ми е поръчката". Номерът на товарителницата в таблицата също е линк към проследяването.
            </Callout>
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
          <FaqExplorer />
        </Section>

        {/* ---------------------------------------------------------------- */}
        <section className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
          <div className="flex items-center gap-2.5"><Mail size={18} className="text-ff-green-700" /><h2 className="font-display text-[16px] font-extrabold">Нужда от още помощ?</h2></div>
          <div className="mt-2 grid gap-2 text-[13px] text-ff-ink-2 sm:grid-cols-2">
            <p>Econt интеграция: <ExtLink href="mailto:support_integrations@econt.com">support_integrations@econt.com</ExtLink></p>
            <p>Speedy API: <ExtLink href="mailto:api.registration@speedy.bg">api.registration@speedy.bg</ExtLink></p>
          </div>
        </section>
      </div>
    </div>
  );
}
```

Replace with:
```tsx
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

      <div className="mt-5">
        <HelpTabs
          guide={
            <div className="flex flex-col gap-5">
              {/* quick nav */}
              <nav className="flex flex-wrap gap-2">
                {GUIDE_TOC.map((t) => (
                  <a key={t.href} href={t.href} className="rounded-full border border-ff-border bg-ff-surface px-3 py-1.5 text-[12.5px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2">{t.label}</a>
                ))}
              </nav>

              {/* ---------------------------------------------------------------- */}
              <Section id="overview" icon={Truck} tone="bg-ff-green-50 text-ff-green-700" title="Как работи доставката"
                intro="Панелът има четири екрана. Свързваш куриерски акаунт веднъж, после само качваш файл и пускаш пратки.">
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { icon: SettingsIcon, t: 'Настройки', d: 'Свържи Econt и/или Speedy акаунт. Прави се веднъж.' },
                    { icon: FileSpreadsheet, t: 'Внос', d: 'Качваш Excel/CSV, поправяш редовете, избираш най-евтиния куриер и създаваш пратките.' },
                    { icon: Truck, t: 'Пратки', d: 'Поръчки от магазина чакат тук като чернови. Създаваш товарителница, сваляш етикет и предаваш — сам до офис или с куриер до адреса ти.' },
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
                      Пиши на <ExtLink href="mailto:api.registration@speedy.bg">api.registration@speedy.bg</ExtLink> за <b>API потребител и парола</b> (за проба поискай тестов акаунт).
                      Документация: <ExtLink href="https://api.speedy.bg/web-api.html">api.speedy.bg</ExtLink>.
                    </Step>
                    <Step n={3} title="Въведи данните в „Настройки“">
                      „Настройки" → карта <b>Speedy</b>: <b>Среда</b>, <b>Потребител</b> (API user) и <b>Парола</b>. Това е всичко —
                      услугата за доставка е настроена по подразбиране.
                    </Step>
                  </div>
                  <div className="flex flex-col gap-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
                    <BrowserMock url="api.speedy.bg" fields={['API потребител', 'Парола']} highlight={0} button="API достъп" />
                    <HelpShot src="/help/speedy-api-user.png" alt="Speedy API потребител" caption="Снимка: API данни (добави при желание)" />
                  </div>
                </div>
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
              <Section id="handover" icon={Truck} tone="bg-ff-green-50 text-ff-green-700" title="Предаване на пратки"
                intro="Щом товарителницата е готова, я предаваш по един от два начина — ти решаваш за всяка партида.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                    <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-ink">
                      <Download size={17} className="text-ff-green-700" /> Принтираш и занасяш
                    </div>
                    <p className="mt-1 text-[12.5px] leading-snug text-ff-muted">
                      Сваляш етикета (бутон „Свали етикет" на екран „Пратки"), лепиш го на кашона и сам го носиш до офис на куриера — или го даваш на минаващ куриер. Без чакане.
                    </p>
                  </div>
                  <div className="rounded-xl border border-ff-border bg-ff-surface-2 p-3.5">
                    <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-ink">
                      <Truck size={17} className="text-ff-green-700" /> Заявяваш куриер да вземе
                    </div>
                    <p className="mt-1 text-[12.5px] leading-snug text-ff-muted">
                      На екран „Пратки" маркираш готовите пратки (чекбоксове) и натискаш „Заяви куриер да вземе". Куриерът минава и ги взема от адреса ти — не ставаш от фермата.
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
                  <Callout tone="info" title="Кое да избера?">
                    Зависи от теб и деня. При 1–2 пратки често е по-бързо да отскочиш до офиса, особено ако бездруго минаваш натам. Съберат ли се повече (горе-долу от 3–4 нагоре) или офисът е далеч — заявката за куриер обикновено си струва.
                  </Callout>
                  <Callout tone="tip" title="Поръчки от магазина идват тук готови">
                    Когато клиент избере „Куриер" в магазина ти, поръчката се появява на екран „Пратки" като <b>чернова</b>. Избираш куриер и натискаш „Създай товарителница" — после я предаваш по един от двата начина горе. Преди това бутонът <b>„Детайли"</b> отваря тегло, брой колети, съдържание и обявена стойност (застраховка) — всяко поле с кратко обяснение; празно = по подразбиране от фермата.
                  </Callout>
                </div>
                <div className="mt-4">
                  <Callout tone="tip" title="Клиентът следи пратката сам">
                    Щом пратката тръгне, клиентът автоматично получава имейл с линк за проследяване — и за Еконт, и за Speedy. По-малко обаждания „къде ми е поръчката". Номерът на товарителницата в таблицата също е линк към проследяването.
                  </Callout>
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
            </div>
          }
          faq={<FaqExplorer />}
          ai={<AskAiBox onAsk={(q) => askHelpAi(q).then((r) => r.answer)} />}
        />

        {/* ---------------------------------------------------------------- */}
        <section className="mt-5 rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
          <div className="flex items-center gap-2.5"><Mail size={18} className="text-ff-green-700" /><h2 className="font-display text-[16px] font-extrabold">Нужда от още помощ?</h2></div>
          <div className="mt-2 grid gap-2 text-[13px] text-ff-ink-2 sm:grid-cols-2">
            <p>Econt интеграция: <ExtLink href="mailto:support_integrations@econt.com">support_integrations@econt.com</ExtLink></p>
            <p>Speedy API: <ExtLink href="mailto:api.registration@speedy.bg">api.registration@speedy.bg</ExtLink></p>
          </div>
        </section>
      </div>
    </div>
  );
}
```

Notes for the implementer:
- The `<Section id="faq" icon={Info} ...><FaqExplorer /></Section>` wrapper is intentionally dropped — `FaqExplorer` now goes directly into `HelpTabs`'s `faq` slot, and the tab label already provides the "Често задавани въпроси" heading, so the extra `<Section>` icon/title wrapper would be redundant.
- The closing "Нужда от още помощ?" contact section is intentionally moved to sit *outside* `HelpTabs` (still inside the outer `<div className="mt-5">`), so it stays visible regardless of which tab is active — it's general contact info, not specific to the walkthrough.
- `Info` (the lucide icon) stays imported — it's still used inside the `Callout` component's `info` tone (`Icon: Info`), just no longer for the FAQ `<Section>` icon.
- Double-check no other reference to `TOC` (the old const name) remains after the rename to `GUIDE_TOC`.

- [ ] **Step 5: Verify it builds**

Run: `pnpm --filter @fermeribg/delivery-web build`
Expected: build succeeds, no type errors, no unused-import/unused-variable lint failures.

- [ ] **Step 6: Commit**

```bash
git add delivery-web/src/components/help-client.tsx
git commit -m "feat(delivery-web): split Help page into Ръководство/ЧЗВ/AI tabs"
```

---

## Task 5: Full workspace verification

**Files:** none (verification only)

- [ ] **Step 1: Full monorepo build**

Run: `pnpm build`
Expected: `turbo run build` succeeds for every package, including `help-ui`, `web` (client), and `delivery-web`.

- [ ] **Step 2: help-ui build sanity check**

Run: `pnpm --filter @fermeribg/help-ui build`
Expected: PASS, `dist/HelpTabs.js`/`.d.ts` present alongside the other 4 components.

- [ ] **Step 3: Manual smoke test — both Help pages**

In each app's dev server (`client` on port 3000, `delivery-web` on port 3009 — see `.claude/launch.json`), navigate to `/help` and confirm:
- Three tabs render: "Ръководство", "Често задавани въпроси", "Питай AI" — "Ръководство" active by default.
- Clicking each tab switches content instantly, active tab shows the green underline.
- "Ръководство" tab shows the exact same walkthrough content as before (client: all `SECTIONS` accordion items; delivery-web: overview/econt/speedy/import/handover/cod sections + their quick-nav).
- "Често задавани въпроси" tab shows the search bar, category chips, and FAQ accordion (no AI box here anymore).
- "Питай AI" tab shows the `AskAiBox` header + input, no chat bubbles yet (nothing submitted).
- Submitting a question: the question appears as a green bubble on the right, immediately followed by a typing-dots + skeleton-lines bubble on the left; once the request resolves, the skeleton is replaced by either the AI's answer (green-ish `ff-surface-2` bubble) or — if `OPENAI_API_KEY` isn't set locally — a red-tinted error bubble with the "AI помощникът не е достъпен..." message.
- The input is disabled while the request is in flight and re-enables after.
- No console errors in any tab.

- [ ] **Step 4: Final commit (only if any cleanup was needed)**

```bash
git add -A
git commit -m "chore: help hub tabs redesign cleanup"
```

(Skip this step if Tasks 1-4 already left a clean working tree.)
