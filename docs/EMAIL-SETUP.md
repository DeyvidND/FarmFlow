# Email setup (Resend)

FarmFlow sends two kinds of mail on **one shared sending domain** (`farmsteadflow.com`):

- **transactional** — password resets, onboarding, daily digests (critical, must land)
- **bulk** — newsletter "pushes" to a farm's subscribers (the €2-per-push feature)

Both go out through Resend over SMTP using FarmFlow's own templates. The lanes are kept apart by from-address (`no-reply@` vs `news@`); if a marketing reputation hit ever threatens transactional mail, point the bulk lane at a separate Resend sending domain. No code change is needed to connect — just env + DNS.

Provider: **Resend**. Free tier: **3,000 emails/month** (100/day), **no credit card**, **no provider logo** in the email (clean branded mail). DNS is managed in **Cloudflare**.

> Why Resend over Amazon SES / Mailgun: SES gates first real sending behind a **production-access review that can take days**. Mailgun dropped its free pay-as-you-go ($15/mo minimum). Resend verifies the domain in minutes, costs €0 on FarmFlow's baseline volume, and unlike Brevo's free tier puts **no "Sent with X" footer** on outgoing mail.

## 1. Add the sending domain in Resend
1. Resend → **Domains → Add Domain** → `farmsteadflow.com`. (Resend uses a `send.` sending subdomain under the hood.)
2. Resend shows DNS records. Add them to Cloudflare as **DNS only / grey cloud** (never proxy mail/DKIM records):
   - **MX** — on `send.farmsteadflow.com` → `feedback-smtp.<region>.amazonses.com` (Resend's bounce/feedback path; it's on a subdomain, so it does **not** clash with Cloudflare Email Routing's MX on the root).
   - **SPF** — `TXT` on `send.farmsteadflow.com`: `v=spf1 include:amazonses.com ~all`. (This is on the `send.` subdomain, separate from the root SPF that Cloudflare Email Routing manages — no merge needed.)
   - **DKIM** — `TXT` (e.g. host `resend._domainkey`) with the key Resend gives you.
3. **DMARC** (recommended) — `TXT` on `_dmarc.farmsteadflow.com`:
   ```
   v=DMARC1; p=none; rua=mailto:dmarc@farmsteadflow.com
   ```
4. Back in Resend, click **Verify**. Usually green within minutes.

> ⚠️ The root domain still runs **Cloudflare Email Routing** for inbound `hello@farmsteadflow.com`. Resend's records live on the `send.` subdomain, so they don't touch the root MX/SPF. Leave Cloudflare Email Routing as-is.

## 2. SMTP credentials
Resend → **API Keys** → create a key (`re_...`). SMTP uses:

- Host: `smtp.resend.com`
- Port: `465` (SSL) — or `587` (STARTTLS)
- Username: literally `resend`
- Password: the API key (`re_...`)

## 3. Bounce/complaint webhook (auto-suppression)
Resend → **Webhooks → Add Endpoint**:

- Endpoint URL:
  ```
  https://<api-host>/email/webhook?secret=<EMAIL_WEBHOOK_SECRET>
  ```
- Subscribe to events: **email.bounced** and **email.complained**.
- Copy the endpoint's **Signing Secret** (`whsec_...`) → `RESEND_WEBHOOK_SECRET`.

Resend signs webhooks with **Svix** (`svix-id` / `svix-timestamp` / `svix-signature` headers). The app verifies the signature over the exact raw body (`EMAIL_WEBHOOK_VERIFY=true`, default) before acting on anything — forged bounce/complaint events are rejected, plus a stale-timestamp replay guard. The `?secret=` is an additional cheap gate. On a valid event it auto-suppresses the affected recipient(s) (`email_suppressions` table); suppressed addresses are skipped on all future sends. (Resend keeps its own server-side suppression too — this mirror lets the app skip them before dialing SMTP.)

For local testing without real Resend-signed messages, set `EMAIL_WEBHOOK_VERIFY=false`.

## 4. Env (`.env`)
```
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=<Resend API key, re_...>
EMAIL_TRANSACTIONAL_FROM=FarmFlow <no-reply@farmsteadflow.com>
EMAIL_BULK_FROM=FarmFlow Новини <news@farmsteadflow.com>
RESEND_WEBHOOK_SECRET=<whsec_... from the webhook endpoint>
EMAIL_WEBHOOK_SECRET=<random string, also in the webhook URL>
EMAIL_WEBHOOK_VERIFY=true            # verify Resend (Svix) signatures (recommended)
EMAIL_PUSH_MAX_RECIPIENTS=5000       # reject a push above this
EMAIL_PUSH_PRICE_STOTINKI=200        # €2 per push
```
Leave `SMTP_HOST` empty → dev mode (writes `.mail-preview/*.html`, sends nothing).

The verified domain covers every `@farmsteadflow.com` address, so no per-address verification is needed for sending. `hello@farmsteadflow.com` is the **inbound** contact address (Cloudflare Email Routing → forwarded inbox); the app sends *from* `no-reply@` / `news@`.

## Notes
- **Cost:** €0 on the free tier (3k/mo, 100/day). Transactional baseline (resets/confirms/digests) sits well under that. A large newsletter blast can exceed the free cap (and the 100/day limit) — that's the paid case, covered by the €2/push billing. If push volume grows, upgrade Resend (Pro from $20/mo) or send bulk through a cheaper metered provider; keep transactional on Resend free.
- **No provider branding:** unlike Brevo's free tier, Resend adds no footer/logo — mail looks fully first-party.
- All farms send from the one shared domain — farmers configure nothing. (No per-farm domains by design.)
