import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:3000';
const PAZAR = process.env.PAZAR_URL ?? 'http://localhost:4332';
const EMAIL = process.env.E2E_EMAIL ?? 'ivan@ferma-petrovi.bg';
const PASS = process.env.E2E_PASS ?? 'ferma1234';
const PG = process.env.E2E_PG_CONTAINER ?? 'farmflow-postgres-1';
const REDIS = process.env.E2E_REDIS_CONTAINER ?? 'farmflow-redis-1';

// A tall (portrait) photo — the orientation that loses its subject to a blind
// centre crop. Each fixture appends a distinct ?e2e= tag so its card <img> is
// uniquely selectable, and pins a known cover_crop → a known render.
const IMG = 'https://images.unsplash.com/photo-1474722883778-792e7990302f?q=80&w=600&h=1000&fit=crop';
const imgFor = (tag: string) => `${IMG}&e2e=${tag}`;

const FIX = [
  { tag: 'top', crop: '{"x":0.5,"y":0.1,"zoom":2}', y: '10%', transform: 'matrix(2, 0, 0, 2, 0, 0)' },
  { tag: 'bottom', crop: '{"x":0.5,"y":0.9,"zoom":2}', y: '90%', transform: 'matrix(2, 0, 0, 2, 0, 0)' },
  { tag: 'center', crop: null, y: '50%', transform: 'none' },
];

// SQL via stdin (not -c) so values containing $ / quotes (e.g. an argon2 hash) are
// never mangled by the shell.
function psql(sql: string): string {
  return execSync(`docker exec -i ${PG} psql -U fermeribg -d fermeribg -t -A -F"|"`, {
    input: sql,
    encoding: 'utf8',
  }).trim();
}

const SERVER_DIR = join(__dirname, '..', '..', 'server');
/** Hash a password with the app's argon2 (default params), run from the server so its
 *  `argon2` resolves. The hash self-describes its params, so the API verifies it. */
function argon2Hash(pw: string): string {
  return execSync(
    `node -e "require('argon2').hash(process.env.E2E_PW).then(h=>process.stdout.write(h)).catch(e=>{console.error(e);process.exit(1)})"`,
    { cwd: SERVER_DIR, encoding: 'utf8', env: { ...process.env, E2E_PW: pw } },
  ).trim();
}
const flushRedis = () => {
  try {
    execSync(`docker exec ${REDIS} redis-cli FLUSHALL`, { stdio: 'ignore' });
  } catch {
    /* best effort — the storefront cache just expires on its own TTL */
  }
};

let ids: string[] = [];
let backup: { id: string; image: string; crop: string }[] = [];
let origHash = '';

test.beforeAll(() => {
  // The seed password may have been changed since — reset the farm owner to a known
  // password so the UI login is deterministic (restored in afterAll).
  origHash = psql(`SELECT password_hash FROM users WHERE email='${EMAIL}'`);
  psql(
    `UPDATE users SET password_hash='${argon2Hash(PASS)}', must_change_password=false WHERE email='${EMAIL}'`,
  );

  const rows = psql(
    `SELECT p.id, COALESCE(p.image_url,''), COALESCE(p.cover_crop::text,'') ` +
      `FROM products p JOIN users u ON u.tenant_id=p.tenant_id ` +
      `WHERE u.email='${EMAIL}' AND p.is_active=true ORDER BY p.position LIMIT ${FIX.length}`,
  )
    .split('\n')
    .filter(Boolean)
    .map((r) => r.split('|'));

  expect(rows.length, 'seed tenant must have at least 3 active products').toBe(FIX.length);
  ids = rows.map((r) => r[0]);
  backup = rows.map((r) => ({ id: r[0], image: r[1] ?? '', crop: r[2] ?? '' }));

  FIX.forEach((f, i) => {
    const crop = f.crop ? `'${f.crop}'::jsonb` : 'NULL';
    psql(`UPDATE products SET image_url='${imgFor(f.tag)}', cover_crop=${crop} WHERE id='${ids[i]}'`);
  });
  flushRedis(); // chaika reads the Redis-cached public catalog — bust so the seed shows
});

test.afterAll(() => {
  if (origHash) psql(`UPDATE users SET password_hash='${origHash}' WHERE email='${EMAIL}'`);
  backup.forEach((b) => {
    const image = b.image ? `'${b.image}'` : 'NULL';
    const crop = b.crop ? `'${b.crop}'::jsonb` : 'NULL';
    psql(`UPDATE products SET image_url=${image}, cover_crop=${crop} WHERE id='${b.id}'`);
  });
  flushRedis();
});

/** Computed framing (object-position + transform) of a fixture's card image. */
async function frameOf(page: Page, tag: string) {
  const img = page.locator(`img[src*="e2e=${tag}"]`).first();
  await img.waitFor({ state: 'visible' });
  return img.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { objectPosition: cs.objectPosition, transform: cs.transform };
  });
}

test('farmer admin — product cards render the saved cover framing', async ({ page }) => {
  await page.goto(`${ADMIN}/login`);
  await page.locator('input[type=email]').fill(EMAIL);
  await page.locator('input[type=password]').fill(PASS);
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });

  await page.goto(`${ADMIN}/products`);
  for (const f of FIX) {
    const fr = await frameOf(page, f.tag);
    // top → object-position y 10%, bottom → 90%, centre → 50%; zoom 2 → scale matrix.
    expect(fr.objectPosition, `admin ${f.tag} object-position`).toContain(f.y);
    expect(fr.transform, `admin ${f.tag} transform`).toBe(f.transform);
  }
});

test('пазар чайка — product cards render the saved cover framing', async ({ page }) => {
  for (const f of FIX) {
    // chaika's ~30s in-process catalog memo can lag the cache bust — poll-reload.
    await expect
      .poll(
        async () => {
          await page.goto(`${PAZAR}/shop`, { waitUntil: 'networkidle' });
          const img = page.locator(`img[src*="e2e=${f.tag}"]`).first();
          if ((await img.count()) === 0) return '';
          return img.evaluate((el) => getComputedStyle(el).objectPosition);
        },
        {
          message: `chaika ${f.tag} object-position`,
          timeout: 45_000,
          intervals: [2000, 3000, 5000, 5000, 5000, 5000, 5000, 5000, 5000],
        },
      )
      .toContain(f.y);

    const img = page.locator(`img[src*="e2e=${f.tag}"]`).first();
    const transform = await img.evaluate((el) => getComputedStyle(el).transform);
    expect(transform, `chaika ${f.tag} transform`).toBe(f.transform);
  }
});
