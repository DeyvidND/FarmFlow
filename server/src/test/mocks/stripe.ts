/**
 * Test double for the `stripe` package, wired in via jest `moduleNameMapper`
 * (see `jest.moduleNameMapper` in server/package.json — `^stripe$` maps here).
 *
 * Why this exists: the real Stripe SDK lazily `require()`s its resource modules
 * on first load. Under the FULL parallel jest run that lazy require
 * intermittently fails (a resource-resolution race across workers), flaking
 * whichever Stripe-importing suite loses the race (billing.service.spec /
 * stripe.service.spec, or any suite that transitively imports those services).
 * The failure is a module-load error, not an assertion — the suite is reported
 * `failed` with no failing test.
 *
 * No unit test needs the real client: every BillingService / StripeService test
 * keeps Stripe disabled (no STRIPE_SECRET_KEY → `client` stays null) and the few
 * client paths inject a hand-rolled stub via `(svc as any).client`. Mapping the
 * package to this no-op constructor means the real SDK never loads in tests, so
 * the race can't happen anywhere.
 *
 * Type safety is unaffected: TypeScript resolves `import Stripe from 'stripe'`
 * against the real package types (it ignores jest's `moduleNameMapper`), so the
 * production code is still type-checked against the real Stripe surface — only
 * the runtime module is swapped, and only under jest.
 */
export default class StripeMock {}
