// Run: node server/scripts/verify_staff_hour_on_call_api.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '../..');
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-on-call-hours-'));
  const server = path.join(isolatedRoot, 'server');
  fs.mkdirSync(path.join(server, 'data'), { recursive: true });
  fs.mkdirSync(path.join(server, 'scripts'));
  for (const file of ['index.js', 'store.js', 'db.js', 'reports.js', 'courseRoomAssignment.js']) fs.copyFileSync(path.join(root, 'server', file), path.join(server, file));
  fs.copyFileSync(path.join(__dirname, 'auto_schedule.py'), path.join(server, 'scripts/auto_schedule.py'));
  fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(isolatedRoot, 'node_modules/sql.js'), { recursive: true });
  const seed = {
    sessions: [
      { id: 'S1', room: 'R1', date: '2026-11-06', startTime: '09:00', endTime: '11:00', taNeeded: 1, doctorNeeded: 0 },
      { id: 'S2', room: 'R2', date: '2026-11-06', startTime: '12:00', endTime: '14:00', taNeeded: 1, doctorNeeded: 0 },
      { id: 'S3', room: 'R3', date: '2026-11-07', startTime: '09:00', endTime: '11:00', taNeeded: 1, doctorNeeded: 0 },
    ],
    invigilators: ['A', 'B', 'C', 'D'].map((id) => ({ id, staffId: id, name: id, role: id === 'D' ? 'Doctor' : 'TA', maxHours: 0 })),
    assignments: [{ id: 'AS', sessionId: 'S2', invigilatorId: 'A', role: 'TA', locked: true, assignmentSource: 'manual' }],
    engagements: [],
    superAssignments: [{ id: 'SUP', date: '2026-11-06', invigilatorId: 'B' }],
    controlSessions: [{ id: 'CTRL', date: '2026-11-07', startTime: '14:00', endTime: '15:00', taNeeded: 1, doctorNeeded: 0 }],
    controlAssignments: [{ id: 'CA', controlSessionId: 'CTRL', invigilatorId: 'B', role: 'TA' }],
    onCallAssignments: ['A', 'D'].map((id) => ({ id: `OC${id}`, date: '2026-11-06', startTime: '09:00', endTime: '11:00', invigilatorId: id, role: id === 'D' ? 'Doctor' : 'TA' })),
    onCallConfig: { mode: 'fixed_per_period', fixedTAsPerPeriod: 1, fixedDoctorsPerPeriod: 1 },
    staffHourPolicies: [{ id: 'P', invigilatorId: 'A', staffId: 'A', role: 'TA', mode: 'exact', hoursValue: 4 }],
  };
  for (const file of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(server, 'data', file), JSON.stringify(seed));
  const child = spawn(process.execPath, [path.join(server, 'index.js')], { cwd: isolatedRoot, env: { ...process.env, PORT: '3196', NODE_PATH: path.join(root, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = 'http://127.0.0.1:3196';
  const request = async (route, method = 'GET', body, status = 200) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/sessions')).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, stderr);
    let policies = await request('/api/staff-hour-policies');
    const person = (id) => policies.rows.find((row) => row.staffId === id);
    assert.equal(person('A').sessionHours, 2);
    assert.equal(person('A').onCallHours, 2);
    assert.equal(person('A').onCallCount, 1);
    assert.equal(person('A').currentAssignedHours, 4);
    assert.equal(person('A').remainingHours, 0);
    assert.equal(person('D').onCallHours, 2);
    assert.equal(person('D').currentAssignedHours, 2);
    assert.equal(person('D').remainingHours, null);
    assert.equal(person('B').superHours, 5);
    assert.equal(person('B').controlHours, 1);
    assert.equal(person('B').currentAssignedHours, 6);
    assert.deepEqual(policies.onCallRequiredHoursByRole, { TA: 6, Doctor: 6 });
    assert.deepEqual(policies.totalRequiredHoursByRole, { TA: 13, Doctor: 6 });
    const stored = await request('/api/data/export');
    const future = stored.sessions.find((row) => row.room === 'R3');
    const a = person('A');
    await request('/api/scheduling/assign', 'POST', { sessionId: future.id, invigilatorId: a.id }, 400);
    const preview = await request('/api/scheduling/auto-schedule-preview', 'POST', { mode: 'preserve_all', roleScope: 'both' });
    assert.equal(preview.assignedHoursByStaff.A, 4, 'Solver baseline must include on-call once.');
    const file = await request('/api/export/staff-hour-policies');
    const workbookResponse = await fetch(base + file.url);
    const workbook = XLSX.read(Buffer.from(await workbookResponse.arrayBuffer()), { type: 'buffer' });
    const exported = XLSX.utils.sheet_to_json(workbook.Sheets.StaffHourPolicies).find((row) => row.StaffID === 'A');
    assert.equal(exported.OnCallHours, 2); assert.equal(exported.SessionHours, 2);
    assert.equal(exported.CurrentAssignedHours, 4); assert.equal(exported.RemainingHours, 0);
    assert.equal((await request('/api/data/export')).onCallAssignments.length, 2, 'Export/preview must not change on-call assignments.');
    const onCall = stored.onCallAssignments.find((row) => row.invigilatorId === a.id);
    await request(`/api/on-call/assign/${encodeURIComponent(onCall.id)}`, 'DELETE');
    policies = await request('/api/staff-hour-policies');
    assert.equal(person('A').onCallHours, 0);
    assert.equal(person('A').currentAssignedHours, 2);
    assert.equal(person('A').remainingHours, 2);
    assert.equal(policies.onCallRequiredHoursByRole.TA, 6, 'Unfilled demand remains part of role averages.');
    await request('/api/on-call/assign', 'POST', { date: '2026-11-06', startTime: '09:00', endTime: '11:00', invigilatorId: a.id }, 201);
    policies = await request('/api/staff-hour-policies');
    assert.equal(person('A').currentAssignedHours, 4);
    assert.equal(person('A').remainingHours, 0);
    console.log('PASS: full on-call duration counted once, TA/Doctor totals, other duty breakdowns, remaining limits, manual policy enforcement, solver baseline, export, add/remove refresh, required on-call hours.');
  } finally {
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const resolved = fs.realpathSync(isolatedRoot);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
