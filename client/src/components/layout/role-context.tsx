'use client';

import { createContext, useContext } from 'react';

/** The current tenant user's role ('admin' | 'farmer'), sourced server-side in
 *  (admin)/layout.tsx and provided by AdminShell. Lets any client screen adapt to
 *  a producer sub-account without its own /auth/me round-trip. The server is the
 *  real authority (default-deny guard) — this only shapes the UX. */
const RoleContext = createContext<string>('admin');

export function RoleProvider({ role, children }: { role: string; children: React.ReactNode }) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export const useRole = () => useContext(RoleContext);
