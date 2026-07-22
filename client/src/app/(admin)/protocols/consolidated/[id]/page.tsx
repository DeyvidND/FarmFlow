import { ConsolidatedProtocolEdit } from '@/components/handover/consolidated-protocol-edit';

export const dynamic = 'force-dynamic';

export default async function ConsolidatedProtocolEditPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <ConsolidatedProtocolEdit id={id} />;
}
