#!/usr/bin/env node
/**
 * Clone ALL catalog + content of one tenant into another (e.g. пазар Чайка →
 * marketplace-demo), so the marketplace tenant shows real data. Every catalog /
 * content / settings row is copied with fresh UUIDs and remapped foreign keys.
 *
 * WHAT IS CLONED (everything the storefront renders):
 *   farmers, subcategories, products (+ bundle_items remap), farmer_media,
 *   subcategory_media, product_media, product_availability_windows, reviews,
 *   and the tenant settings (copy / media / landing / delivery / multiFarmer /
 *   multiSubcat / productOfWeek — ids inside remapped).
 *
 * WHAT IS NOT CLONED (transactional / auth / PII — cloning these across tenants
 * is wrong and unsafe): orders, users (farmer logins!), shipments, audit_logs,
 * cod_risk_events, commission_entries, contact_messages, delivery_slots,
 * newsletter_*, site_events, import_*, error_events, vendor_subscription_charges,
 * emails. stripe_product_id is nulled (belongs to the source's Stripe account).
 *
 * USAGE (run against the PROD DATABASE_URL — the tenants live in prod farmflow-db):
 *   DATABASE_URL=<prod> \
 *   SRC_SLUG=fermeski-pazar-chayka TARGET_SLUG=marketplace-demo \
 *   node packages/db/scripts/clone-tenant.mjs            # dry-run by default
 *
 *   ...append APPLY=1 to actually write. FORCE=1 to proceed even if the target
 *   already has products (they are NOT deleted — new rows are appended; use a
 *   clean target). COPY_NAME=1 to also overwrite the target's display name.
 */
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const {
  DATABASE_URL,
  SRC_SLUG = "fermeski-pazar-chayka",
  TARGET_SLUG = "marketplace-demo",
  APPLY,
  FORCE,
  COPY_NAME,
} = process.env;

if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL is required (point it at the PROD database).");
  process.exit(1);
}
const DRY = !APPLY;

// Clone order matters — parents before children. `fk` maps a child column to the
// name-map of its parent table.
const TABLES = [
  { t: "farmers", fk: {} },
  { t: "subcategories", fk: {} },
  { t: "products", fk: { farmer_id: "farmers", subcategory_id: "subcategories" }, nullCols: ["stripe_product_id"] },
  { t: "farmer_media", fk: { farmer_id: "farmers" } },
  { t: "subcategory_media", fk: { subcategory_id: "subcategories" } },
  { t: "product_media", fk: { product_id: "products" } },
  { t: "product_availability_windows", fk: { product_id: "products" } },
  { t: "reviews", fk: { product_id: "products" } },
];

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  const maps = {}; // table -> Map(oldId -> newId)
  try {
    await client.query("BEGIN");

    const src = (await client.query("SELECT id, name FROM tenants WHERE slug = $1", [SRC_SLUG])).rows[0];
    const tgt = (await client.query("SELECT id, name FROM tenants WHERE slug = $1", [TARGET_SLUG])).rows[0];
    if (!src) throw new Error(`Source tenant '${SRC_SLUG}' not found`);
    if (!tgt) throw new Error(`Target tenant '${TARGET_SLUG}' not found`);
    console.log(`Source: ${src.name} (${src.id})`);
    console.log(`Target: ${tgt.name} (${tgt.id})`);

    const existing = (await client.query("SELECT count(*)::int n FROM products WHERE tenant_id = $1", [tgt.id])).rows[0].n;
    if (existing > 0 && !FORCE) {
      throw new Error(`Target already has ${existing} products. Use a clean target, or set FORCE=1 to append.`);
    }

    for (const { t, fk, nullCols } of TABLES) {
      maps[t] = new Map();
      const { rows } = await client.query(`SELECT * FROM ${t} WHERE tenant_id = $1`, [src.id]);
      for (const row of rows) {
        const newId = randomUUID();
        maps[t].set(row.id, newId);
        const cols = Object.keys(row);
        const vals = cols.map((c) => {
          if (c === "id") return newId;
          if (c === "tenant_id") return tgt.id;
          if (nullCols?.includes(c)) return null;
          if (fk[c] && row[c] != null) return maps[fk[c]].get(row[c]) ?? null;
          return row[c];
        });
        if (!DRY) {
          const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
          await client.query(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${ph})`, vals);
        }
      }
      console.log(`  ${t}: ${rows.length}${DRY ? " (dry)" : " cloned"}`);
    }

    // 2nd pass: products.bundle_items is a jsonb array of product ids → remap.
    const prodMap = maps["products"];
    const bundles = (await client.query(
      "SELECT id, bundle_items FROM products WHERE tenant_id = $1 AND bundle_items IS NOT NULL",
      [src.id],
    )).rows;
    let remapped = 0;
    for (const b of bundles) {
      const newBundle = (b.bundle_items || []).map((oldPid) => prodMap.get(oldPid)).filter(Boolean);
      const newProdId = prodMap.get(b.id);
      if (!DRY && newProdId) {
        await client.query("UPDATE products SET bundle_items = $1 WHERE id = $2", [JSON.stringify(newBundle), newProdId]);
      }
      remapped++;
    }
    if (bundles.length) console.log(`  bundle_items remapped: ${remapped}${DRY ? " (dry)" : ""}`);

    // Settings: copy content (copy/media/landing/delivery/multiFarmer/multiSubcat/
    // productOfWeek) from source, remapping embedded ids. Keep the target's own
    // identity (name/slug/branding) unless COPY_NAME=1.
    const [{ settings: srcSettings }] = (await client.query("SELECT settings FROM tenants WHERE id = $1", [src.id])).rows;
    const [{ settings: tgtSettings }] = (await client.query("SELECT settings FROM tenants WHERE id = $1", [tgt.id])).rows;
    const s = { ...(tgtSettings || {}) };
    const src2 = srcSettings || {};
    for (const k of ["copy", "media", "delivery", "contact"]) if (src2[k] !== undefined) s[k] = src2[k];
    if (src2.landing) {
      const remapIds = (arr) => (arr || []).map((id) => maps.products.get(id) ?? maps.subcategories.get(id) ?? maps.farmers.get(id) ?? id);
      const L = structuredClone(src2.landing);
      for (const block of Object.values(L)) if (block && Array.isArray(block.ids)) block.ids = remapIds(block.ids);
      s.landing = L;
    }
    if (src2.productOfWeek?.id) s.productOfWeek = { ...src2.productOfWeek, id: maps.products.get(src2.productOfWeek.id) ?? null };
    // multiFarmer / multiSubcat are top-level tenant columns, not settings — copy them too.
    if (!DRY) {
      await client.query(
        `UPDATE tenants SET settings = $1, multi_farmer = (SELECT multi_farmer FROM tenants WHERE id = $2), multi_subcat = (SELECT multi_subcat FROM tenants WHERE id = $2)${COPY_NAME ? ", name = (SELECT name FROM tenants WHERE id = $2)" : ""} WHERE id = $3`,
        [s, src.id, tgt.id],
      );
    }
    console.log(`  settings: merged copy/media/landing/delivery + multiFarmer/multiSubcat${DRY ? " (dry)" : ""}`);

    if (DRY) {
      await client.query("ROLLBACK");
      console.log("\n✓ DRY-RUN complete (nothing written). Re-run with APPLY=1 to commit.");
    } else {
      await client.query("COMMIT");
      console.log("\n✓ CLONE COMMITTED.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\n✗ Rolled back:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
main();
