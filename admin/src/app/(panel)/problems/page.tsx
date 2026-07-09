import { ProblemsClient } from '@/components/problems-client';

// The feed is time-sensitive (server errors, stuck shipments) — always fetched
// fresh client-side on mount rather than SSR-seeded, so this page has nothing
// to pre-fetch itself.
export const dynamic = 'force-dynamic';

export default function ProblemsPage() {
  return <ProblemsClient />;
}
