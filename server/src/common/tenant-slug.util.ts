import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';

/**
 * Resolve a tenant's stable slug for use as the human-readable R2 key prefix
 * (`tenants/{slug}/…` instead of `tenants/{uuid}/…`), so a farm's objects sit in
 * one recognisable folder in the bucket. The slug is the storefront identifier and
 * is effectively stable; uploads are infrequent admin actions, so the extra indexed
 * lookup is negligible. Throws if the tenant is missing (an upload for a non-existent
 * tenant should fail loudly rather than write under an empty prefix).
 */
export async function tenantSlug(db: Database, tenantId: string): Promise<string> {
  const [row] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row?.slug) throw new Error(`tenantSlug: tenant ${tenantId} not found`);
  return row.slug;
}
