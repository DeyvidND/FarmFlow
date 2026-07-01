// packages/help-content/src/search.spec.ts
import { searchFaq } from './search';
import type { FaqEntry } from './types';

const ENTRIES: FaqEntry[] = [
  { id: '1', category: 'products', question: 'Как добавям продукт?', answer: 'Отвори „Продукти" → „Добави продукт".' },
  { id: '2', category: 'orders', question: 'Как потвърждавам поръчка?', answer: 'Натисни „Потвърди" в панела.', keywords: ['статус'] },
  { id: '3', category: 'products', question: 'Как крия продукт?', answer: 'Ползвай превключвателя до продукта.' },
];

describe('searchFaq', () => {
  it('returns everything when query and categories are empty', () => {
    expect(searchFaq(ENTRIES, '', [])).toHaveLength(3);
  });

  it('filters by category', () => {
    const res = searchFaq(ENTRIES, '', ['orders']);
    expect(res.map((e) => e.id)).toEqual(['2']);
  });

  it('matches a question substring case-insensitively', () => {
    const res = searchFaq(ENTRIES, 'ДОБАВЯМ', []);
    expect(res.map((e) => e.id)).toEqual(['1']);
  });

  it('matches keywords even when absent from question/answer text', () => {
    const res = searchFaq(ENTRIES, 'статус', []);
    expect(res.map((e) => e.id)).toEqual(['2']);
  });

  it('ranks question matches above answer-only matches', () => {
    const res = searchFaq(ENTRIES, 'продукт', []);
    expect(res.map((e) => e.id)).toEqual(['1', '3']);
  });

  it('combines an active category filter with a query', () => {
    const res = searchFaq(ENTRIES, 'продукт', ['orders']);
    expect(res).toHaveLength(0);
  });
});
