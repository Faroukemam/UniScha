// Run: node server/scripts/verify_policy_refresh_api.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '../..');
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-policy-refresh-'));
  const isolatedServer = path.join(isolatedRoot, 'server');
  fs.mkdirSync(path.join(isolatedServer, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(isolatedServer, 'data'));
  for (const name of ['index.js', 'store.js', 'db.js', 'reports.js', 'courseRoomAssignment.js']) {
    fs.copyFileSync(path.join(root, 'server', name), path.join(isolatedServer, name));
  }
  const indexPath = path.join(isolatedServer, 'index.js');
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace('const COMBINED_PLAN_TTL_MS = 10 * 60 * 1000;', 'const COMBINED_PLAN_TTL_MS = 3000;'));
  const solver = fs.readFileSync(path.join(__dirname, 'auto_schedule.py'), 'utf8');
  const solverRunsPath = path.join(isolatedRoot, 'solver-runs.txt');
  // A brief delay makes an intervening edit deterministic for this test only.
  fs.writeFileSync(path.join(isolatedServer, 'scripts/auto_schedule.py'), `import time\nwith open(${JSON.stringify(solverRunsPath)}, 'a') as runs: runs.write('x')\ntime.sleep(1)\n${solver}`);
  fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(isolatedRoot, 'node_modules/sql.js'), { recursive: true });
  const seed = {
    sessions: [{ id: 'S', room: 'R', date: '2026-11-01', startTime: '09:00', endTime: '11:00', taNeeded: 2, doctorNeeded: 0 }],
    invigilators: ['A', 'B'].map((id) => ({ id, staffId: id, name: id, role: 'TA', maxHours: 0 })),
    assignments: [], engagements: [], superAssignments: [], controlSessions: [], controlAssignments: [], onCallAssignments: [],
    onCallConfig: { mode: 'fixed_per_period', fixedTAsPerPeriod: 0, fixedDoctorsPerPeriod: 0 },
    staffHourPolicies: [{ id: 'P', invigilatorId: 'A', staffId: 'A', role: 'TA', mode: 'reduce', hoursValue: 1 }],
  };
  for (const name of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(isolatedServer, 'data', name), JSON.stringify(seed));
  const child = spawn(process.execPath, [path.join(isolatedServer, 'index.js')], {
    cwd: isolatedRoot, env: { ...process.env, PORT: '3192', NODE_PATH: path.join(root, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = 'http://127.0.0.1:3192';
  const get = async (route) => {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok([200, 201].includes(response.status), JSON.stringify(await response.clone().json()));
    return response.json();
  };
  try {
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(base + '/api/sessions')).ok) { ready = true; break; } } catch (_error) {}
      await delay(100);
    }
    assert.ok(ready, stderr);
    let data = await get('/api/staff-hour-policies');
    const find = (rows, id) => rows.find((row) => row.staffId === id);
    assert.equal(find(data.rows, 'A').effectivePolicy.allowedHours, 1);
    const sessions = await get('/api/sessions');
    await post('/api/import/session-needs', { rows: [{ SessionID: sessions[0].id, TANeeded: 4, DoctorNeeded: 0 }] });
    data = await get('/api/staff-hour-policies');
    assert.equal(data.averagesByRole.TA, 4);
    assert.equal(find(data.rows, 'A').effectivePolicy.allowedHours, 3);
    const exported = await get('/api/export/staff-hour-policies');
    const workbookResponse = await fetch(base + exported.url);
    const workbook = XLSX.read(Buffer.from(await workbookResponse.arrayBuffer()), { type: 'buffer' });
    const exportedPolicy = XLSX.utils.sheet_to_json(workbook.Sheets.StaffHourPolicies).find((row) => row.StaffID === 'A');
    assert.equal(exportedPolicy.RoleAverageHours, 4);
    assert.equal(exportedPolicy.EffectiveAllowedHours, 3);
    assert.equal(exportedPolicy.EffectiveLimitHours, 3);
    await post('/api/staff-hour-policies', { staffId: 'A', mode: 'exact', hoursValue: 2 });
    assert.equal(find((await get('/api/staff-hour-policies')).rows, 'A').effectivePolicy.hardLimitHours, 2);

    const schedule = fetch(base + '/api/scheduling/auto-schedule-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    await delay(200);
    await post('/api/staff-hour-policies', { staffId: 'A', mode: 'exact', hoursValue: 0 });
    const scheduled = await schedule;
    const stale = await scheduled.json();
    assert.equal(scheduled.status, 409, JSON.stringify(stale));
    assert.match(stale.error, /changed during the preview/);
    data = await get('/api/staff-hour-policies');
    assert.equal(find(data.rows, 'A').effectivePolicy.hardLimitHours, 0);
    assert.equal((await get('/api/data/export')).assignments.length, 0);
    const rejected = async (route, body) => {
      const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 409, JSON.stringify(await response.json()));
    };
    const applyRoute = '/api/scheduling/auto-schedule';
    const exportRoute = '/api/scheduling/auto-schedule-preview/export';
    await rejected(applyRoute, {});
    await rejected(exportRoute, {});
    await rejected(applyRoute, { planToken: 'missing' });
    const preview = await post('/api/scheduling/auto-schedule-preview', { mode: 'rebalance_all', roleScope: 'both' });
    assert.ok(preview.planToken);
    const solverRuns = fs.readFileSync(solverRunsPath, 'utf8');
    const beforeExport = await get('/api/data/export');
    const file = await post(exportRoute, { planToken: preview.planToken });
    const exportedWorkbook = XLSX.read(Buffer.from(await (await fetch(base + file.url)).arrayBuffer()), { type: 'buffer' });
    const exportedAssignments = XLSX.utils.sheet_to_json(exportedWorkbook.Sheets.PreviewAssignments);
    const expected = preview.solver.assignments.map((row) => `${row.session_id}|${row.staff_id}|${row.role}`).sort();
    assert.deepEqual(exportedAssignments.map((row) => `${row.SessionID}|${row.StaffID}|${row.Role}`).sort(), expected);
    assert.deepEqual(await get('/api/data/export'), beforeExport, 'Export must not persist assignments.');
    const applied = await post(applyRoute, { planToken: preview.planToken });
    const afterApply = await get('/api/data/export');
    const staffIds = new Map(afterApply.invigilators.map((person) => [person.id, person.staffId]));
    assert.deepEqual(afterApply.assignments.map((row) => `${row.sessionId}|${staffIds.get(row.invigilatorId)}|${row.role}`).sort(), expected);
    assert.equal(applied.shortageRemaining, preview.previewTotalShortage);
    assert.equal(fs.readFileSync(solverRunsPath, 'utf8'), solverRuns, 'Save and export must never run the solver again.');
    await rejected(applyRoute, { planToken: preview.planToken });

    const stalePlan = await post('/api/scheduling/auto-schedule-preview', { mode: 'preserve_all' });
    await post('/api/staff-hour-policies', { staffId: 'B', mode: 'exact', hoursValue: 2 });
    const changed = await get('/api/data/export');
    await rejected(applyRoute, { planToken: stalePlan.planToken });
    await rejected(exportRoute, { planToken: stalePlan.planToken });
    assert.deepEqual(await get('/api/data/export'), changed, 'Stale saves must retain intervening edits.');

    const expiredPlan = await post('/api/scheduling/auto-schedule-preview', { mode: 'preserve_all' });
    await delay(3100);
    await rejected(exportRoute, { planToken: expiredPlan.planToken });
    await rejected(applyRoute, { planToken: expiredPlan.planToken });
    console.log('PASS: policy refresh, concurrent preview edits, exact session save/export without rerunning, unchanged export data, missing/stale/expired/replayed tokens.');
  } finally {
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const resolvedRoot = fs.realpathSync(isolatedRoot);
    assert.ok(resolvedRoot.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
