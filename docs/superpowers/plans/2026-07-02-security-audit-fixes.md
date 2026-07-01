# Security Audit Fixes (2026-07-02) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open findings from the 2026-07-02 security audit: bump vulnerable server deps, make the delivery SSO handoff token single-use, and host-restrict the Econt label fetch.

**Architecture:** Two tracks. **Track A (this plan)** = deterministic, low-blast-radius server fixes: pnpm override bumps, nodemailer major bump, handoff replay protection via Redis once-only key, Econt label URL host allowlist. **Track B (separate plan, not executed here)** = Next.js 14 → 15 major upgrade across `admin`/`client`/`delivery-web`; scoped checklist at the end.

**Tech Stack:** NestJS 10 + Drizzle + ioredis (server), pnpm workspace overrides, Jest.

---

## File Structure

- `package.json` (repo root) — pnpm `overrides` block: bump `multer` floor to the patched `>=2.2.0`.
- `server/package.json` — bump `nodemailer` to `^9.0.1`.
- `server/src/modules/auth/auth.service.ts` — inject Redis; add `jwtid` on mint; enforce single-use on exchange.
- `server/src/modules/auth/auth.service.spec.ts` — tests for single-use handoff.
- `server/src/modules/econt/econt-label-url.ts` (new) — pure host-allowlist helper.
- `server/src/modules/econt/econt-label-url.spec.ts` (new) — helper tests.
- `server/src/modules/econt/econt.service.ts` — call the allowlist before `fetchLabelPdf`.
- `docs/SECURITY.md` — record the accepted-risk deps (lodash, esbuild-dev) so the next audit doesn't re-litigate them.

---

## Track A

### Task 1: Bump `multer` override to the patched version

The root `pnpm.overrides` already pins `"multer": ">=2.1.1"`, but the DoS fix (GHSA — deeply-nested field names) landed in `2.2.0`. Raise the floor.

**Files:**
- Modify: `package.json` (root, `pnpm.overrides`)

- [ ] **Step 1: Edit the override**

In `package.json`, change the multer line inside `pnpm.overrides` from:

```json
      "multer": ">=2.1.1",
```

to:

```json
      "multer": ">=2.2.0",
```

- [ ] **Step 2: Re-resolve the lockfile**

Run: `pnpm install`
Expected: completes; `pnpm-lock.yaml` changes.

- [ ] **Step 3: Verify the resolved version is patched**

Run: `pnpm why multer`
Expected: every resolved `multer` is `2.2.0` or higher (no `2.1.x` remaining).

- [ ] **Step 4: Confirm it dropped out of the audit**

Run: `pnpm audit --prod`
Expected: the `multer` HIGH advisory no longer appears.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "fix(deps): bump multer override to patched >=2.2.0 (nested-field DoS)"
```

---

### Task 2: Bump `nodemailer` to v9

Server dep `nodemailer@^8.0.10` is affected by GHSA-p6gq-j5cr-w38f (message-level `raw` bypasses `disableFileAccess`/`disableUrlAccess`). The app never passes a user-controlled `raw`, so this is defense-in-depth; the fix is `>=9.0.1`. v9 is a major bump — the email path must still build and its spec must pass.

**Files:**
- Modify: `server/package.json`
- Test: `server/src/common/email/email.service.spec.ts` (existing — run, don't rewrite)

- [ ] **Step 1: Bump the dependency**

In `server/package.json`, change:

```json
    "nodemailer": "^8.0.10",
```

to:

```json
    "nodemailer": "^9.0.1",
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: resolves `nodemailer@9.x`. If `@types/nodemailer` is a devDependency and its peer complains, bump it to the matching major in the same edit and re-run.

- [ ] **Step 3: Typecheck the server**

Run: `pnpm --filter @fermeribg/api build`
Expected: builds clean. The only call surface is `nodemailer.createTransport({...})` in `server/src/common/email/email.service.ts:99` with standard SMTP options (host/port/secure/auth/pool/connectionTimeout) — all unchanged in v9. If a type error surfaces, fix it against the v9 `TransportOptions` type and note it in the commit body.

- [ ] **Step 4: Run the email spec**

Run: `pnpm --filter @fermeribg/api test -- email.service`
Expected: PASS.

- [ ] **Step 5: Confirm the advisory is gone**

Run: `pnpm audit --prod`
Expected: the `nodemailer` HIGH advisory no longer appears.

- [ ] **Step 6: Commit**

```bash
git add server/package.json pnpm-lock.yaml
git commit -m "fix(deps): bump nodemailer to v9 (raw-option file-read/SSRF, GHSA-p6gq-j5cr-w38f)"
```

---

### Task 3: Make the delivery SSO handoff token single-use

