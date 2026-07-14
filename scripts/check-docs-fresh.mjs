#!/usr/bin/env node
// Docs-freshness checker for the AI-legibility docs layer.
//
// Each doc (root CLAUDE.md, ARCHITECTURE.md, per-app CLAUDE.md) carries a header:
//   <!-- last-verified: YYYY-MM-DD | invariants: key=value; key=value -->
// This recomputes those invariants against the live tree and reports drift.
//
// Supported invariant keys:
//   apps=a,b,c        each `<name>/` dir must exist at repo root
//   server.modules=N  count of *.module.ts under server/src must equal N
//   files=p1,p2       each path (repo-relative) must exist
//
// Unknown keys are ignored (forward-compatible). No dependencies.
//
// Exit code: 0 always (warn-only) unless --strict is passed, then 1 on any drift.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');

// Docs that carry an invariant header.
const DOCS = [
  'CLAUDE.md',
  'ARCHITECTURE.md',
  'server/CLAUDE.md',
  'client/CLAUDE.md',
  'admin/CLAUDE.md',
  'delivery-web/CLAUDE.md',
  'packages/CLAUDE.md',
];

const HEADER_RE = /<!--\s*last-verified:\s*([\d-]+)\s*\|\s*invariants:\s*(.*?)\s*-->/;

function countModules(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) n += countModules(p);
    else if (entry.name.endsWith('.module.ts')) n++;
  }
  return n;
}

function checkInvariant(key, value) {
  // returns null if OK, or a drift message string
  if (key === 'apps') {
    const missing = value.split(',').map((s) => s.trim()).filter(
      (a) => a && !(existsSync(join(repoRoot, a)) && statSync(join(repoRoot, a)).isDirectory()),
    );
    return missing.length ? `apps missing: ${missing.join(', ')}` : null;
  }
  if (key === 'server.modules') {
    const expected = Number(value);
    const actual = countModules(join(repoRoot, 'server/src'));
    return actual === expected ? null : `server.modules expected ${expected}, found ${actual}`;
  }
  if (key === 'files') {
    const missing = value.split(',').map((s) => s.trim()).filter(
      (f) => f && !existsSync(join(repoRoot, f)),
    );
    return missing.length ? `files missing: ${missing.join(', ')}` : null;
  }
  return null; // unknown key -> ignore
}

let drift = 0;
let checkedDocs = 0;

for (const doc of DOCS) {
  const abs = join(repoRoot, doc);
  if (!existsSync(abs)) {
    console.warn(`  [WARN] ${doc}: file not found`);
    drift++;
    continue;
  }
  const header = readFileSync(abs, 'utf8').match(HEADER_RE);
  if (!header) {
    console.warn(`  [WARN] ${doc}: no last-verified header`);
    drift++;
    continue;
  }
  checkedDocs++;
  const [, date, rawInvariants] = header;
  const problems = [];
  for (const token of rawInvariants.split(';')) {
    const t = token.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const msg = checkInvariant(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
    if (msg) problems.push(msg);
  }
  if (problems.length) {
    drift += problems.length;
    console.warn(`  [DRIFT] ${doc} (verified ${date}):`);
    for (const p of problems) console.warn(`          - ${p}`);
  } else {
    console.log(`  [ok]    ${doc} (verified ${date})`);
  }
}

console.log('');
if (drift === 0) {
  console.log(`docs:check — ${checkedDocs} docs verified, no drift.`);
  process.exit(0);
}

console.warn(
  `docs:check — ${drift} issue(s) across the docs layer. These docs may be stale; ` +
    're-verify the flagged claims against the code and bump the last-verified stamp.',
);
process.exit(strict ? 1 : 0);
