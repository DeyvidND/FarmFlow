# Email setup (Amazon SES)

FarmFlow sends two kinds of mail on **one shared sending domain** (`farmsteadflow.com`):

- **transactional** — password resets, onboarding, daily digests (critical, must land)
- **bulk** — newsletter "pushes" to a farm's subscribers (the €2-per-push feature)

They ride **separate SES configuration sets** so a marketing reputation hit can never take down password resets. No code change is needed to connect — just env + DNS.

Region: **eu-central-1** (Frankfurt). DNS is managed in **Cloudflare**.

## 1. Verify the sending domain in SES (eu-central-1)
1. SES → **Verified identities** → create identity → **Domain** → `farmsteadflow.com`.
2. Add the **3 DKIM CNAME** records SES gives you to Cloudflare DNS (set them **DNS only / grey cloud** — never proxy DKIM/mail records).
3. **SPF** — TXT on `farmsteadflow.com`:
   ```
   v=spf1 include:amazonses.com ~all
   ```
   ⚠️ The domain **also runs Cloudflare Email Routing** for inbound `hello@farmsteadflow.com`. There must be exactly **one** SPF record, and enabling Email Routing rewrites it. Keep both includes merged:
   ```
   v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net ~all
   ```
4. **DMARC** — TXT on `_dmarc.farmsteadflow.com`:
   ```
   v=DMARC1; p=none; rua=mailto:dmarc@farmsteadflow.com
   ```
5. **Request production access** (SES starts in sandbox — can only send to verified addresses). While in sandbox, verify a recipient identity to test end-to-end.

## 2. Two configuration sets (reputation isolation + events)
SES → **Configuration sets** → create two: `farmsteadflow-transactional` and `farmsteadflow-bulk`.
On **each**, add an **event destination** → **SNS topic** for `Bounce` + `Complaint` (one topic is fine).

## 3. Point the SNS topic at the webhook
SNS topic → **Create subscription** → protocol **HTTPS** → endpoint:
```
https://<api-host>/email/webhook?secret=<EMAIL_WEBHOOK_SECRET>
```
The app **verifies the SNS message signature** against AWS's signing certificate
(`EMAIL_SNS_VERIFY=true`, default) before acting on anything — forged
bounce/complaint events and SSRF via `SubscribeURL` are rejected. The `?secret=`
is an additional cheap gate. On a valid message it auto-confirms the subscription
and auto-suppresses every bounced/complained address (`email_suppressions` table);
those are skipped on all future sends.

For local testing without real AWS-signed messages, set `EMAIL_SNS_VERIFY=false`.

## 4. SMTP credentials
SES → **SMTP settings** → create SMTP credentials (an IAM SMTP user). Host is
`email-smtp.eu-central-1.amazonaws.com`, port 587.

## 5. Env (`.env`)
```
SMTP_HOST=email-smtp.eu-central-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=<SES SMTP username>
SMTP_PASS=<SES SMTP password>
EMAIL_TRANSACTIONAL_FROM=FarmFlow <no-reply@farmsteadflow.com>
EMAIL_BULK_FROM=FarmFlow Новини <news@farmsteadflow.com>
SES_CONFIG_SET_TRANSACTIONAL=farmsteadflow-transactional
SES_CONFIG_SET_BULK=farmsteadflow-bulk
EMAIL_WEBHOOK_SECRET=<random string, also in the SNS URL>
EMAIL_SNS_VERIFY=true              # verify SNS signatures (recommended)
EMAIL_PUSH_MAX_RECIPIENTS=5000     # reject a push above this
EMAIL_PUSH_PRICE_STOTINKI=200      # €2 per push
```
Leave `SMTP_HOST` empty → dev mode (writes `.mail-preview/*.html`, sends nothing).

The domain identity covers every `@farmsteadflow.com` address, so no per-address
verification is needed for sending. `hello@farmsteadflow.com` is the **inbound**
contact address (Cloudflare Email Routing → forwarded inbox); the app sends *from*
`no-reply@` / `news@`.

## Notes
- Margin: SES ≈ $0.10 / 1,000 emails → flat €2/push stays profitable up to ~20k recipients (hence the cap).
- All farms send from the one shared domain — farmers configure nothing. (No per-farm domains by design.)
