import { getStorefront, resolveSlug } from '@/lib/api';
import { DEFAULT_DELIVERY } from '@/lib/shipping';
import { CheckoutClient } from '@/components/checkout-client';

/**
 * Checkout (server) — resolves the storefront profile so the client island knows
 * whether the farm offers **personal (address) delivery** and the farm's own
 * delivery fees (so the shown total matches the charge). If the profile can't be
 * read, default to enabled + platform default fees (the prior behavior).
 */
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);
  const profile = await getStorefront(slug).catch(() => null);

  return (
    <CheckoutClient
      deliveryEnabled={profile?.deliveryEnabled ?? true}
      delivery={profile?.delivery ?? DEFAULT_DELIVERY}
    />
  );
}
