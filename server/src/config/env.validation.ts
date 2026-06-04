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
  // Email / SMTP (all optional — app boots without them)
  SMTP_HOST: Joi.string().optional().allow(''),
  SMTP_PORT: Joi.number().default(587),
  SMTP_USER: Joi.string().optional().allow(''),
  SMTP_PASS: Joi.string().optional().allow(''),
  SMTP_FROM: Joi.string().optional().allow(''),
  MAIL_PREVIEW_DIR: Joi.string().optional().allow(''),
  PUBLIC_APP_URL: Joi.string().default('http://localhost:3000'),
  // Public origin of THIS API — used to build links the API itself serves
  // (e.g. the newsletter unsubscribe page). Defaults to the dev API port.
  API_PUBLIC_URL: Joi.string().default('http://localhost:3001'),
});
