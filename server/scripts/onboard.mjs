#!/usr/bin/env node
/**
 * onboard.mjs — one-command client-onboarding skeleton.
 *
 * Pipeline:
 *   1. brand-extract   logo → storefront theme colour + favicon   (deterministic, here)
 *   2. provision       super-admin → create tenant + owner login  (existing API)
 *   3. deploy          build+deploy a storefront for the slug      (infra HOOK — printed)
 *   4. smoke           storefront E2E acceptance                   (puppeteer, here)
 *   5. welcome         login + temp password + getting-started     (packet)
 *
 * The deterministic steps run now; the AI product-import (paste/file → Claude →
 * bulk create) and the deploy/DNS automation are the next plug-ins (see HOOKs).
 *
 * Usage:
 *   node scripts/onboard.mjs \
 *     --farm "Ферма Х" --email ivan@ferma.bg --phone "+359 88 123 4567" \
 *     --logo ./logo.png --api http://localhost:3001 \
 *     --admin-url http://localhost:3000 --store-url http://localhost:4321 [--smoke]
 *
 * Env: PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD (super-admin, to auto-provision).
 *      CHROME_PATH (for the smoke test).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── tiny arg parser ──────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const need = (k) => {
  if (!args[k]) { console.error(`Missing --${k}`); process.exit(1); }
  return args[k];
};

const cfg = {
  farm: need('farm'),
  email: need('email'),
  phone: args.phone ?? '',
  logo: args.logo ?? null,
  api: args.api ?? process.env.API_BASE ?? 'http://localhost:3001',
  adminUrl: args['admin-url'] ?? process.env.PUBLIC_APP_URL ?? 'http://localhost:3000',
  storeUrl: args['store-url'] ?? null,
  smoke: !!args.smoke,
  adminEmail: process.env.PLATFORM_ADMIN_EMAIL,
  adminPassword: process.env.PLATFORM_ADMIN_PASSWORD,
};

const log = (...a) => console.log('•', ...a);
const ok = (...a) => console.log('  ✓', ...a);
const hook = (...a) => console.log('  ⎈ HOOK:', ...a);

// ── 1. brand-extract: logo → accent theme colour + favicon ───────────────────
async function brandExtract(logoPath) {
  if (!logoPath || !fs.existsSync(logoPath)) {
    log('brand: no logo → theme stays default');
    return { themeColor: null, favicon: null };
  }
  // Scan a 48×48 downsample; pick the most vivid (saturated × bright) opaque,
  // non-greyish pixel — a logo's accent, not its white background.
  const { data, info } = await sharp(logoPath)
    .resize(48, 48, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const a = ch === 4 ? data[i + 3] : 255;
    if (a < 200) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const val = max / 255;
    if (val > 0.96 && sat < 0.12) continue; // near-white bg
    if (val < 0.08) continue; // near-black
    const score = sat * 1.4 + val * 0.3; // favour saturation
    if (score > bestScore) { bestScore = score; best = [r, g, b]; }
  }
  const themeColor = best
    ? '#' + best.map((c) => c.toString(16).padStart(2, '0')).join('')
    : null;
  const favicon = path.join(path.dirname(path.resolve(logoPath)), 'favicon.png');
  await sharp(logoPath)
    .resize(64, 64, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toFile(favicon);
  return { themeColor, favicon };
}

// ── 2. provision: super-admin → create tenant + owner ────────────────────────
async function provision({ themeColor }) {
  if (!cfg.adminEmail || !cfg.adminPassword) {
    hook('set PLATFORM_ADMIN_EMAIL + PLATFORM_ADMIN_PASSWORD to auto-provision — skipping');
    return null;
  }
  const loginRes = await fetch(`${cfg.api}/platform/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: cfg.adminEmail, password: cfg.adminPassword }),
  });
  if (!loginRes.ok) throw new Error(`platform login failed (${loginRes.status})`);
  const { accessToken } = await loginRes.json();
  const tempPassword = 'ff-' + Math.random().toString(36).slice(2, 10);
  const res = await fetch(`${cfg.api}/platform/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      farmName: cfg.farm,
      email: cfg.email,
      phone: cfg.phone,
      tempPassword,
      ...(themeColor ? { themeColor } : {}),
    }),
  });
  if (!res.ok) throw new Error(`createTenant failed (${res.status}): ${await res.text()}`);
  return { ...(await res.json()), tempPassword, token: accessToken };
}

// ── 3. AI import: each --*-source → import-products.mjs in platform mode ──────
function runImports(tenant) {
  const jobs = [
    ['products', args['products-source']],
    ['farmers', args['farmers-source']],
    ['categories', args['categories-source']],
    ['contact', args['contact-source']],
  ].filter(([, src]) => src && src !== true);
  if (!jobs.length) { hook('pass --products-source / --farmers-source / --categories-source / --contact-source to auto-import'); return; }
  const script = path.join(__dirname, 'import-products.mjs');
  for (const [t, src] of jobs) {
    log(`import ${t} ← ${src}`);
    const r = spawnSync(process.execPath, [script, '--type', t, '--file', String(src), '--tenant-id', tenant.id, '--apply', '--api', cfg.api], { stdio: 'inherit', env: process.env });
    if (r.status !== 0) hook(`import ${t} exited ${r.status}`);
  }
}

async function applyFavicon(tenantId, token, faviconPath) {
  if (!token) { hook('no platform token — skipping favicon apply'); return; }
  try {
    const b64 = fs.readFileSync(faviconPath).toString('base64');
    const r = await fetch(`${cfg.api}/platform/tenants/${tenantId}/import`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ faviconBase64: b64 }),
    });
    ok(r.ok ? 'favicon applied' : `favicon apply failed (${r.status})`);
  } catch (e) { hook(`favicon apply error: ${e.message}`); }
}

// ── deploy: register the client in the templates factory (clients.json → CI →
//    GHCR → Dokploy). Writing the entry is safe; pushing (which triggers the
//    build/deploy) is gated behind --deploy-push. ──────────────────────────────
function deployStorefront(tenant) {
  const repo = (args['templates-repo'] !== true && args['templates-repo']) || process.env.TEMPLATES_REPO;
  const domain = args.domain !== true && args.domain;
  if (!repo || !domain) { hook('pass --templates-repo <FarmFlow-Templates path> and --domain to register the storefront for deploy'); return; }
  const clientsPath = path.join(repo, 'clients.json');
  let clients;
  try { clients = JSON.parse(fs.readFileSync(clientsPath, 'utf8')); }
  catch { hook(`cannot read ${clientsPath}`); return; }
  clients[tenant.slug] = {
    baseTheme: (args.theme !== true && args.theme) || process.env.PUBLIC_THEME || 'svezho',
    tenantSlug: tenant.slug,
    domain,
    apiBase: (args['public-api'] !== true && args['public-api']) || cfg.api,
    adminUrl: cfg.adminUrl,
  };
  fs.writeFileSync(clientsPath, JSON.stringify(clients, null, 2) + '\n');
  ok(`registered "${tenant.slug}" in clients.json → ${domain}`);
  if (args['deploy-push']) {
    const g = (a) => spawnSync('git', a, { cwd: repo, stdio: 'inherit' });
    g(['add', 'clients.json']);
    g(['commit', '-m', `chore(clients): add ${tenant.slug}`]);
    const r = g(['push']);
    ok(r.status === 0 ? 'pushed → CI builds the image (GHCR), Dokploy deploys' : 'push failed — push FarmFlow-Templates manually to trigger CI');
  } else {
    hook('review clients.json, then push FarmFlow-Templates to trigger the build (or pass --deploy-push)');
  }
}

// ── dns: point the client domain at the storefront via the Cloudflare API. ────
async function dns(domain) {
  const token = process.env.CLOUDFLARE_API_TOKEN, zone = process.env.CLOUDFLARE_ZONE_ID, target = process.env.DEPLOY_TARGET;
  if (!token || !zone || !target) { hook('set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID + DEPLOY_TARGET to auto-create the DNS record'); return; }
  const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'CNAME', name: domain, content: target, proxied: true, ttl: 1 }),
  });
  const b = await r.json().catch(() => ({}));
  if (r.ok && b.success) ok(`DNS: ${domain} → ${target} (CNAME, proxied)`);
  else if ((b.errors ?? []).some((e) => e.code === 81057 || /already exists/i.test(e.message || ''))) ok(`DNS: ${domain} already set`);
  else hook(`DNS create failed: ${JSON.stringify(b.errors ?? b).slice(0, 200)}`);
}

// ── 4. smoke: storefront acceptance (catalog renders + add-to-cart present) ──
async function smoke(storeUrl) {
  if (!storeUrl || !cfg.smoke) { hook('pass --store-url --smoke to run the acceptance E2E — skipping'); return null; }
  let puppeteer;
  try { puppeteer = (await import('puppeteer-core')).default; }
  catch { hook('puppeteer-core not installed here — run the smoke from ff-audit'); return null; }
  const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    const p = await b.newPage();
    await p.goto(storeUrl, { waitUntil: 'networkidle2', timeout: 40000 });
    const r = await p.evaluate(() => ({
      title: document.title,
      products: document.querySelectorAll('[class*="product"]').length,
      addBtns: [...document.querySelectorAll('button')].filter((x) => /Добави/.test(x.textContent || '')).length,
    }));
    return { ...r, pass: r.products > 0 && r.addBtns > 0 };
  } finally {
    await b.close();
  }
}

// ── 5. welcome packet ────────────────────────────────────────────────────────
function welcomePacket(tenant) {
  return [
    '──────── WELCOME PACKET ────────',
    `Ферма:        ${cfg.farm}`,
    `Панел:        ${cfg.adminUrl}/login`,
    `Имейл:        ${tenant?.email ?? cfg.email}`,
    `Парола:       ${tenant?.tempPassword ?? '(зададена при provision)'} (смяна при първо влизане)`,
    `Първи стъпки: ${cfg.adminUrl}/help`,
    '────────────────────────────────',
  ].join('\n');
}

// ── orchestrate ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🌿 Onboarding "${cfg.farm}"\n`);

  log('1/6 brand-extract');
  const brand = await brandExtract(cfg.logo);
  if (brand.themeColor) ok(`theme colour ${brand.themeColor}`);
  if (brand.favicon) ok(`favicon → ${brand.favicon}`);

  log('2/6 provision');
  const tenant = await provision(brand);
  if (tenant) ok(`tenant "${tenant.name}" slug=${tenant.slug}`);

  log('3/6 AI import + brand');
  if (tenant) {
    runImports(tenant);
    if (brand.favicon) await applyFavicon(tenant.id, tenant.token, brand.favicon);
  }

  log('4/6 deploy storefront + DNS');
  if (tenant) {
    deployStorefront(tenant);
    if (args.domain && args.domain !== true) await dns(args.domain);
  }

  log('5/6 smoke');
  const sm = await smoke(cfg.storeUrl);
  if (sm) ok(`smoke ${sm.pass ? 'PASS' : 'FAIL'} — products=${sm.products} add-to-cart=${sm.addBtns}`);

  log('6/6 welcome');
  console.log('\n' + welcomePacket(tenant) + '\n');
  console.log('Done. Review the imported catalog + flip DNS, then go live.\n');
}

main().catch((e) => { console.error('onboard failed:', e.message); process.exit(1); });
