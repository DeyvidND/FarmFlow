# Sender auto-fill + carrier-card connected state (dostavki)

Date: 2026-06-28
Branch base: `main`
Status: design approved (scope + carrier-card addition), ready for implementation plan

## Problem

The dostavki app makes a farmer fill a standalone „Профил на подател" settings page
(Еcont + Speedy sender name/phone/city/office + package + COD) before any waybill can
be created. Almost all of that data we already have (the farm's own contact + the
farm's registered profile inside Еcont/Speedy), so the form is redundant config
burden. Separately, the „Куриерски акаунти" card always shows raw username/password
inputs even after a carrier is connected — no clear „connected" state, no way to
disconnect.

## Goals

1. **Auto-fill the sender** from the farm's own data on carrier connect — zero typing
   for the common case.
2. **Remove the standalone „Профил на подател" page.** The sender becomes a compact
   „Подаваш от: … ✎" strip on the „Пратки"/„Внос" screens with an edit modal.
3. **Carrier-credentials card gets a connected state:** when configured, collapse the
   inputs → „✓ Свързан (потребител X)" + „Промени" / „Премахни" (disconnect).

Scope (locked with user): **one sender per carrier** (no multi-point address book),
no new settings page, package/COD stay defaulted (only under „Разширени" in the modal).

## Architecture

### 1. Backend — auto-seed sender on connect (best-effort, only when empty)

In `EcontService.saveCredentials` and `SpeedyService.saveCredentials`, after the creds
validate + store, derive a default sender **only if `sender` is currently empty** (never
overwrite a farmer's manual choice). Wrapped so a derivation failure never breaks the
connect (the creds save still succeeds).

Derivation precedence:
- **Еcont:** `getClientProfiles` (the farm's own registered Еcont profile → name, phone;
  and a city/office if the profile carries one). Fallback: farm name (tenant name) +
  `settings.contact.phone`; resolve `settings.contact` location → a city via the Еcont
  nomenclature (office mode left for the farmer to pick if no office is known).
- **Speedy:** `slimContractClients` (already exists — the Speedy contract clients →
  name, phone). Fallback: farm name + `settings.contact.phone`.

The derived sender is merged into `settings.delivery.econt.sender` /
`…speedy.sender` (same shape `saveProfile` writes). `passwordEnc` untouched.

A pure helper `deriveSenderFromFarm(tenantName, contact, carrierProfiles)` holds the
precedence logic so it is unit-testable without I/O.

### 2. Backend — disconnect endpoint (new)

`EcontService.disconnect(tenantId)` / `SpeedyService.disconnect(tenantId)`: clear
`username`/`passwordEnc` and set `configured:false` on that carrier's blob (leave any
sender/handling alone), bust the tenant cache. Exposed as `DELETE /shipping/credentials`
(Еcont) and `DELETE /speedy/credentials` (Speedy) on the standalone app
(`EcontStandaloneController` / `SpeedyStandaloneController`), JwtAuthGuard + CurrentTenant.

`saveProfile` already exists and is the endpoint the edit modal calls — no new save route.

### 3. Frontend — remove the page

Delete the `'profile'` section from `delivery-web/src/components/settings-client.tsx`
(nav entry + render) and remove `carrier-profile-section.tsx`. Keep `carriers`,
`checks`, `password`.

### 4. Frontend — sender strip + edit modal

- **`sender-strip.tsx`** (new): for each connected carrier, reads `getEcontConfig` /
  `getSpeedyConfig` and renders a compact line „Подаваш от: <name> · <office|city> ✎".
  If a connected carrier has no usable sender → „⚠ Избери офис на подаване" that opens
  the modal. Mounted at the top of `shipments-client.tsx` („Пратки") and
  `import-client.tsx` („Внос").
- **`sender-modal.tsx`** (new): a trimmed extraction of the old profile card — name +
  phone (prefilled), office/address picker (the existing `SiteAutocomplete` + office
  list logic moves here), and package + COD collapsed under „Разширени". Saves via the
  existing `saveEcontProfile` / `saveSpeedyProfile`, then refreshes the strip.

### 5. Frontend — carrier-credentials card connected state

In the `carriers` section of `settings-client.tsx`, per carrier:
- **Not configured:** username/password inputs + „Свържи" (unchanged).
- **Configured:** collapse the inputs → „✓ Свързан · потребител <username>" + two
  buttons: „Промени" (reveals the inputs to re-enter creds → existing save path) and
  „Премахни" (calls the new disconnect endpoint → confirm → clears creds, card returns
  to the not-configured state). The carrier `config` already returns `username` +
  `configured`; expose `username` to the card if not already.

## Data flow

```
connect creds ──▶ saveCredentials (validate + store)
                      │  └─ best-effort: deriveSender (Еконт/Speedy profile → contact) → sender (if empty)
                      ▼
            carrier config { configured, username, sender }
              │                                   │
   carriers card: ✓ Свързан (username)     SenderStrip: „Подаваш от: …"  ──✎──▶ SenderModal ──▶ saveProfile
              │
         „Премахни" ──▶ DELETE credentials ──▶ configured:false

storefront auto-orders + Внос ──▶ read econt.sender / speedy.sender  (downstream unchanged)
```

## Error handling

- `deriveSender` is best-effort: any carrier-API or contact gap → fall back down the
  precedence chain; if nothing usable → leave `sender` minimal (name = farm) and the
  strip shows the „⚠ избери офис" prompt. Connect never fails on derivation.
- `disconnect` only clears creds; it never touches sender/handling so reconnecting keeps
  the profile.

## Testing

- **Backend unit:** `deriveSenderFromFarm` precedence (carrier profile → contact →
  farm-name-only); auto-seed runs only when sender empty (does NOT overwrite an existing
  sender); `disconnect` clears username/passwordEnc/configured and leaves sender intact.
- **Frontend:** `pnpm -C delivery-web lint` + `build` (no unit runner).
- **Live smoke:** connect Еcont demo creds on a tenant with no sender → sender
  auto-filled from the Еcont profile; carriers card shows „✓ Свързан"; ✎ modal edits +
  persists; „Премахни" disconnects.

## Non-goals

- Multi-point address book (multiple saved pickup points) — single sender per carrier.
- A per-shipment manual create form (none exists; shipments come from orders + import).
- Touching the storefront order → waybill path (it already reads `econt.sender`).
- AI-based address resolution (carrier nomenclature + farm contact cover it).
