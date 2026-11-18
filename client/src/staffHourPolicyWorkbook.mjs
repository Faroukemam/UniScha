import * as XLSX from 'xlsx';

const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');

export function readStaffHourPolicyWorkbook(workbook) {
  const preferred = workbook.SheetNames.find((name) => normalize(name) === 'staffhourpolicies');
  const sheets = preferred ? [preferred] : workbook.SheetNames.filter((name) => !['instructions', 'examples', 'staffreference'].includes(normalize(name)));
  for (const name of sheets) {
    const sheet = workbook.Sheets[name];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const header = grid.findIndex((row) => {
      const keys = new Set(row.map(normalize));
      return (keys.has('staffid') || keys.has('invigilatorid')) && (keys.has('mode') || keys.has('policymode'));
    });
    if (header >= 0) {
      const start = XLSX.utils.decode_range(sheet['!ref']).s.r + header;
      return XLSX.utils.sheet_to_json(sheet, { range: start }).map((row) => ({ ...row, __importRow: row.__rowNum__ + 1 }));
    }
  }
  throw new Error('No staff hour policy table found. Use the template with StaffID, Mode and HoursValue columns.');
}
