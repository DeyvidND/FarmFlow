'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/** Producers may only open their own screens; bounce anything else to /stats.
 *  UX only — the server's default-deny guard is the real boundary. Each path here
 *  must have a matching FARMER_NAV item (or be settings/help) AND a server route
 *  opened to role 'farmer' — otherwise the screen bounces or 403s. */
const FARMER_ALLOWED = ['/stats', '/payments', '/availability', '/products', '/settings', '/help'];

export function FarmerRouteGuard() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const ok = FARMER_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + '/'));
    if (!ok) router.replace('/stats');
  }, [pathname, router]);
  return null;
}
