import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  // Min 32 chars so a weak/short secret can't ship — it signs every auth token
  // and is the base for the derived password-reset / unsubscribe secrets.
  JWT_SECRET: Joi.string().min(32).required(),
  // Only consumed by the empty-DB super-admin bootstrap (packages/db/bootstrap).
  // Declared here so a typo fails validation loudly instead of silently skipping
  // the seed. Optional — an already-seeded DB doesn't need them.
  // `tlds:false` → validate email SHAPE only, not the TLD against the IANA list,
  // so dev/internal admin addresses (e.g. admin@local.test) aren't rejected.
  SUPER_ADMIN_EMAIL: Joi.string().email({ tlds: false }).optional().allow(''),
  // Min 12 chars when set: this seeds the single most-privileged account, so a
  // trivially weak bootstrap password must not ship. Empty is still allowed (it
  // just skips the seed on an already-provisioned DB).
  SUPER_ADMIN_PASSWORD: Joi.string().min(12).optional().allow(''),
  STRIPE_SECRET_KEY: Joi.string().optional().allow(''),
  // Signing secret of the PLATFORM (account) webhook endpoint — verifies SaaS
  // billing events (invoices / subscriptions) raised on the platform account.
  STRIPE_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  // Signing secret of the CONNECT webhook endpoint — verifies order events
  // (direct charges / refunds / account.updated) raised on connected accounts.
  // Stripe delivers platform-account and connected-account events through two
  // SEPARATE endpoints with two SEPARATE secrets, so both must be configured for
  // billing AND order payments to work; the webhook handler tries each secret.
  STRIPE_CONNECT_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  // Storefront origin for Stripe success/cancel redirect URLs.
  STOREFRONT_URL: Joi.string().default('http://localhost:3003'),
  // Platform commission on each storefront order, in basis points (100 = 1%).
  // 0 = no application fee (the farm keeps 100%). Applied as Stripe
  // `application_fee_amount` on the connected-account direct charge.
  STRIPE_PLATFORM_FEE_BPS: Joi.number().min(0).max(10000).default(0),
  // Country for Standard connected accounts created via the onboarding flow.
  STRIPE_CONNECT_COUNTRY: Joi.string().default('BG'),
  R2_ACCOUNT_ID: Joi.string().optional().allow(''),
  R2_ACCESS_KEY_ID: Joi.string().optional().allow(''),
  R2_SECRET_ACCESS_KEY: Joi.string().optional().allow(''),
  R2_BUCKET_NAME: Joi.string().optional().allow(''),
  R2_PUBLIC_URL: Joi.string().optional().allow(''),
  // Symmetric key for encrypting stored third-party secrets (e.g. Econt API
  // password). Optional — without it, Econt credentials can't be saved and the
  // courier integration stays disabled.
  ENCRYPTION_KEY: Joi.string().optional().allow(''),
  PORT: Joi.number().default(3000),
  CORS_ORIGIN: Joi.string().default('http://localhost:3000'),
  // --- Rate limiting / abuse protection ---
  // Global backstop: max requests per client IP per RATE_LIMIT_TTL_MS window.
  // Abuse-prone routes (auth, checkout, reviews, contact) tighten this via @Throttle.
  RATE_LIMIT_DEFAULT: Joi.number().default(300),
  RATE_LIMIT_TTL_MS: Joi.number().default(60_000),
  // Emergency kill switch ('true' disables all throttling).
  RATE_LIMIT_DISABLED: Joi.string().valid('true', 'false').default('false'),
  // Express `trust proxy` for correct client-IP keying. Set to the number of
  // proxy hops in front of the API in production (e.g. 1 behind nginx/Cloudflare).
  TRUST_PROXY: Joi.string().optional().allow(''),
  // Max multipart upload size in MB (per file; 1 file/request). Must be >= the
  // largest per-route limit (article video = 50 MB), since multer caps the stream
  // before the route validator runs.
  MAX_UPLOAD_MB: Joi.number().default(50),
  // Email / SMTP (all optional — app boots without them)
  SMTP_HOST: Joi.string().optional().allow(''),
  SMTP_PORT: Joi.number().default(587),
  SMTP_USER: Joi.string().optional().allow(''),
  SMTP_PASS: Joi.string().optional().allow(''),
  SMTP_FROM: Joi.string().optional().allow(''),
  MAIL_PREVIEW_DIR: Joi.string().optional().allow(''),
  // Separate from-addresses per reputation lane. Keep transactional
  // (resets/digests) isolated from bulk (newsletters) by sending each from its
  // own address (and, if ever needed, a separate Resend sending domain).
  EMAIL_TRANSACTIONAL_FROM: Joi.string().optional().allow(''),
  EMAIL_BULK_FROM: Joi.string().optional().allow(''),
  // Resend webhook signing secret (`whsec_...`, from the webhook's settings).
  // Used to Svix-verify the public bounce/complaint webhook.
  RESEND_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  // Shared secret guarding the bounce-complaint webhook (?secret=).
  EMAIL_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  // Verify the Resend (Svix) signature on the bounce/complaint webhook. Default
  // 'true' (recommended for the public endpoint). Set 'false' only for local
  // testing without real Resend-signed messages.
  EMAIL_WEBHOOK_VERIFY: Joi.string().valid('true', 'false').default('true'),
  // Newsletter "push" abuse cap (recipients in one send).
  EMAIL_PUSH_MAX_RECIPIENTS: Joi.number().default(5000),
  // Per-recipient price in MICRO-euro (1e-6 €). 555 = €0.000555 = Resend cost × 1.5.
  EMAIL_PRICE_PER_RECIPIENT_MICRO: Joi.number().default(555),
  // Resend cost basis per recipient in MICRO-euro (~$0.0004 on the Pro $20/50k plan).
  // Used ONLY for the super-admin margin view — never charges anything.
  EMAIL_COST_PER_RECIPIENT_MICRO: Joi.number().default(370),
  PUBLIC_APP_URL: Joi.string().default('http://localhost:3000'),
  // Public origin of THIS API — used to build links the API itself serves
  // (e.g. the newsletter unsubscribe page). Defaults to the dev API port.
  API_PUBLIC_URL: Joi.string().default('http://localhost:3001'),
  // --- Platform SaaS billing (the platform charges farms via a Stripe subscription). ---
  // Recurring €30/mo Price id created once on the PLATFORM Stripe account. Empty
  // → billing disabled (checkout returns a clear error), like the rest of Stripe.
  STRIPE_BILLING_PRICE_ID: Joi.string().optional().allow(''),
  // Display/estimate only (the real charge is the Stripe price above). €30.00.
  BILLING_BASE_PRICE_STOTINKI: Joi.number().default(3000),
  // Days a farm keeps full access after a failed payment before auto-suspend.
  BILLING_GRACE_DAYS: Joi.number().default(7),
});
