import { getStorefront, resolveSlug } from '@/lib/api';
import { CheckoutClient } from '@/components/checkout-client';

/**
 * Checkout (server) — resolves the storefront profile so the client island knows
 * whether the farm offers **personal (address) delivery**. If the profile can't
 * be read, default to enabled (show address + Еконт, the prior behavior).
 */
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: { slug?: string };
}) {
  const slug = resolveSlug(searchParams?.slug);
  const deliveryEnabled = await getStorefront(slug)
    .then((p) => p.deliveryEnabled)
    .catch(() => true);

  return <CheckoutClient deliveryEnabled={deliveryEnabled} />;
}
