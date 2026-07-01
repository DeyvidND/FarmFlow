// packages/help-content/src/search.ts
import type { FaqEntry } from './types';

const norm = (s: string) => s.toLowerCase();

/**
 * Client-side FAQ filter: category filter first, then a substring scorer over
 * question/keywords/answer (question match ranks highest). No server round trip —
 * the corpus is small enough (tens of entries) to filter entirely in the browser.
 */
export function searchFaq(entries: FaqEntry[], query: string, activeCategories: string[] = []): FaqEntry[] {
  const byCategory = activeCategories.length
    ? entries.filter((e) => activeCategories.includes(e.category))
    : entries;

  const q = norm(query.trim());
  if (!q) return byCategory;

  return byCategory
    .map((e) => {
      const question = norm(e.question);
      const answer = norm(e.answer);
      const keywords = (e.keywords ?? []).map(norm);
      let score = 0;
      if (question.includes(q)) score = 3;
      else if (keywords.some((k) => k.includes(q))) score = 2;
      else if (answer.includes(q)) score = 1;
      return { entry: e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.entry);
}
