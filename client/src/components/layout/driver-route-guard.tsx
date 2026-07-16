'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/** Drivers (courier logins) may only open the route screen, their prep
 *  checklist, + help; bounce anything else to /route. UX only — the server's
 *  default-deny guard is the real boundary. Keep in sync with DRIVER_ALLOWED
 *  in middleware.ts. */
const DRIVER_ALLOWED = ['/route', '/prep', '/my-turnover', '/help'];

export function DriverRouteGuard() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const ok = DRIVER_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + '/'));
    if (!ok) router.replace('/route');
  }, [pathname, router]);
  return null;
}
