import { HealthClient } from '@/components/health-client';

// Live system state (DB/Redis/queues/errors) — always fetched fresh client-side
// on mount rather than SSR-seeded, so this page has nothing to pre-fetch itself.
export const dynamic = 'force-dynamic';

export default function HealthPage() {
  return <HealthClient />;
}
