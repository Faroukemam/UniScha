// Run: node server/scripts/verify_invigilators_import.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '../..');
  const { readInvigilatorsWorkbook } = await import(pathToFileURL(path.join(root, 'client/src/invigilatorsWorkbook.mjs')));
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-staff-import-'));
  const server = path.join(isolatedRoot, 'server');
  fs.mkdirSync(path.join(server, 'data'), { recursive: true });
  for (const file of ['index.js', 'store.js', 'db.js', 'reports.js', 'courseRoomAssignment.js']) fs.copyFileSync(path.join(root, 'server', file), path.join(server, file));
  fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(isolatedRoot, 'node_modules/sql.js'), { recursive: true });
  const seed = {
    sessions: [{ id: 'S', room: 'R', date: '2026-11-01', startTime: '09:00', endTime: '11:00', taNeeded: 2, doctorNeeded: 0 }],
    invigilators: ['001', '002'].map((id) => ({ id, staffId: id, name: `Person ${id}`, role: 'TA', loadType: 'full', maxHours: 0 })),
    assignments: [{ id: 'A', sessionId: 'S', invigilatorId: '001', role: 'TA' }],
    engagements: [{ id: 'E', staffId: '001', date: '2026-11-02', startTime: '09:00', endTime: '10:00', engagement: 1 }],
    superAssignments: [{ id: 'SU', invigilatorId: '001', date: '2026-11-01' }],
    controlSessions: [{ id: 'C', date: '2026-11-03', startTime: '09:00', endTime: '10:00', taNeeded: 1 }],
    controlAssignments: [{ id: 'CA', controlSessionId: 'C', invigilatorId: '001', role: 'TA' }],
    onCallAssignments: [],
    staffHourPolicies: [{ id: 'P', invigilatorId: '001', staffId: '001', role: 'TA', mode: 'reduce', hoursValue: 1, excludeFromAutoSchedule: false, notes: 'Keep' }],
  };
  for (const file of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(server, 'data', file), JSON.stringify(seed));
  const child = spawn(process.execPath, [path.join(server, 'index.js')], {
    cwd: isolatedRoot, env: { ...process.env, PORT: '3193', NODE_PATH: path.join(root, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = 'http://127.0.0.1:3193';
  const get = async (route) => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json(); };
  const post = async (rows, status = 200) => {
    const response = await fetch(base + '/api/import/invigilators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/sessions')).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, stderr);
    const before = await get('/api/data/export');
    const a = before.invigilators.find((person) => person.staffId === '001');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Instructions']]), 'Instructions');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Staff info'], [], ['Staff ID', 'Name', 'Role', 'Max Hours'], ['001', 'Updated person', 'TA', 8], ['003', 'New doctor', 'Doctor', 10]]), 'Staff Info');
    const rows = readInvigilatorsWorkbook(workbook);
    assert.equal(rows[0].__importRow, 4);
    const imported = await post(rows);
    assert.equal(imported.created, 1); assert.equal(imported.updated, 1); assert.equal(imported.count, 3);
    let data = await get('/api/data/export');
    assert.equal(data.invigilators.find((person) => person.staffId === '001').id, a.id);
    assert.equal(data.invigilators.find((person) => person.staffId === '001').maxHours, 8);
    assert.ok(data.invigilators.some((person) => person.staffId === '002'), 'Unlisted staff must remain.');
    for (const key of ['sessions', 'assignments', 'engagements', 'superAssignments', 'controlSessions', 'controlAssignments', 'onCallAssignments', 'staffHourPolicies']) assert.deepEqual(data[key], before[key], key);
    assert.equal((await post(rows)).unchanged, 2);
    const snapshot = await get('/api/data/export');
    const duplicate = await post([
      { StaffID: '004', Name: 'A', Role: 'TA', __importRow: 139 },
      { StaffID: '004', Name: 'B', Role: 'Doctor', __importRow: 140 },
      { StaffID: '005', Name: 'Must not be saved', Role: 'TA' },
    ], 400);
    assert.equal(duplicate.errors.length, 2); assert.equal(duplicate.errors[0].row, 139);
    assert.match(duplicate.errors[0].error, /139, 140/);
    for (const row of [
      { Name: 'Missing identifier', Role: 'TA' },
      { StaffID: 'NEW', Role: 'Doctor' },
      { StaffID: 'NEW', Name: 'Missing role' },
      { StaffID: 'NEW', Name: 'Invalid role', Role: 'anything' },
      { StaffID: 'NEW', Name: 'Invalid load', Role: 'TA', LoadType: 'other' },
      { StaffID: 'NEW', Name: 'Negative hours', Role: 'TA', MaxHours: -1 },
      { StaffID: 'NEW', Name: 'Invalid hours', Role: 'TA', MaxHours: 'bad' },
      { StaffID: '001', Name: 'Role change', Role: 'Doctor' },
    ]) await post([row], 400);
    await post([], 400);
    assert.deepEqual(await get('/api/data/export'), snapshot, 'Rejected files must not alter stored data.');
    // Optional regression against the reported workbook, when still present.
    const userFile = 'D:/schedule group/Fall2026_2027/NEW MID/inv/invigilators_template (1).xlsx';
    if (fs.existsSync(userFile)) {
      const actualRows = readInvigilatorsWorkbook(XLSX.readFile(userFile));
      const counts = new Map();
      actualRows.forEach((row) => counts.set(row.StaffID, (counts.get(row.StaffID) || 0) + 1));
      if ([...counts.values()].some((count) => count > 1)) {
        const result = await post(actualRows, 400);
        assert.ok(result.errors.some((error) => error.error.includes('Duplicate StaffID')));
        assert.deepEqual(await get('/api/data/export'), snapshot);
      }
    }
    console.log('PASS: staff table/header detection, ID-based updates, stable IDs, preserved related records, duplicate diagnostics, atomic validation, field validation, role-change protection, unchanged re-imports.');
  } finally {
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const resolved = fs.realpathSync(isolatedRoot);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
