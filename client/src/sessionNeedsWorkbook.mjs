import * as XLSX from 'xlsx';

const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');

export function readSessionNeedsWorkbook(workbook) {
  const preferred = ['sessionneeds', 'roomstaffneeds'];
  const sheets = [...workbook.SheetNames].sort((a, b) => {
    const rank = (name) => preferred.includes(normalize(name)) ? preferred.indexOf(normalize(name)) : preferred.length;
    return rank(a) - rank(b);
  });
  for (const name of sheets) {
    if (normalize(name) === 'instructions') continue;
    const sheet = workbook.Sheets[name];
    // Some staffing workbooks contain a title and rule summary above the table.
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const headerIndex = grid.findIndex((row) => {
      const headers = new Set(row.map(normalize));
      return ['taneeded', 'tasneeded', 'doctorneeded', 'doctorsneeded'].some((key) => headers.has(key))
        && (headers.has('sessionid') || (headers.has('room') && headers.has('date')));
    });
    if (headerIndex !== -1) {
      const firstRow = XLSX.utils.decode_range(sheet['!ref']).s.r;
      return XLSX.utils.sheet_to_json(sheet, { range: firstRow + headerIndex });
    }
  }
  throw new Error('No session needs table found. Include TANeeded/DoctorNeeded and SessionID or Room, Date and Start columns.');
}
