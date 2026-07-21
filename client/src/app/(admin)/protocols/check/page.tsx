import { ProtocolCheckClient } from '@/components/handover/protocol-check-client';
import { RegisterCheckSW } from '@/components/handover/register-check-sw';

export const dynamic = 'force-dynamic';

export default function ProtocolCheckPage() {
  return (
    <>
      <RegisterCheckSW />
      <ProtocolCheckClient />
    </>
  );
}
