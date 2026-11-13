import { carriers, type ImportRow, type Shipment } from './types';

// Keep tracking numbers as strings: leading zeroes and long integers are significant.
export function parseImport(
  text: string,
  defaultCarrier = '',
): { rows: ImportRow[]; invalid: string[]; duplicates: number } {
  const rows: ImportRow[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const lines = splitCsvRecords(text.replace(/^\uFEFF/, '')).filter((line) => line.trim());
  for (const line of lines) {
    const cells = splitCsvLine(line).map((cell) => cell.trim());
    if (/^(单号|快递单号|运单号|tracking.?number|number)$/i.test(cells[0])) continue;
    // A line can contain several numbers separated by spaces / Chinese punctuation.
    if (cells.length === 1) {
      for (const token of cells[0].split(/[\s，；;、]+/).filter(Boolean))
        add(token, defaultCarrier, '');
    } else if (
      cells.every((cell) => /^[a-zA-Z0-9-]{6,40}$/.test(cell)) &&
      !carriers.some(([code]) => code && code === cells[1])
    ) {
      for (const token of cells) add(token, defaultCarrier, '');
    } else {
      const label = cells[1] || defaultCarrier;
      const carrier =
        carriers.find(([code, name]) => code === label || name === label)?.[0] ?? label;
      add(cells[0], carrier, cells.slice(2).join(','));
    }
  }
  function add(raw: string, carrier: string, note: string) {
    const number = raw.replace(/^['\u2018\u2019]|['\u2018\u2019]$/g, '').toUpperCase();
    if (!/^[A-Z0-9-]{6,40}$/.test(number) || !/^[a-z0-9_]{0,50}$/.test(carrier)) {
      invalid.push(raw);
      return;
    }
    if (seen.has(number)) {
      duplicates++;
      return;
    }
    seen.add(number);
    rows.push({ number, carrier, note: note.slice(0, 200) });
  }
  return { rows, invalid, duplicates };
}

function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let quoted = false,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (text[i] === '\n' && !quoted) {
      records.push(text.slice(start, i).replace(/\r$/, ''));
      start = i + 1;
    }
  }
  records.push(text.slice(start));
  return records;
}

export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let value = '',
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if ((ch === ',' || ch === '\t') && !quoted) {
      cells.push(value);
      value = '';
    } else value += ch;
  }
  cells.push(value);
  return cells;
}

export function csvCell(value: string): string {
  // Prevent spreadsheet formula execution when exporting customer-supplied notes.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function exportCsv(shipments: Shipment[], names: Record<string, string>): string {
  return (
    '\uFEFF' +
    [
      ['运单号', '快递公司', '物流状态', '最新轨迹', '轨迹时间', '最后查询', '备注', '查询提示'],
      ...shipments.map((s) => [
        s.number,
        s.carrierName || s.carrier,
        names[s.status],
        s.events[0]?.context || '',
        s.events[0]?.time || '',
        s.checkedAt || '',
        s.note,
        s.error || '',
      ]),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n')
  );
}
export function formatDate(value: string | null, withTime = true): string {
  if (!value) return '尚未查询';
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    hour12: false,
  }).format(date);
}
