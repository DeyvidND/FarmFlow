import { parseFile, HEADER_ALIASES } from './import.parse';
import * as ExcelJS from 'exceljs';

describe('parseFile', () => {
  it('parses CSV into header-keyed rows, mapping BG + EN aliases to canonical keys', async () => {
    const csv = 'Получател,Телефон,Доставка,Град\nИван,0888123456,офис,Бургас\n';
    const rows = await parseFile(Buffer.from(csv, 'utf8'), 'list.csv');
    expect(rows).toEqual([
      { name: 'Иван', phone: '0888123456', mode: 'офис', city: 'Бургас' },
    ]);
  });

  it('maps English headers via aliases', async () => {
    const csv = 'name,phone,mode,city\nIvan,0888,address,Sofia\n';
    const rows = await parseFile(Buffer.from(csv, 'utf8'), 'list.csv');
    expect(rows[0]).toMatchObject({ name: 'Ivan', phone: '0888', mode: 'address', city: 'Sofia' });
  });

  it('skips fully-empty rows', async () => {
    const csv = 'name,phone\nIvan,0888\n,\n';
    const rows = await parseFile(Buffer.from(csv, 'utf8'), 'list.csv');
    expect(rows).toHaveLength(1);
  });

  it('parses XLSX with the first row as headers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.addRow(['Получател', 'Телефон']);
    ws.addRow(['Мария', '0899111222']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const rows = await parseFile(buf, 'list.xlsx');
    expect(rows).toEqual([{ name: 'Мария', phone: '0899111222' }]);
  });

  it('exposes a canonical alias map', () => {
    expect(HEADER_ALIASES.name).toContain('получател');
    expect(HEADER_ALIASES.carrier).toContain('куриер');
  });
});