`issueDeliveryHandoff` mints a 120s handoff token; `handoffLogin` exchanges it. Today the same token works repeatedly inside its TTL — if the `?handoff=` URL leaks (history, referrer, logs), it can be replayed. Add a per-token id (`jti`) at mint time and a Redis once-only claim at exchange time so the second exchange fails.

`RedisModule` is `@Global()` and exports `REDIS_TOKEN`, so `AuthService` can inject it directly.

**Files:**
- Modify: `server/src/modules/auth/auth.service.ts`
- Test: `server/src/modules/auth/auth.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/modules/auth/auth.service.spec.ts`. This assumes the suite already constructs an `AuthService`; mirror its existing setup and pass a fake Redis whose `set` returns `'OK'` the first time and `null` the second (NX semantics). Adjust the constructor arg order to match the file after Step 2/3.

```ts
describe('handoffLogin single-use', () => {
  it('rejects a second exchange of the same handoff token', async () => {
    const jti = 'jti-123';
    const redisSet = jest
      .fn<Promise<string | null>, unknown[]>()
      .mockResolvedValueOnce('OK') // first claim wins
      .mockResolvedValueOnce(null); // replay: key already exists
    const redis = { set: redisSet } as any;

    const user = {
      id: 'u1', tenantId: 't1', role: 'admin',
      mustChangePassword: false, tokenVersion: 0, farmerId: null,
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => [user] }) }) }),
    } as any;
    // pkg gate returns an active tenant on the second select
    const tenantRow = { pkg: true };
    let call = 0;
    db.select = () => ({
      from: () => ({ where: () => ({ limit: () => (call++ === 0 ? [user] : [tenantRow]) }) }),
    });

    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1', tid: 't1', type: 'delivery-handoff', jti }),
    } as any;

    const svc = new AuthService(db, jwt, { getOrThrow: () => 'secret' } as any, {} as any, redis);
    (svc as any).sign = jest.fn().mockReturnValue({ accessToken: 'real' });

    await expect(svc.handoffLogin('tok')).resolves.toEqual({ accessToken: 'real' });
    await expect(svc.handoffLogin('tok')).rejects.toThrow(); // replay blocked

    expect(redisSet).toHaveBeenCalledWith('handoff:used:jti-123', '1', 'PX', 130_000, 'NX');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- auth.service`
Expected: FAIL — `AuthService` constructor takes 4 args, not 5 (`redis` undefined), so `redis.set` throws / the replay isn't blocked.

- [ ] **Step 3: Inject Redis and add the imports**

In `server/src/modules/auth/auth.service.ts`, add to the top imports:

```ts
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';
```

(`createHash` is already imported from `crypto`; extend that line to also import `randomUUID`, or add the separate import above — either compiles.)

Extend the constructor:

```ts
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}
```

- [ ] **Step 4: Stamp a `jti` when minting**

In `issueDeliveryHandoff`, pass a `jwtid` so the token carries a unique id:

```ts
  async issueDeliveryHandoff(userId: string, tenantId: string, farmerId?: string): Promise<{ token: string }> {
    const token = await this.jwt.signAsync(
      { sub: userId, tid: tenantId, ...(farmerId ? { fid: farmerId } : {}), type: 'delivery-handoff' },
      { secret: this.handoffSecret(), expiresIn: '120s', jwtid: randomUUID() },
    );
    return { token };
  }
```

- [ ] **Step 5: Claim the `jti` once on exchange**

In `handoffLogin`, after the payload type/sub validation and before signing the real session, atomically claim the token id. Update the payload type to include `jti`:

```ts
  async handoffLogin(token: string): Promise<{ accessToken: string }> {
    let payload: { sub?: string; tid?: string; fid?: string; type?: string; jti?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.handoffSecret() });
    } catch {
      throw new UnauthorizedException('Връзката е невалидна или изтекла');
    }
    if (payload?.type !== 'delivery-handoff' || !payload.sub || !payload.jti) {
      throw new UnauthorizedException('Връзката е невалидна или изтекла');
    }

    // Single-use: the first exchange claims the token id; a replay finds the key
    // already set (NX → null) and is rejected. TTL outlives the 120s token so the
    // claim can't expire while the token is still technically valid.
    const claimed = await this.redis.set(`handoff:used:${payload.jti}`, '1', 'PX', 130_000, 'NX');
    if (claimed !== 'OK') {
      throw new UnauthorizedException('Връзката вече е използвана');
    }

    const [user] = await this.db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
    if (!user || !user.tenantId) throw new UnauthorizedException();
    const [tenant] = await this.db
      .select({ pkg: tenants.deliveriesPackageEnabled })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId))
      .limit(1);
    if (!tenant?.pkg) throw new ForbiddenException('Пакетът „Доставки" не е активен за този магазин');
    return this.sign(
      user.id, user.tenantId, user.role, user.mustChangePassword, user.tokenVersion, user.farmerId,
    );
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- auth.service`
Expected: PASS, including the new single-use block.

