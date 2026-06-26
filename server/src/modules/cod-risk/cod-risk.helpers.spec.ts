import {
  normalizePhone,
  riskVerdict,
  isReturnedStatus,
  parseReports,
  buildReportText,
  toInternalReports,
  toNekorektenReports,
  mergeReports,
  type RiskReport,
} from './cod-risk.helpers';

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

describe('toInternalReports', () => {
  it('maps returned events to internal RiskReports (ISO date), filtering non-returned', () => {
    const out = toInternalReports(
      [
        { createdAt: new Date('2026-06-01T10:00:00.000Z'), phone: '+359888111222', type: 'returned' },
        { createdAt: new Date('2026-06-02T10:00:00.000Z'), phone: '+359888111222', type: 'reported' },
      ],
      '+359888000000',
    );
    expect(out).toEqual([
      { source: 'internal', date: '2026-06-01T10:00:00.000Z', phone: '+359888111222', description: 'Върната/невзета COD пратка' },
    ]);
  });

  it('falls back to the lookup phone + null date when the event lacks them', () => {
    expect(toInternalReports([{ createdAt: null, phone: null, type: 'returned' }], '+359888000000')[0]).toMatchObject({
      phone: '+359888000000',
      date: null,
    });
  });
});

describe('toNekorektenReports', () => {
  it('maps nekorekten reports to the unified shape', () => {
    expect(
      toNekorektenReports({
        configured: true,
        found: true,
        count: 1,
        reports: [{ date: '2026-05-01', phone: '+359888111222', description: 'Лош клиент' }],
        status: 'ok',
      }),
    ).toEqual([{ source: 'nekorekten', date: '2026-05-01', phone: '+359888111222', description: 'Лош клиент' }]);
  });
});

describe('mergeReports', () => {
  it('concatenates internal first, then external', () => {
    const i: RiskReport[] = [{ source: 'internal', date: null, phone: 'a', description: 'x' }];
    const e: RiskReport[] = [{ source: 'nekorekten', date: null, phone: 'b', description: 'y' }];
    expect(mergeReports(i, e)).toEqual([...i, ...e]);
  });
  it('handles empty inputs', () => {
    expect(mergeReports([], [])).toEqual([]);
  });
});
