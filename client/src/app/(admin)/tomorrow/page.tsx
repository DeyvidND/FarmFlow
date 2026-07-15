import { redirect } from 'next/navigation';

// Merged into «Подготовка» (/prep). Keep the route as a redirect for bookmarks.
export default function TomorrowRedirect() {
  redirect('/prep');
}