- [ ] **Step 7: Full auth-module regression**

Run: `pnpm --filter @fermeribg/api test -- auth`
Expected: all auth specs PASS (controller/strategy/service). If any pre-existing `AuthService` construction in a spec now fails on the new 5th arg, add a stub `{ set: jest.fn() } as any` — fix those in this task.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/auth/auth.service.ts server/src/modules/auth/auth.service.spec.ts
git commit -m "fix(auth): make delivery SSO handoff token single-use via Redis jti claim"
```

---

### Task 4: Host-restrict the Econt label PDF fetch

`fetchLabelPdf` (`server/src/modules/econt/econt.service.ts`) sends the farm's Basic credentials to whatever URL is stored in `shipments.labelPdfUrl`. That value only ever comes from Econt's API today (`out.pdfURL`), but pinning the host removes a credential-exfil path if a bad row ever lands there. Econt hosts are `ee.econt.com` (prod) and `demo.econt.com` (demo) — allow `*.econt.com` over HTTPS.

**Files:**
- Create: `server/src/modules/econt/econt-label-url.ts`
- Test: `server/src/modules/econt/econt-label-url.spec.ts`
- Modify: `server/src/modules/econt/econt.service.ts`

- [ ] **Step 1: Write the failing helper test**

Create `server/src/modules/econt/econt-label-url.spec.ts`:

```ts
import { isEcontLabelUrl } from './econt-label-url';

