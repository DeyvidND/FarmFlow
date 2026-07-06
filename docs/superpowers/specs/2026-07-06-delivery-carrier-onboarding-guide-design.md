# Delivery carrier onboarding guide — simpler + visual Econt/Speedy enable steps

Date: 2026-07-06
Surface: `delivery-web` (dostavki panel, port 3009)
Primary file: `delivery-web/src/components/help-client.tsx`

## Problem

The `/help` screen already has step-by-step Econt and Speedy connect guides, but:

1. **Too wordy** for the elder-first farmer audience. The operator pasted a much
   simpler "cheat-sheet" framing (Трябва / Откъде / Взима / Прави) and wants that
   tone.
2. **One instruction is wrong / over-complicated.** The Econt section tells the
   user to email `support_integrations@econt.com` to "request API access." Verified
   against Econt's live developer docs: the **same e-Econt username + password**
   registered at `login.econt.com` works directly as the API credentials (HTTP
   Basic). The email step is **not required** to connect — it is over-complication.
3. **One instruction is stale.** The Econt/Speedy steps say "избери Среда (Демо /
   Реална)". The environment is now **admin-set and read-only** in Settings
   (`EnvRow` in `settings-client.tsx`); the operator never picks it.
4. **Visuals are placeholders.** The three `HelpShot` real-screenshot slots
   (`/public/help/*.png`) are unfilled grey placeholders; the only always-present
   visual is a generic `BrowserMock` SVG.

## Verified source facts (2026-07-06)

- **Econt** — register at `login.econt.com/register` (prod) or
  `login-demo.econt.com/register` (demo). The e-Econt username + password ARE the
  API credentials. Demo test creds: `iasp-dev` / `1Asp-dev`. A business/client
  profile (contract) with Econt is needed to issue real COD товарителници, but the
  login itself is what gets typed here. Source: econt.com/developers/soap-json-api.
- **Speedy** — a **separate API user** (not the website login) is issued by email.
  Write to `api.registration@speedy.bg` with Name, Company, Direct phone; Speedy
  emails back an API username + password (test account on request). Source:
  api.speedy.bg/web-api.html.
- Our Settings fields: Econt = `Потребител` + `Парола`; Speedy = `Потребител`
  (API user) + `Парола`. Environment row is read-only.

## Access constraints (shape the visual approach)

- `/help` is **public** (not in the protected route matcher in `middleware.ts`) →
  can be rendered + screenshotted via preview without login.
- `/settings` and `/import` are **login-gated** → real screenshots require the full
  API stack (:3001) + a seeded session. Heavy/fragile; out of scope for automated
  capture this pass.
- External Econt/Speedy pages require a separately-connected browser.

Conclusion: **the guide must look great and be correct with zero PNGs.** Real
screenshots are an enhancement layered on top, never a gate.

## Approach (approved)

### 1. Content rewrite — simpler + corrected

Rewrite only the `#econt` and `#speedy` `<Section>` blocks. For each carrier:

- A compact **"cheat strip"** mirroring the operator's framing, one row each:
  - Econt: `Трябва` фирмен профил в econt.com · `Откъде` login.econt.com ·
    `Взима` своя потребител + парола · `Прави` въвежда веднъж в Настройки → готово.
  - Speedy: `Трябва` API достъп (не автоматично) · `Откъде` имейл до
    `api.registration@speedy.bg` · `Дава` име, фирма, телефон · `Взима` API
    потребител + парола · `Прави` въвежда веднъж → готово.
- **3 short visual steps** (existing `Step` component), fewer words per step.
- **Remove** the Econt "email support_integrations@econt.com" hard step. Keep a
  small `Callout` note that a business/contract profile is needed for real labels,
  and keep the demo `iasp-dev / 1Asp-dev` note.
- **Remove** "избери Среда (Демо / Реална)" from both; replace with a one-line note
  that the environment is set by the administrator.

### 2. Visual upgrade — robust, not fragile

- Keep the `HelpShot` slots (they auto-show a PNG when dropped, placeholder
  otherwise).
- Replace the generic `BrowserMock` base visual with a **faithful on-brand
  mini-mockup of the actual Настройки card** (a small `SettingsCardMock` SVG/JSX
  that mirrors the real Econt/Speedy card: icon, title, `Потребител` + `Парола`
  fields, green "Запази" button), so the "where you type it" step is crisp,
  theme-aware, and never goes stale. For the external step, a simple labeled
  browser-frame mock of the register page / email request.

### 3. Real screenshots — best-effort, layered

- Run `delivery-web` preview, screenshot the finished `/help` page as proof.
- Attempt to capture the public Econt registration page if a browser is reachable
  → drop as `/public/help/econt-register.png`.
- Update `/public/help/README.md` with the exact remaining shots for the owner to
  drop (their logged-in Econt/Speedy dashboards + our `/import` table), noting these
  are login-gated and must be captured manually.

## Out of scope

- No changes to `settings-client.tsx`, `carrier-onboarding.tsx`, the FAQ/AI tabs,
  or any API/backend.
- No automated capture of login-gated `/settings` or `/import` screens this pass.
- No new npm dependencies.

## Testing / verification

- `pnpm --filter @fermeribg/delivery-web lint` (or tsc) clean.
- Render `/help` via preview; `preview_snapshot` confirms the new Econt/Speedy
  copy and structure; `preview_screenshot` as visual proof.
- Confirm `HelpShot` still degrades to placeholder when a PNG is absent and shows
  the image when present.

## Files touched

- `delivery-web/src/components/help-client.tsx` — rewrite `#econt` + `#speedy`
  sections; add `SettingsCardMock` helper; adjust `GUIDE_TOC` labels if needed.
- `delivery-web/public/help/README.md` — refresh the wanted-screenshot list.
- `delivery-web/public/help/econt-register.png` — added if capture succeeds.
