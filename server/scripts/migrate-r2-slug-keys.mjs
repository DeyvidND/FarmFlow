// Migrate R2 object keys from tenants/{uuid}/… to tenants/{slug}/… and rewrite the
// matching DB URLs, so each farm's images sit in one human-readable bucket folder.
//
// DRY-RUN by default — prints exactly what it WOULD copy / rewrite / delete and
// changes nothing. Pass --execute to actually perform it.
//
// The URL rewrite is host-agnostic: it replaces the path substring `tenants/{id}/`
// → `tenants/{slug}/`, so it fixes both legacy pub-*.r2.dev URLs and cdn URLs, and
// also the bare object key stored in settings.brand.favicon.key.
//
// Usage (from server/, with PRODUCTION env so it hits the live bucket + DB):
//   node scripts/migrate-r2-slug-keys.mjs              # dry-run (safe)
//   node scripts/migrate-r2-slug-keys.mjs --execute    # perform
//
// Needs env: DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//            R2_BUCKET_NAME.  ⚠ Take a DB snapshot before --execute.
import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import {
  createDb,
  tenants,
  products,
  productMedia,
  farmers,
  farmerMedia,
  subcategories,
  subcategoryMedia,
  articles,
  articleMedia,
} from '@fermeribg/db';
import { sql, eq } from 'drizzle-orm';

const EXECUTE = process.argv.includes('--execute');

const need = (k) => {
  const v = process.env[k]?.trim();
  if (!v) {
    console.error(`✖ ${k} is not set.`);
    process.exit(1);
  }
  return v;
};
const DATABASE_URL = need('DATABASE_URL');
const accountId = need('R2_ACCOUNT_ID');
const accessKeyId = need('R2_ACCESS_KEY_ID');
const secretAccessKey = need('R2_SECRET_ACCESS_KEY');
const Bucket = need('R2_BUCKET_NAME');

const db = createDb(DATABASE_URL);
const s3 = new S3Client({
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  region: 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

// Encode each path segment but keep the slashes (R2 CopySource is a path).
const copySource = (key) => `${Bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// Every column that can embed a `tenants/{id}/…` path, scoped per tenant where possible.
async function rewriteDbUrls(id, from, to) {
  const rep = (col) => sql`replace(${col}, ${from}, ${to})`;
  await db.update(products).set({ imageUrl: rep(products.imageUrl) }).where(eq(products.tenantId, id));
  await db.update(productMedia).set({ url: rep(productMedia.url) }).where(eq(productMedia.tenantId, id));
  await db.update(farmers).set({ imageUrl: rep(farmers.imageUrl) }).where(eq(farmers.tenantId, id));
  await db.update(farmerMedia).set({ url: rep(farmerMedia.url) }).where(eq(farmerMedia.tenantId, id));
  await db.update(subcategories).set({ imageUrl: rep(subcategories.imageUrl) }).where(eq(subcategories.tenantId, id));
  await db.update(subcategoryMedia).set({ url: rep(subcategoryMedia.url) }).where(eq(subcategoryMedia.tenantId, id));
  await db.update(articles).set({ coverImageUrl: rep(articles.coverImageUrl) }).where(eq(articles.tenantId, id));
  await db.update(articleMedia).set({ url: rep(articleMedia.url) }).where(eq(articleMedia.tenantId, id));
  // settings jsonb (media.*.url, brand.favicon.url + .key) — replace in the text form.
  await db
    .update(tenants)
    .set({ settings: sql`replace(${tenants.settings}::text, ${from}, ${to})::jsonb` })
    .where(eq(tenants.id, id));
}

async function deleteAll(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000).map((Key) => ({ Key }));
    await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: chunk, Quiet: true } }));
  }
}

async function main() {
  console.log(`\n${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} — R2 slug-key migration on bucket "${Bucket}"\n`);
  const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants);
  let totalObjects = 0;
  let migratedTenants = 0;

  for (const { id, slug } of rows) {
    if (!slug || id === slug) continue;
    const oldPrefix = `tenants/${id}/`;
    const newPrefix = `tenants/${slug}/`;
    const keys = await listAll(oldPrefix);
    if (!keys.length) continue;

    migratedTenants += 1;
    totalObjects += keys.length;
    console.log(`• ${slug}  (${id})  — ${keys.length} objects`);
    console.log(`    ${oldPrefix}  →  ${newPrefix}`);
    console.log(`    e.g. ${keys[0]}  →  ${newPrefix + keys[0].slice(oldPrefix.length)}`);

    if (!EXECUTE) continue;

    // 1) copy every object to the new prefix
    for (const Key of keys) {
      const newKey = newPrefix + Key.slice(oldPrefix.length);
      await s3.send(
        new CopyObjectCommand({
          Bucket,
          CopySource: copySource(Key),
          Key: newKey,
          MetadataDirective: 'COPY', // preserve Content-Type + Cache-Control
        }),
      );
    }
    // 2) point the DB at the new path (host-agnostic substring replace)
    await rewriteDbUrls(id, oldPrefix, newPrefix);
    // 3) drop the old objects only after copy + DB succeeded
    await deleteAll(keys);
    console.log(`    ✓ migrated`);
  }

  console.log(
    `\n${EXECUTE ? '✓ done' : 'would migrate'}: ${migratedTenants} tenants, ${totalObjects} objects.` +
      (EXECUTE ? '' : '\nRe-run with --execute to perform (take a DB snapshot first).'),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('✖ migration failed:', e);
  process.exit(1);
});
