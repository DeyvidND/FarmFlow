# Email setup (Amazon SES)

FarmFlow sends two kinds of mail on **one shared sending domain**:

- **transactional** — password resets, onboarding, daily digests (critical, must land)
- **bulk** — newsletter "pushes" to a farm's subscribers (the €2-per-push feature)

They ride **separate SES configuration sets** so a marketing reputation hit can never take down password resets. No code change is needed to connect — just env + DNS.

## 1. Verify the sending domain in SES (eu-central-1)
1. SES → **Verified identities** → create identity → **Domain** → `mail.farmflow.bg` (a subdomain keeps the root domain's reputation clean).
2. Add the **DKIM CNAME** records SES gives you to that domain's DNS.
3. Add **SPF**: TXT on `mail.farmflow.bg` → `v=spf1 include:amazonses.com -all`.
4. Add **DMARC**: TXT on `_dmarc.farmflow.bg` → `v=DMARC1; p=none; rua=mailto:dmarc@farmflow.bg`.
5. **Request production access** (SES starts in sandbox — can only send to verified addresses).

## 2. Two configuration sets (reputation isolation + events)
SES → **Configuration sets** → create two: `farmflow-transactional` and `farmflow-bulk`.
On **each**, add an **event destination** → **SNS topic** for `Bounce` + `Complaint` (one topic is fine).

## 3. Point the SNS topic at the webhook
SNS topic → **Create subscription** → protocol **HTTPS** → endpoint:
```
https://<api-host>/email/webhook?secret=<EMAIL_WEBHOOK_SECRET>
```
The app auto-confirms the subscription and auto-suppresses every bounced/complained address (`email_suppressions` table) — those are skipped on all future sends.

## 4. SMTP credentials
SES → **SMTP settings** → create SMTP credentials (an IAM SMTP user).

## 5. Env (`.env`)
```
SMTP_HOST=email-smtp.eu-central-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=<SES SMTP username>
SMTP_PASS=<SES SMTP password>
EMAIL_TRANSACTIONAL_FROM=FarmFlow <no-reply@mail.farmflow.bg>
EMAIL_BULK_FROM=FarmFlow Новини <news@mail.farmflow.bg>
SES_CONFIG_SET_TRANSACTIONAL=farmflow-transactional
SES_CONFIG_SET_BULK=farmflow-bulk
EMAIL_WEBHOOK_SECRET=<random string, also in the SNS URL>
EMAIL_PUSH_MAX_RECIPIENTS=5000     # reject a push above this
EMAIL_PUSH_PRICE_STOTINKI=200      # €2 per push
```
Leave `SMTP_HOST` empty → dev mode (writes `.mail-preview/*.html`, sends nothing).

## Notes
- Margin: SES ≈ $0.10 / 1,000 emails → flat €2/push stays profitable up to ~20k recipients (hence the cap).
- Hardening TODO: verify the SNS message **signature** (not just the `?secret=`) for a public endpoint.
- All farms send from the one shared domain — farmers configure nothing. (No per-farm domains by design.)