describe('isEcontLabelUrl', () => {
  it('allows prod and demo Econt hosts over https', () => {
    expect(isEcontLabelUrl('https://ee.econt.com/services/label/123.pdf')).toBe(true);
    expect(isEcontLabelUrl('https://demo.econt.com/ee/services/label/9.pdf')).toBe(true);
    expect(isEcontLabelUrl('https://econt.com/x.pdf')).toBe(true);
  });

  it('rejects non-econt hosts', () => {
    expect(isEcontLabelUrl('https://evil.example.com/x.pdf')).toBe(false);
    expect(isEcontLabelUrl('https://ee.econt.com.evil.com/x.pdf')).toBe(false);
  });

  it('rejects non-https and garbage', () => {
    expect(isEcontLabelUrl('http://ee.econt.com/x.pdf')).toBe(false);
    expect(isEcontLabelUrl('file:///etc/passwd')).toBe(false);
    expect(isEcontLabelUrl('not a url')).toBe(false);
    expect(isEcontLabelUrl('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- econt-label-url`
Expected: FAIL — `Cannot find module './econt-label-url'`.

- [ ] **Step 3: Write the helper**

Create `server/src/modules/econt/econt-label-url.ts`:

```ts
/**
 * Allowlist for label-PDF fetches. `fetchLabelPdf` attaches the farm's Basic
 * credentials, so the target host must be Econt and nothing else — a stray
 * `shipments.labelPdfUrl` must never be able to exfiltrate those creds.
 * Econt serves labels from ee.econt.com (prod) and demo.econt.com (demo).
 */
export function isEcontLabelUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'econt.com' || host.endsWith('.econt.com');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- econt-label-url`
Expected: PASS.

- [ ] **Step 5: Enforce it in `fetchLabelPdf`**

In `server/src/modules/econt/econt.service.ts`, import the helper near the other local imports:

```ts
import { isEcontLabelUrl } from './econt-label-url';
```

Then guard the fetch. Change the start of `fetchLabelPdf` from:

```ts
  private async fetchLabelPdf(c: ResolvedCreds, url: string): Promise<Buffer> {
    const auth = Buffer.from(`${c.username}:${c.password}`).toString('base64');
```

to:

```ts
  private async fetchLabelPdf(c: ResolvedCreds, url: string): Promise<Buffer> {
    if (!isEcontLabelUrl(url)) {
      throw new BadRequestException('Невалиден адрес на товарителница');
    }
    const auth = Buffer.from(`${c.username}:${c.password}`).toString('base64');
```

(`BadRequestException` is already imported in this file — it's thrown a few lines down.)

- [ ] **Step 6: Run the econt service specs**

Run: `pnpm --filter @fermeribg/api test -- econt`
Expected: PASS. If an existing spec drives `fetchLabelPdf` with a non-econt stub URL, update that stub to an `https://ee.econt.com/...` URL — that's the correct fixture now.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/econt/econt-label-url.ts server/src/modules/econt/econt-label-url.spec.ts server/src/modules/econt/econt.service.ts
git commit -m "fix(econt): host-restrict label PDF fetch to *.econt.com before sending creds"
```

---

### Task 5: Record accepted-risk dependencies

Two audit lines have no safe/available fix and are not reachable; document them so the next audit doesn't re-investigate.

- **lodash** `<=4.17.23` (GHSA-r5fr-rjxr-66jc, `_.template` injection): transitive via `@nestjs/config` and `@nestjs/swagger`; the advisory's "patched `>=4.18.0`" **does not exist on npm** (latest published is `4.17.21`), so there is no override to apply. `_.template` is never called with user input in this codebase → accept.
- **esbuild** `>=0.27.3 <0.28.1` (GHSA-g7r4-m6w7-qqqr): dev-server request smuggling; reached only through `tsx` in build tooling for `admin`/`client`/`delivery-web`, never in a running production process → accept.

**Files:**
- Modify: `docs/SECURITY.md`

- [ ] **Step 1: Append an "Accepted dependency risks (2026-07-02)" section**

Add to `docs/SECURITY.md`:

```markdown
## Accepted dependency risks (reviewed 2026-07-02)

- **lodash `_.template` code injection (GHSA-r5fr-rjxr-66jc)** — transitive via
  `@nestjs/config` / `@nestjs/swagger`. No installable fix (advisory names
  `>=4.18.0`, which is unpublished; latest is `4.17.21`). `_.template` is never
  invoked with user input. Re-check when NestJS drops the lodash dependency.
- **esbuild dev-server request smuggling (GHSA-g7r4-m6w7-qqqr)** — dev/build
  tooling only (`tsx`), never in a production runtime. No action.
```

- [ ] **Step 2: Commit**

```bash
git add docs/SECURITY.md
git commit -m "docs(security): record accepted-risk deps (lodash _.template, esbuild dev)"
```

---

### Task 6: Full server test + build gate

- [ ] **Step 1: Run the whole server suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: all PASS.

- [ ] **Step 2: Build the server**

Run: `pnpm --filter @fermeribg/api build`
Expected: builds clean.

- [ ] **Step 3: Re-audit**

Run: `pnpm audit --prod`
Expected: `multer` and `nodemailer` HIGHs gone; remaining lines are the Next.js set (Track B) plus the two documented accepted-risk deps.

---

## Track B (separate plan — do NOT execute inline): Next.js 14 → 15

`admin`, `client`, and `delivery-web` all run `next@14.2.35` on `react@18.3.1`, which carries five HIGH advisories (RSC DoS ×3, SSRF via WebSocket upgrade, Pages-Router i18n middleware bypass — the last is N/A for App Router). All are patched only in `next >= 15.5.16`. A major-version bump across three SSR apps can break rendering, middleware, `next.config`, image config, and Sentry's Next SDK — it needs per-app build + smoke testing, not a blind edit. Write it as its own plan (`docs/superpowers/plans/YYYY-MM-DD-next-15-upgrade.md`). Scoped checklist to seed that plan:

- [ ] Confirm each app is App Router (not Pages Router) — decides whether the i18n-middleware advisory even applies.
- [ ] Bump `next` to `>=15.5.16` in `admin`, `client`, `delivery-web`; keep React 18 (Next 15 still supports it) unless a peer forces React 19.
- [ ] Verify `@sentry/nextjs@^10` supports Next 15 for each app; bump if its peer range excludes 15.
- [ ] Review each `next.config.mjs` for renamed/removed options (e.g. image `remotePatterns`, `experimental` keys) between 14 and 15.
- [ ] `pnpm --filter <app> build` for all three; fix breaks.
- [ ] Smoke-test SSR: storefront catalog + checkout (`client`), admin panel auth gate, delivery-web `?handoff=` login.
- [ ] `pnpm audit --prod` → the Next HIGH set is gone.

---

## Self-Review

- **Spec coverage:** multer override (T1), nodemailer (T2), handoff single-use (T3), econt host allowlist (T4), lodash/esbuild accepted-risk (T5), regression gate (T6), Next 15 broken out (Track B). All 2026-07-02 findings mapped.
- **Placeholder scan:** none — every code step shows real code and exact commands.
- **Type consistency:** helper is `isEcontLabelUrl` in both T4 steps and the service import; Redis claim key `handoff:used:${jti}` and args `('1','PX',130_000,'NX')` match between the test (T3 S1) and impl (T3 S5); constructor grows to 5 args consistently across S3/S7.
- **Accuracy note:** lodash is deliberately NOT overridden (no published fixed version) — documented instead, so `pnpm install` won't fail on an unresolvable range.
