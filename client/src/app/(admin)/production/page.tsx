import { redirect } from 'next/navigation';

// Merged into «Подготовка» (/prep). Preserve any ?date deep link.
export default async function ProductionRedirect(props: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await props.searchParams;
  redirect(date ? `/prep?date=${date}` : '/prep');
}
