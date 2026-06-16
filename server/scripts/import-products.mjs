#!/usr/bin/env node
/**
 * import-products.mjs — AI catalog import (the onboarding time-saver).
 * Imports PRODUCTS, FARMERS, or CATEGORIES from messy text.
 *
 * Messy source (Excel/CSV paste, OCR of a price board, Facebook post, notes)
 *   → Claude extracts structured rows (forced tool call)
 *   → preview (human review gate)
 *   → optional bulk-create via the existing tenant API.
 *
 * Structured extraction uses the documented Messages REST endpoint with a forced
 * tool call (tool_choice), so Claude must return JSON matching the schema.
 *
 * Usage:
 *   node scripts/import-products.mjs --file list.txt                       # products (default), preview
 *   node scripts/import-products.mjs --type farmers --file farmers.txt
 *   node scripts/import-products.mjs --type categories --text "Зеленчуци, Млечни, Мед"
 *   node scripts/import-products.mjs --file list.txt --apply \
 *     --api http://localhost:3001 --email owner@farm.bg --password '…'
 *   node scripts/import-products.mjs --file list.txt --dry-run             # show request, no API call
 *
 * Env: ANTHROPIC_API_KEY (required unless --dry-run); ANTHROPIC_MODEL (default claude-haiku-4-5).
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
// Haiku 4.5 = cheap + fast for extraction. The `effort` param 400s on Haiku 4.5
// (it's Opus/Sonnet-only), so "low effort" here = Haiku with no extended thinking;
// effort:low is only sent when the model actually supports it (override via env).
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
const EFFORT_OK = /opus-4-[5-8]|sonnet-4-6|fable-5/.test(MODEL);
const api = args.api ?? process.env.API_BASE ?? 'http://localhost:3001';
const log = (...a) => console.log('•', ...a);
const ok = (...a) => console.log('  ✓', ...a);

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const money = (st) => (st / 100).toFixed(2).replace('.', ',') + ' €';

// ── per-type config: extraction schema + create body + preview ───────────────
const TYPES = {
  products: {
    endpoint: 'products',
    label: 'продукти',
    tool: 'extract_products',
    toolDesc: "Record every product found in the farm's price list / catalog text.",
    item: {
      name: { type: 'string', description: 'Product name in Bulgarian, e.g. "Домати".' },
      priceStotinki: { type: 'integer', description: 'Unit price in stotinki (euro-cents). 6,50 → 650. Multiply a decimal price by 100 and round.' },
      unit: { type: 'string', description: 'Unit of sale: "кг", "бр", "връзка", "литър", "пакет"… Best guess; default "бр".' },
      weight: { type: 'string', description: 'Pack size / weight if shown, e.g. "500 г". Empty string if none.' },
      category: { type: 'string', description: 'Section/category if discernible. Empty string if unknown.' },
      description: { type: 'string', description: 'Short note if present. Empty string if none.' },
    },
    intro: 'Извади ВСЕКИ продукт от ценоразписа по-долу. За всеки дай: име (български), цена в стотинки (числото × 100, напр. 6,50 → 650), мерна единица, разфасовка, категория, описание. Пропусни редове, които не са продукти (заглавия, телефони, адреси).',
    body: (p) => ({ name: p.name, priceStotinki: p.priceStotinki, unit: p.unit || 'бр', ...(p.weight ? { weight: p.weight } : {}), ...(p.category ? { category: p.category } : {}), ...(p.description ? { description: p.description } : {}), isActive: true }),
    head: 'Име                          Цена     Ед.    Разфасовка   Категория',
    row: (p) => `${pad(p.name, 28)} ${money(p.priceStotinki).padStart(8)}  ${pad(p.unit, 5)}  ${pad(p.weight, 11)}  ${p.category || ''}`,
  },
  farmers: {
    endpoint: 'farmers',
    label: 'фермери',
    tool: 'extract_farmers',
    toolDesc: 'Record every producer/farmer described in the text.',
    item: {
      name: { type: 'string', description: 'Producer / farmer name (person or farm), Bulgarian.' },
      role: { type: 'string', description: 'Specialty / role, e.g. "Пчелар", "Зеленчукопроизводител". Empty string if none.' },
      bio: { type: 'string', description: 'Short bio / description. Empty string if none.' },
      phone: { type: 'string', description: 'Phone if present. Empty string if none.' },
      email: { type: 'string', description: 'Valid email if present, else empty string (do not invent one).' },
      since: { type: 'string', description: 'Year started, e.g. "2015". Empty string if none.' },
    },
    intro: 'Извади ВСЕКИ производител/фермер от текста по-долу. За всеки дай: име, специалност/роля, кратко описание, телефон, имейл (само ако е реален), от коя година.',
    body: (f) => ({ name: f.name, ...(f.role ? { role: f.role } : {}), ...(f.bio ? { bio: f.bio } : {}), ...(f.phone ? { phone: f.phone } : {}), ...(f.email ? { email: f.email } : {}), ...(f.since ? { since: f.since } : {}) }),
    head: 'Име                          Роля                    Телефон',
    row: (f) => `${pad(f.name, 28)} ${pad(f.role, 22)}  ${f.phone || ''}`,
  },
  categories: {
    endpoint: 'subcategories',
    label: 'категории',
    tool: 'extract_categories',
    toolDesc: 'Record every product category / section named in the text.',
    item: {
      name: { type: 'string', description: 'Category / section name, Bulgarian, e.g. "Зеленчуци", "Млечни".' },
      description: { type: 'string', description: 'Short description. Empty string if none.' },
    },
    intro: 'Извади ВСЯКА категория/раздел за групиране на продукти от текста по-долу. За всяка дай: име и кратко описание (ако има).',
    body: (c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}) }),
    head: 'Име                          Описание',
    row: (c) => `${pad(c.name, 28)} ${c.description || ''}`,
  },
};

const type = args.type && args.type !== true ? args.type : 'products';
const T = TYPES[type];
if (!T) { console.error(`--type must be one of: ${Object.keys(TYPES).join(', ')}`); process.exit(1); }

function readInput() {
  if (args.text && args.text !== true) return String(args.text);
  if (args.file && args.file !== true) return fs.readFileSync(args.file, 'utf8');
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  console.error('Provide --file <path>, --text "…", or pipe text on stdin.');
  process.exit(1);
}

function buildTool() {
  return {
    name: T.tool,
    description: T.toolDesc,
    input_schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: T.item, required: Object.keys(T.item), additionalProperties: false } },
      },
      required: ['items'],
    },
  };
}

const PROMPT = (text) =>
  `${T.intro} Извикай инструмента ${T.tool} с всички намерени.\n\nТЕКСТ:\n"""\n${text}\n"""`;

async function extract(text) {
  const body = {
    model: MODEL,
    max_tokens: 8000,
    tools: [buildTool()],
    tool_choice: { type: 'tool', name: T.tool },
    messages: [{ role: 'user', content: PROMPT(text) }],
  };
  if (EFFORT_OK) body.output_config = { effort: 'low' };
  if (args['dry-run']) {
    console.log(`— DRY RUN (${type}) — request to POST /v1/messages:`);
    console.log(JSON.stringify({ ...body, messages: [{ role: 'user', content: PROMPT('…').slice(0, 100) + '…' }] }, null, 2));
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
  const tool = (msg.content ?? []).find((b) => b.type === 'tool_use' && b.name === T.tool);
  if (!tool) throw new Error(`No ${T.tool} tool call in the response.`);
  return tool.input.items ?? [];
}

async function apply(rows) {
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
  for (const row of rows) {
    const r = await fetch(`${api}/${T.endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(T.body(row)),
    });
    if (r.ok) created++;
    else failed.push(`${row.name} (${r.status})`);
  }
  ok(`created ${created}/${rows.length} ${T.label}`);
  if (failed.length) log('failed:', failed.slice(0, 8).join(', '));
}

async function main() {
  const text = readInput();
  log(`extracting ${T.label} (${MODEL}${EFFORT_OK ? ', effort:low' : ''})…`);
  const rows = await extract(text);
  if (rows == null) return; // dry-run
  ok(`extracted ${rows.length} ${T.label}`);
  console.log('\n' + T.head);
  console.log('─'.repeat(74));
  for (const row of rows) console.log(T.row(row));
  const out = `imported-${type}.json`;
  fs.writeFileSync(out, JSON.stringify(rows, null, 2));
  ok(`saved ${out} (review before applying)`);
  if (args.apply) await apply(rows);
  else log('preview only — re-run with --apply --email/--password (or --token) to create');
}

main().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
