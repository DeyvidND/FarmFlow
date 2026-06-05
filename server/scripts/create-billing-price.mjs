// One-off setup for automated SaaS billing.
//
// Creates (idempotently) the €30/month recurring Stripe Price on your PLATFORM
// Stripe account and prints the id to drop into STRIPE_BILLING_PRICE_ID.
//
// Usage (from the `server/` directory, so `stripe` resolves):
//   STRIPE_SECRET_KEY=sk_live_... node scripts/create-billing-price.mjs
//   # or, on Windows PowerShell:
//   $env:STRIPE_SECRET_KEY="sk_live_..."; node scripts/create-billing-price.mjs
//
// Re-running is safe: it reuses the existing price via the lookup_key.
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
  console.error('✖ STRIPE_SECRET_KEY is not set. Set it and re-run.');
  process.exit(1);
}

// Override the amount with BILLING_BASE_PRICE_STOTINKI if you want a different base.
const amount = Number(process.env.BILLING_BASE_PRICE_STOTINKI ?? 3000); // €30.00
const LOOKUP_KEY = 'farmflow_saas_monthly';
const stripe = new Stripe(key);

async function main() {
  // Reuse an existing price if this script already ran.
  const existing = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], active: true, limit: 1 });
  if (existing.data[0]) {
    const p = existing.data[0];
    console.log(`✓ Price already exists: ${p.id} (${(p.unit_amount ?? 0) / 100} ${p.currency.toUpperCase()}/mo)`);
    console.log(`\nSTRIPE_BILLING_PRICE_ID=${p.id}`);
    return;
  }

  const product = await stripe.products.create({
    name: 'FarmFlow — месечен абонамент',
    description: 'Месечен абонамент за платформата FarmFlow.',
  });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: amount,
    currency: 'eur',
    recurring: { interval: 'month' },
    lookup_key: LOOKUP_KEY,
  });

  console.log(`✓ Created €${amount / 100}/month price: ${price.id}`);
  console.log(`\nAdd this to your .env:\nSTRIPE_BILLING_PRICE_ID=${price.id}`);
}

main().catch((err) => {
  console.error('✖ Failed:', err?.message ?? err);
  process.exit(1);
});
