// packages/help-content/src/content.spec.ts
import { PANEL_FAQ } from './panel.faq';
import { DELIVERY_FAQ } from './delivery.faq';
import { PANEL_CATEGORIES, DELIVERY_CATEGORIES } from './categories';

function assertHealthy(entries: { id: string; category: string; question: string; answer: string }[], validCategoryIds: Set<string>, minCount: number) {
  expect(entries.length).toBeGreaterThanOrEqual(minCount);
  const ids = new Set<string>();
  for (const e of entries) {
    expect(ids.has(e.id)).toBe(false);
    ids.add(e.id);
    expect(validCategoryIds.has(e.category)).toBe(true);
    expect(e.question.trim().length).toBeGreaterThan(0);
    expect(e.answer.trim().length).toBeGreaterThan(0);
  }
}

describe('FAQ content integrity', () => {
  it('panel corpus has unique ids, valid categories, non-empty text, and enough entries', () => {
    assertHealthy(PANEL_FAQ, new Set(PANEL_CATEGORIES.map((c) => c.id)), 60);
  });

  it('delivery corpus has unique ids, valid categories, non-empty text, and enough entries', () => {
    assertHealthy(DELIVERY_FAQ, new Set(DELIVERY_CATEGORIES.map((c) => c.id)), 30);
  });
});
