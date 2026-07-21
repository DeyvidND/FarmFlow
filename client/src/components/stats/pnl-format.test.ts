import { describe, expect, it } from 'vitest';
import { CATEGORY_LABELS, bpsToPct, pctToBps, parseAmountToStotinki } from './pnl-format';

describe('pnl-format', () => {
  it('всяка категория има български етикет', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual(
      ['fees', 'fuel', 'other', 'packaging', 'salary'].sort(),
    );
    expect(CATEGORY_LABELS.fuel).toBe('Гориво');
  });

  it('базисни точки ↔ проценти', () => {
    expect(bpsToPct(1000)).toBe('10');
    expect(bpsToPct(1250)).toBe('12.5');
    expect(bpsToPct(0)).toBe('0');
    expect(pctToBps('12.5')).toBe(1250);
    expect(pctToBps('10')).toBe(1000);
  });

  it('невалиден процент дава null, а не NaN', () => {
    expect(pctToBps('')).toBeNull();
    expect(pctToBps('абв')).toBeNull();
    expect(pctToBps('-3')).toBeNull();
    expect(pctToBps('120')).toBeNull(); // над 50% таван
  });

  it('сума в лева → стотинки, с двата десетични разделителя', () => {
    expect(parseAmountToStotinki('12.34')).toBe(1234);
    expect(parseAmountToStotinki('12,34')).toBe(1234);
    expect(parseAmountToStotinki('7')).toBe(700);
    expect(parseAmountToStotinki('0.005')).toBe(1); // закръгля до стотинка
  });

  it('невалидна или нулева сума дава null', () => {
    expect(parseAmountToStotinki('')).toBeNull();
    expect(parseAmountToStotinki('абв')).toBeNull();
    expect(parseAmountToStotinki('0')).toBeNull();
    expect(parseAmountToStotinki('-5')).toBeNull();
  });
});
