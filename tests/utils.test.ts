import { describe, expect, it } from 'vitest';
import { csvCell, exportCsv, parseImport } from '../src/utils';
import { statusNames, type Shipment } from '../src/types';

describe('batch import', () => {
  it('preserves leading zeroes and numbers exceeding JavaScript integer precision', () => {
    expect(parseImport('0012345678901234567890\nSF12345678').rows.map((r) => r.number)).toEqual([
      '0012345678901234567890',
      'SF12345678',
    ]);
  });
  it('deduplicates case-insensitively and reports malformed input separately', () => {
    const result = parseImport('sf12345678 SF12345678\nJD12345678\n坏单号');
    expect(result.rows).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.invalid).toEqual(['坏单号']);
  });
  it('imports UTF-8 BOM CSV, quoted commas, multiline notes, and carrier labels', () => {
    const result = parseImport(
      '\uFEFF单号,快递公司,备注\r\n001234567890,顺丰速运,"订单 A, 加急\n第二行"',
    );
    expect(result.rows).toEqual([
      { number: '001234567890', carrier: 'shunfeng', note: '订单 A, 加急\n第二行' },
    ]);
  });
  it('supports comma-separated batches without mistaking a carrier code for a number', () => {
    expect(parseImport('SF12345678,JD12345678').rows).toHaveLength(2);
    expect(parseImport('SF12345678,shunfeng,加急').rows[0]).toEqual({
      number: 'SF12345678',
      carrier: 'shunfeng',
      note: '加急',
    });
  });
  it('accepts an Excel text prefix and applies the default carrier', () => {
    expect(parseImport("'0012345678", 'shunfeng').rows[0]).toEqual({
      number: '0012345678',
      carrier: 'shunfeng',
      note: '',
    });
  });
});
describe('CSV export', () => {
  it('neutralizes spreadsheet formulas and escapes quotes', () => {
    expect(csvCell('=SUM(1,2)')).toBe('"' + "'=SUM(1,2)" + '"');
    expect(csvCell('普通"备注')).toBe('"普通""备注"');
  });
  it('exports empty tracking histories without inventing a result', () => {
    const row: Shipment = {
      id: '1',
      number: '0012345678',
      carrier: '',
      carrierName: '',
      note: '加急',
      status: 'pending',
      queryState: 'pending',
      tracking: true,
      events: [],
      error: null,
      createdAt: '',
      checkedAt: null,
    };
    const csv = exportCsv([row], statusNames);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"0012345678"');
    expect(csv).toContain('"待查询","","",""');
  });
});
