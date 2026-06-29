import { readSenderBook, applySenderBook } from './sender-book';

describe('readSenderBook', () => {
  it('returns the existing senders + a valid activeId', () => {
    const out = readSenderBook({
      senders: [{ id: 'a', label: 'Основна', name: 'Х' }, { id: 'b', label: 'Склад', name: 'Y' }],
      activeSenderId: 'b',
    });
    expect(out).toEqual({ senders: [{ id: 'a', label: 'Основна', name: 'Х' }, { id: 'b', label: 'Склад', name: 'Y' }], activeId: 'b' });
  });

  it('falls back activeId to the first point when activeSenderId is missing/unknown', () => {
    const out = readSenderBook({ senders: [{ id: 'a', label: 'Основна', name: 'Х' }], activeSenderId: 'zzz' });
    expect(out.activeId).toBe('a');
  });

  it('migrates a lone sender into a one-point book labelled „Основна"', () => {
    const out = readSenderBook({ sender: { name: 'Ферма', phone: '0700', mode: 'office' } });
    expect(out.senders).toEqual([{ id: 'p1', label: 'Основна', name: 'Ферма', phone: '0700', mode: 'office' }]);
    expect(out.activeId).toBe('p1');
  });

  it('returns an empty book when neither senders nor sender exist', () => {
    expect(readSenderBook({})).toEqual({ senders: [], activeId: null });
    expect(readSenderBook(null)).toEqual({ senders: [], activeId: null });
  });
});

describe('applySenderBook', () => {
  const senders = [
    { id: 'a', label: 'Основна', name: 'Х', phone: '1', mode: 'office', officeCode: '10' },
    { id: 'b', label: 'Склад', name: 'Y', phone: '2', mode: 'office', officeCode: '20' },
  ];

  it('writes the book + mirrors the active point into sender (without id/label)', () => {
    const out = applySenderBook({ username: 'u', sender: { name: 'old' } }, senders, 'b');
    expect(out.senders).toEqual(senders);
    expect(out.activeSenderId).toBe('b');
    expect(out.sender).toEqual({ name: 'Y', phone: '2', mode: 'office', officeCode: '20' });
    expect(out.username).toBe('u'); // untouched
  });

  it('falls back to the first point when activeId is unknown', () => {
    const out = applySenderBook({}, senders, 'zzz');
    expect(out.activeSenderId).toBe('a');
    expect(out.sender).toMatchObject({ name: 'Х' });
  });

  it('clears the active sender when the book is empty', () => {
    const out = applySenderBook({ sender: { name: 'old' } }, [], 'a');
    expect(out.senders).toEqual([]);
    expect(out.activeSenderId).toBeNull();
    expect(out.sender).toEqual({});
  });
});
