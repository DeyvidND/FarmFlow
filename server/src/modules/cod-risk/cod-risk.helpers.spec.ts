import { normalizePhone, riskVerdict, isReturnedStatus, parseReports, buildReportText } from './cod-risk.helpers';

describe('normalizePhone', () => {
  it('canonicalizes BG forms to +359XXXXXXXXX', () => {
    expect(normalizePhone('0888123456')).toBe('+359888123456');
    expect(normalizePhone('+359888123456')).toBe('+359888123456');
    expect(normalizePhone('0888 123 456')).toBe('+359888123456');
    expect(normalizePhone('00359888123456')).toBe('+359888123456');
    expect(normalizePhone('888123456')).toBe('+359888123456');
  });
  it('returns null for unparseable input', () => {
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
  });
});

describe('riskVerdict', () => {
  it('escalates with strikes / report count', () => {
    expect(riskVerdict(0, 0)).toBe('ok');
    expect(riskVerdict(1, 0)).toBe('caution');
    expect(riskVerdict(0, 1)).toBe('caution');
    expect(riskVerdict(2, 0)).toBe('high');
    expect(riskVerdict(0, 3)).toBe('high');
  });
});

describe('isReturnedStatus', () => {
  it('detects Bulgarian returned/refused statuses', () => {
    expect(isReturnedStatus('Пратката е върната на подателя')).toBe(true);
    expect(isReturnedStatus('Отказана от получателя')).toBe(true);
    expect(isReturnedStatus('returned to sender')).toBe(true);
    expect(isReturnedStatus('refused')).toBe(true);
  });
  it('is false for normal / null statuses', () => {
    expect(isReturnedStatus('Доставена')).toBe(false);
    expect(isReturnedStatus('В транзит')).toBe(false);
    expect(isReturnedStatus(null)).toBe(false);
  });
});

describe('parseReports', () => {
  it('reads a list under reports / data / array root, defensively', () => {
    expect(parseReports({ reports: [{ phone: '0888', text: 'отказа' }] }).count).toBe(1);
    expect(parseReports([{ phone: '0888' }]).count).toBe(1);
    expect(parseReports({ data: [{}, {}] }).count).toBe(2);
    expect(parseReports({ reports: [] }).found).toBe(false);
    expect(parseReports(null).found).toBe(false);
  });
});

describe('buildReportText', () => {
  it('describes the refused COD parcel in Bulgarian', () => {
    const txt = buildReportText({ codAmountStotinki: 2400, receiverName: 'Иван' });
    expect(txt).toContain('наложен платеж');
    expect(txt.length).toBeGreaterThan(0);
  });
});
