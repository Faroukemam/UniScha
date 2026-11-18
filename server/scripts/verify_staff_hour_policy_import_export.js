// Run: node server/scripts/verify_staff_hour_policy_import_export.js
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
  const { readStaffHourPolicyWorkbook } = await import(pathToFileURL(path.join(root, 'client/src/staffHourPolicyWorkbook.mjs')));
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-policy-io-'));
  const server = path.join(isolatedRoot, 'server');
  fs.mkdirSync(path.join(server, 'data'), { recursive: true });
  for (const file of ['index.js', 'store.js', 'db.js', 'reports.js', 'courseRoomAssignment.js']) fs.copyFileSync(path.join(root, 'server', file), path.join(server, file));
  fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(isolatedRoot, 'node_modules/sql.js'), { recursive: true });
  const seed = {
    sessions: [{ id: 'S', room: 'R', date: '2026-11-01', startTime: '09:00', endTime: '11:00', taNeeded: 2, doctorNeeded: 1 }],
    invigilators: ['001', '002', '003'].map((id) => ({ id, staffId: id, name: `Person ${id}`, role: id === '003' ? 'Doctor' : 'TA', maxHours: 0 })),
    assignments: [], engagements: [], superAssignments: [], controlSessions: [], controlAssignments: [], onCallAssignments: [],
    staffHourPolicies: [{ id: 'P', invigilatorId: '001', staffId: '001', role: 'TA', mode: 'reduce', hoursValue: 1, excludeFromAutoSchedule: false, notes: 'Keep' }],
  };
  for (const file of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(server, 'data', file), JSON.stringify(seed));
  const child = spawn(process.execPath, [path.join(server, 'index.js')], {
    cwd: isolatedRoot, env: { ...process.env, PORT: '3195', NODE_PATH: path.join(root, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = 'http://127.0.0.1:3195';
  const get = async (route) => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json(); };
  const post = async (rows, status = 200) => {
    const response = await fetch(base + '/api/import/staff-hour-policies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const workbook = async (route) => {
    const file = await get(route);
    const response = await fetch(base + file.url); assert.equal(response.status, 200);
    return XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/sessions')).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, stderr);
    const exported = await workbook('/api/export/staff-hour-policies');
    const template = await workbook('/api/export/staff-hour-policies/template');
    assert.ok(template.Sheets.Instructions && template.Sheets.Examples);
    const rows = readStaffHourPolicyWorkbook(exported);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].StaffID, '001');
    assert.equal(rows[1].Mode, 'default');
    assert.equal(rows[0].PreferConsecutiveDuties, 'No');
    assert.equal(rows[0].PreferConsecutiveDays, 'No');
    assert.equal(rows[0].AllowEngagementOverride, 'Yes', 'Legacy policies inherit the enabled engagement permission.');
    assert.equal(readStaffHourPolicyWorkbook(template).length, 3);
    const before = (await get('/api/data/export')).staffHourPolicies;
    const roundTrip = await post(rows);
    assert.equal(roundTrip.unchanged, 3);
    assert.equal(roundTrip.imported, 0);
    assert.deepEqual((await get('/api/data/export')).staffHourPolicies, before);
    const changed = await post([
      { 'Staff ID': '001', 'Policy Mode': 'exact', 'Hours Value': 0, 'Exclude From Auto Schedule': 'No', 'Prefer Consecutive Duties': 'Yes', 'Prefer Consecutive Days': 'No' },
      { StaffID: '002', Mode: 'add', HoursValue: 1.5, ExcludeFromAutoSchedule: 'false', PreferConsecutiveDuties: 'false', PreferConsecutiveDays: 'true' },
      { StaffID: '002', Mode: 'reduce', HoursValue: 3 },
      { StaffID: '003', Mode: 'exclude', HoursValue: 0, ExcludeFromAutoSchedule: 'No' },
    ]);
    assert.equal(changed.updated, 1); assert.equal(changed.created, 2); assert.equal(changed.rejected, 1);
    assert.equal(changed.errors[0].row, 4);
    let policies = (await get('/api/data/export')).staffHourPolicies;
    assert.equal(policies.length, 3);
    const a = policies.find((p) => p.staffId === '001');
    assert.equal(a.id, before[0].id); assert.equal(a.hoursValue, 0); assert.equal(a.notes, '');
    assert.equal(a.preferConsecutiveDuties, true); assert.equal(a.preferConsecutiveDays, false);
    assert.equal(policies.find((p) => p.staffId === '002').preferConsecutiveDuties, false);
    assert.equal(policies.find((p) => p.staffId === '002').preferConsecutiveDays, true);
    assert.equal(policies.find((p) => p.staffId === '002').excludeFromAutoSchedule, false);
    assert.equal(policies.find((p) => p.staffId === '003').excludeFromAutoSchedule, true);
    const exportedAgain = readStaffHourPolicyWorkbook(await workbook('/api/export/staff-hour-policies'));
    assert.equal((await post(exportedAgain)).unchanged, 3);
    for (const row of [
      { StaffID: 'missing', Mode: 'exact', HoursValue: 1 },
      { StaffID: '001', Mode: 'invalid' }, { StaffID: '001', Mode: 'exact' },
      { StaffID: '001', Mode: 'add', HoursValue: -1 }, { StaffID: '001', Mode: 'reduce', HoursValue: 'bad' },
      { StaffID: '001', Mode: 'default', ExcludeFromAutoSchedule: 'maybe' },
      { StaffID: '001', Mode: 'default', PreferConsecutiveDuties: 'maybe' },
      { StaffID: '001', Mode: 'default', PreferConsecutiveDays: 'maybe' },
      { StaffID: '002', PolicyID: a.id, Mode: 'exact', HoursValue: 1 },
      { StaffID: '001', InvigilatorID: policies.find((p) => p.staffId === '002').invigilatorId, Mode: 'default' },
    ]) {
      const result = await post([row], 400); assert.equal(result.rejected, 1);
    }
    assert.deepEqual((await get('/api/data/export')).staffHourPolicies, policies);
    const titled = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(titled, XLSX.utils.aoa_to_sheet([['Instructions']]), 'Instructions');
    XLSX.utils.book_append_sheet(titled, XLSX.utils.aoa_to_sheet([['Policies'], [], ['Staff ID', 'Mode', 'Hours Value'], ['001', 'exact', 2]]), 'Policies');
    const titledRows = readStaffHourPolicyWorkbook(titled);
    assert.equal(titledRows[0].__importRow, 4);
    assert.equal((await post([{ ...titledRows[0], Mode: 'bad' }], 400)).errors[0].row, 4);
    await post([], 400);
    const preferencesOnly = await post([{ StaffID: '003', Mode: 'default', HoursValue: 0, PreferConsecutiveDuties: 'Yes', PreferConsecutiveDays: 'Yes' }]);
    assert.equal(preferencesOnly.updated, 1);
    assert.equal((await post(readStaffHourPolicyWorkbook(await workbook('/api/export/staff-hour-policies')))).unchanged, 3);
    console.log('PASS: full-staff export/template, leading-zero IDs, unchanged round trips, upserts, duplicates, zero/decimal hours, exclusions, rejected rows, ID conflicts, worksheet detection and Excel row numbers.');
  } finally {
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const resolved = fs.realpathSync(isolatedRoot);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
