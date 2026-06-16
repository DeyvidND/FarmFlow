#!/usr/bin/env node
/**
 * import-products.mjs — AI product import (the onboarding time-saver).
 *
 * Messy price list (Excel/CSV paste, OCR of a price board, Facebook post, notes)
 *   → Claude extracts structured products (forced tool call)
 *   → preview (human review gate — prices especially)
 *   → optional bulk-create via the existing tenant Products API.
 *
 * Structured extraction uses the documented Messages REST endpoint with a forced
 * tool call (tool_choice), so Claude must return JSON matching the product schema.
 *
 * Usage:
 *   node scripts/import-products.mjs --file pricelist.txt            # preview only
 *   node scripts/import-products.mjs --file pricelist.txt --apply \
 *     --api http://localhost:3001 --email owner@farm.bg --password '…'
 *   node scripts/import-products.mjs --file pricelist.txt --dry-run  # show the request, no API call
 *
 * Env: ANTHROPIC_API_KEY (required unless --dry-run); ANTHROPIC_MODEL (default claude-opus-4-8).
 */
import fs from 'node:fs';

// ── args ─────────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';
const api = args.api ?? process.env.API_BASE ?? 'http://localhost:3001';
const log = (...a) => console.log('•', ...a);
const ok = (...a) => console.log('  ✓', ...a);

function readInput() {
  if (args.text && args.text !== true) return String(args.text);
  if (args.file && args.file !== true) return fs.readFileSync(args.file, 'utf8');
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8'); // piped stdin
  console.error('Provide --file <path>, --text "…", or pipe text on stdin.');
  process.exit(1);
}

// ── extraction tool (forces JSON shaped like a product) ──────────────────────
const TOOL = {
  name: 'extract_products',
  description: "Record every product found in the farm's price list / catalog text.",
  input_schema: {
    type: 'object',
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Product name in Bulgarian, e.g. "Домати".' },
            priceStotinki: { type: 'integer', description: 'Unit price in stotinki (euro-cents). 6,50 → 650. Multiply a decimal price by 100 and round.' },
            unit: { type: 'string', description: 'Unit of sale: "кг", "бр", "връзка", "литър", "пакет"… Best guess from context; default "бр".' },
            weight: { type: 'string', description: 'Pack size / weight if shown, e.g. "500 г", "1 кг". Empty string if none.' },
            category: { type: 'string', description: 'Section/category if discernible (e.g. "Зеленчуци", "Млечни"). Empty string if unknown.' },
            description: { type: 'string', description: 'Short note if present. Empty string if none.' },
          },
          required: ['name', 'priceStotinki', 'unit', 'weight', 'category', 'description'],
        },
      },
    },
    required: ['products'],
  },
};

const PROMPT = (text) =>
  'Извади ВСЕКИ продукт от ценоразписа на фермера по-долу. Текстът може да е разхвърлян ' +
  '(Excel paste, OCR на табела, Facebook пост, бележки). За всеки продукт дай: име (български), ' +
  'цена в стотинки (числото × 100, напр. 6,50 → 650), мерна единица, разфасовка, категория, описание. ' +
  'Пропусни редове, които не са продукти (заглавия, телефони, адреси, поздрави). ' +
  'Ако цените са в лева вместо евро, пак ги извади — операторът ще ги прегледа. ' +
  'Извикай инструмента extract_products с всички продукти.\n\nЦЕНОРАЗПИС:\n"""\n' + text + '\n"""';

async function extract(text) {
  const body = {
    model: MODEL,
    max_tokens: 8000,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'extract_products' },
    messages: [{ role: 'user', content: PROMPT(text) }],
  };
  if (args['dry-run']) {
    console.log('— DRY RUN — request that would be sent to POST /v1/messages:');
    console.log(JSON.stringify({ ...body, messages: [{ role: 'user', content: PROMPT('…').slice(0, 120) + '…' }] }, null, 2));
    return null;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error('Set ANTHROPIC_API_KEY (or use --dry-run).'); process.exit(1); }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = await res.json();
  const tool = (msg.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'extract_products');
  if (!tool) throw new Error('No extract_products tool call in the response.');
  return tool.input.products ?? [];
}

// ── bulk-create via the tenant Products API ──────────────────────────────────
async function apply(products) {
  let token = args.token && args.token !== true ? args.token : null;
  if (!token && args.email && args.password) {
    const r = await fetch(`${api}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: args.email, password: args.password }),
    });
    if (!r.ok) throw new Error(`login failed (${r.status})`);
    token = (await r.json()).accessToken;
  }
  if (!token) { log('apply: pass --token or --email/--password (owner) — skipping create'); return; }
  let created = 0; const failed = [];
  for (const p of products) {
    const r = await fetch(`${api}/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: p.name,
        priceStotinki: p.priceStotinki,
        unit: p.unit || 'бр',
        ...(p.weight ? { weight: p.weight } : {}),
        ...(p.category ? { category: p.category } : {}),
        ...(p.description ? { description: p.description } : {}),
        isActive: true,
      }),
    });
    if (r.ok) created++;
    else failed.push(`${p.name} (${r.status})`);
  }
  ok(`created ${created}/${products.length}`);
  if (failed.length) log('failed:', failed.slice(0, 8).join(', '));
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
  const text = readInput();
  log(`extracting products (${MODEL})…`);
  const products = await extract(text);
  if (products == null) return; // dry-run
  ok(`extracted ${products.length} products`);
  console.log('\nИме                          Цена     Ед.    Разфасовка   Категория');
  console.log('─'.repeat(74));
  for (const p of products) {
    const price = (p.priceStotinki / 100).toFixed(2).replace('.', ',') + ' €';
    console.log(
      `${String(p.name).padEnd(28).slice(0, 28)} ${price.padStart(8)}  ${String(p.unit || '').padEnd(5).slice(0, 5)}  ${String(p.weight || '').padEnd(11).slice(0, 11)}  ${p.category || ''}`,
    );
  }
  fs.writeFileSync('imported-products.json', JSON.stringify(products, null, 2));
  ok('saved imported-products.json (review before applying)');
  if (args.apply) await apply(products);
  else log('preview only — re-run with --apply --email/--password (or --token) to create');
}

main().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
