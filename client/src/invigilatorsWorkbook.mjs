import * as XLSX from 'xlsx';

const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');

export function readInvigilatorsWorkbook(workbook) {
  const preferred = workbook.SheetNames.find((name) => normalize(name) === 'invigilators');
  const names = preferred ? [preferred] : workbook.SheetNames.filter((name) => !['instructions', 'examples'].includes(normalize(name)));
  for (const name of names) {
    const sheet = workbook.Sheets[name];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const header = grid.findIndex((row) => {
      const keys = new Set(row.map(normalize));
      return keys.has('staffid') && (keys.has('name') || keys.has('staffname'));
    });
    if (header >= 0) {
      const start = XLSX.utils.decode_range(sheet['!ref']).s.r + header;
      return XLSX.utils.sheet_to_json(sheet, { range: start }).map((row) => ({ ...row, __importRow: row.__rowNum__ + 1 }));
    }
  }
  throw new Error('No staff table found. Use the Invigilators template with StaffID, Name and Role columns.');
}
