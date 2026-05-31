import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ProductsClient } from '@/components/products/products-client';
import type { Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function getProducts(): Promise<Product[]> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return [];
  const res = await fetch(`${API_BASE}/products`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function ProductsPage() {
  const products = await getProducts();
  return <ProductsClient initial={products} />;
}
