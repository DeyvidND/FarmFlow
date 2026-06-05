import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  STRIPE_SECRET_KEY: Joi.string().optional().allow(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  // Storefront origin for Stripe success/cancel redirect URLs.
  STOREFRONT_URL: Joi.string().default('http://localhost:3003'),
  // Platform commission on each storefront order, in basis points (100 = 1%).
  // 0 = no application fee (the farm keeps 100%). Applied as Stripe
  // `application_fee_amount` on the connected-account direct charge.
  STRIPE_PLATFORM_FEE_BPS: Joi.number().min(0).max(10000).default(0),
  // Country for Express connected accounts created via the onboarding flow.
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
  // Max multipart upload size in MB (per file; 1 file/request).
  MAX_UPLOAD_MB: Joi.number().default(8),
  // Email / SMTP (all optional — app boots without them)
  SMTP_HOST: Joi.string().optional().allow(''),
  SMTP_PORT: Joi.number().default(587),
  SMTP_USER: Joi.string().optional().allow(''),
  SMTP_PASS: Joi.string().optional().allow(''),
  SMTP_FROM: Joi.string().optional().allow(''),
  MAIL_PREVIEW_DIR: Joi.string().optional().allow(''),
  // Separate from-addresses + SES configuration sets per reputation lane.
  // Keep transactional (resets/digests) isolated from bulk (newsletters).
  EMAIL_TRANSACTIONAL_FROM: Joi.string().optional().allow(''),
  EMAIL_BULK_FROM: Joi.string().optional().allow(''),
  SES_CONFIG_SET_TRANSACTIONAL: Joi.string().optional().allow(''),
  SES_CONFIG_SET_BULK: Joi.string().optional().allow(''),
  // Shared secret guarding the SES/SNS bounce-complaint webhook (?secret=).
  EMAIL_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  // Newsletter "push" billing + abuse cap.
  EMAIL_PUSH_MAX_RECIPIENTS: Joi.number().default(5000),
  EMAIL_PUSH_PRICE_STOTINKI: Joi.number().default(200),
  PUBLIC_APP_URL: Joi.string().default('http://localhost:3000'),
  // Public origin of THIS API — used to build links the API itself serves
  // (e.g. the newsletter unsubscribe page). Defaults to the dev API port.
  API_PUBLIC_URL: Joi.string().default('http://localhost:3001'),
});
