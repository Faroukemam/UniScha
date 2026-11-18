// Run: node server/scripts/verify_consecutive_preferences_api.js
// Uses an isolated server and a legacy SQLite schema; never changes live data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');
const initSqlJs = require('sql.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '../..');
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-continuity-'));
  const server = path.join(isolated, 'server');
  fs.mkdirSync(path.join(server, 'data'), { recursive: true });
  fs.mkdirSync(path.join(server, 'scripts'));
  for (const file of ['index.js', 'store.js', 'db.js', 'reports.js', 'courseRoomAssignment.js']) fs.copyFileSync(path.join(root, 'server', file), path.join(server, file));
  fs.copyFileSync(path.join(__dirname, 'auto_schedule.py'), path.join(server, 'scripts/auto_schedule.py'));
  fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(isolated, 'node_modules/sql.js'), { recursive: true });
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run('CREATE TABLE staff_hour_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, mode TEXT DEFAULT "default", hours_value REAL DEFAULT 0, exclude_from_auto_schedule INTEGER DEFAULT 0, notes TEXT DEFAULT "")');
  fs.writeFileSync(path.join(server, 'data/scheduler.sqlite'), Buffer.from(legacy.export()));
  legacy.close();
  const seed = {
    sessions: [0, 1, 2].map((i) => ({ id: `S${i}`, room: `R${i}`, date: '2026-11-01', startTime: `${9+i}:00`.padStart(5, '0'), endTime: `${10+i}:00`, taNeeded: 1, doctorNeeded: 0 })),
    invigilators: ['A', 'B'].map((id) => ({ id, staffId: id, name: id, role: 'TA', maxHours: 0 })),
    assignments: [0, 2].map((i) => ({ id: `LOCK${i}`, sessionId: `S${i}`, invigilatorId: 'A', role: 'TA', locked: true, assignmentSource: 'manual' })),
    engagements: [], superAssignments: [], controlSessions: [], controlAssignments: [], onCallAssignments: [],
    onCallConfig: { mode: 'fixed_per_period', fixedTAsPerPeriod: 0, fixedDoctorsPerPeriod: 0 },
    staffHourPolicies: [{ id: 'P', invigilatorId: 'A', staffId: 'A', role: 'TA', mode: 'default', hoursValue: 0 }],
  };
  for (const name of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(server, 'data', name), JSON.stringify(seed));
  const base = 'http://127.0.0.1:3196';
  let child, stderr = '';
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  };
  const start = async () => {
    child = spawn(process.execPath, [path.join(server, 'index.js')], { cwd: isolated, env: { ...process.env, PORT: '3196', NODE_PATH: path.join(root, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.on('data', (data) => { stderr += data; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/sessions')).ok) return; } catch {}
      await delay(100);
    }
    throw new Error(stderr || 'Server startup timed out');
  };
  const request = async (route, body, status = 200, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const save = (extra) => request('/api/staff-hour-policies', { staffId: 'A', mode: 'default', hoursValue: 0, allowEngagementOverride: false, ...extra }, 201);
  try {
    await start();
    const configDefaults = await request('/api/scheduling/config');
    assert.equal(configDefaults.scoringMode, 'ranked');
    const weightedConfig = { ...configDefaults, scoringMode: 'weighted', preferenceOrder: [...configDefaults.preferenceOrder].reverse(), weights: { ...configDefaults.weights, consecutive_days: 321 } };
    await request('/api/scheduling/config', { ...weightedConfig, weights: {} }, 400, 'PATCH');
    await request('/api/scheduling/config', { ...weightedConfig, dailySoftTarget: -1 }, 400, 'PATCH');
    await request('/api/scheduling/config', weightedConfig, 200, 'PATCH');
    assert.deepEqual(await request('/api/scheduling/config'), weightedConfig);
    const configPreview = await request('/api/scheduling/combined/preview', { mode: 'preserve_all' });
    assert.equal(configPreview.scoringMode, 'weighted');
    assert.deepEqual(configPreview.preferenceWeights, weightedConfig.weights);
    assert.deepEqual(configPreview.preferenceOrder, weightedConfig.preferenceOrder);
    await request('/api/scheduling/config', configDefaults, 200, 'PATCH');
    await request('/api/scheduling/combined/apply', { planToken: configPreview.planToken }, 409);
    let policies = await request('/api/staff-hour-policies');
    assert.equal(policies.rows.find((row) => row.staffId === 'A').effectivePolicy.preferConsecutiveDuties, false);
    assert.equal(policies.rows.find((row) => row.staffId === 'A').effectivePolicy.allowEngagementOverride, true, 'Legacy policies default to allowing engagement overrides.');
    assert.equal(policies.rows.find((row) => row.staffId === 'B').effectivePolicy.allowEngagementOverride, true, 'Staff without a saved policy also default on.');
    await save({ preferConsecutiveDuties: true, preferConsecutiveDays: false });
    policies = await request('/api/staff-hour-policies');
    let a = policies.rows.find((row) => row.staffId === 'A');
    assert.equal(a.policy.preferConsecutiveDuties, true); assert.equal(a.policy.preferConsecutiveDays, false);
    assert.ok(policies.warnings.some((message) => message.includes('60 idle minutes')));

    await request('/api/scheduling/assign/LOCK2', undefined, 200, 'DELETE');
    const manual = await request('/api/scheduling/assign', { sessionId: 'S2', invigilatorId: 'A' }, 201);
    assert.match(manual.continuityWarning, /60 idle minutes/);
    const preview = await request('/api/scheduling/auto-schedule-preview', { mode: 'preserve_all' });
    assert.equal(preview.previewTotalShortage, 0);
    assert.equal(preview.continuity[0].idleMinutes, 60);
    assert.equal(preview.solver.assignments.find((row) => row.session_id === 'S1').staff_id, 'B', 'A continuity preference must not increase an already higher workload.');
    const exported = await request('/api/scheduling/auto-schedule-preview/export', { planToken: preview.planToken });
    const workbook = XLSX.read(Buffer.from(await (await fetch(base + exported.url)).arrayBuffer()), { type: 'buffer' });
    const continuity = XLSX.utils.sheet_to_json(workbook.Sheets.StaffContinuity);
    assert.equal(continuity[0].idleMinutes, 60);

    await save({ preferConsecutiveDuties: false, preferConsecutiveDays: true });
    a = (await request('/api/staff-hour-policies')).rows.find((row) => row.staffId === 'A');
    assert.equal(a.policy.preferConsecutiveDuties, false); assert.equal(a.policy.preferConsecutiveDays, true);
    await save({ mode: 'exact', hoursValue: 4, preferConsecutiveDuties: true, preferConsecutiveDays: true });
    await request('/api/engagements', { staffId: 'A', date: '2026-11-01', startTime: '10:00', endTime: '11:00' }, 201);
    const engagedPlan = await request('/api/scheduling/combined/preview', { mode: 'preserve_all', policyMode: 'cover_shortage' });
    assert.equal(engagedPlan.duties.find((row) => row.Start === '10:00').StaffID, 'B', 'Continuity cannot override an engagement even in shortage mode.');
    assert.equal(engagedPlan.policyOverrides.filter((row) => row.StaffID === 'A').length, 0);
    await request('/api/engagements', undefined, 200, 'DELETE');
    await save({ mode: 'exact', hoursValue: 2, preferConsecutiveDuties: true, preferConsecutiveDays: true });
    const protectedPlan = await request('/api/scheduling/combined/preview', { mode: 'preserve_all', policyMode: 'cover_shortage' });
    assert.equal(protectedPlan.staffLoads.find((row) => row.staffId === 'A').totalHours, 2);
    assert.equal(protectedPlan.continuity.find((row) => row.staffId === 'A').idleMinutes, 60);
    assert.equal(protectedPlan.policyOverrides.filter((row) => row.StaffID === 'A').length, 0);
    await request('/api/scheduling/combined/apply', { planToken: protectedPlan.planToken });

    // The dedicated on-call entry point must use the same preferences and caps.
    await request('/api/on-call/config', { mode: 'fixed_per_period', fixedTAsPerPeriod: 1, fixedDoctorsPerPeriod: 0 }, 200, 'PATCH');
    const before = await request('/api/data/export');
    const reserves = await request('/api/on-call/auto-assign', { dryRun: true });
    assert.ok(reserves.selectedSolver);
    assert.equal(reserves.totalRemainingShortage, 1);
    assert.ok(reserves.createdAssignments.every((row) => row.invigilatorId !== 'A'));
    assert.deepEqual((await request('/api/data/export')).assignments, before.assignments);
    assert.deepEqual((await request('/api/data/export')).onCallAssignments, before.onCallAssignments);

    // Default staff must get the same balancing path without either checkbox.
    await save({ preferConsecutiveDuties: false, preferConsecutiveDays: false });
    const defaultsBefore = await request('/api/data/export');
    const defaultReserves = await request('/api/on-call/auto-assign', { dryRun: true });
    assert.ok(defaultReserves.selectedSolver);
    assert.equal(defaultReserves.totalRemainingShortage, 0);
    assert.equal(defaultReserves.defaultStaffBalance.find((row) => row.role === 'TA' && row.dutyType === 'on_call').staffCount, 2);
    assert.deepEqual(await request('/api/data/export'), defaultsBefore, 'Default balancing preview must not persist.');
    await save({ mode: 'exact', hoursValue: 2, preferConsecutiveDuties: true, preferConsecutiveDays: true });

    const storedDb = new SQL.Database(fs.readFileSync(path.join(server, 'data/scheduler.sqlite')));
    assert.deepEqual(storedDb.exec("SELECT prefer_consecutive_duties, prefer_consecutive_days FROM staff_hour_policies WHERE staff_id='A'")[0].values, [[1, 1]]);
    storedDb.close();
    const backup = JSON.parse(fs.readFileSync(path.join(server, 'data/store.last-good.json'), 'utf8'));
    assert.equal(backup.staffHourPolicies.find((row) => row.staffId === 'A').preferConsecutiveDays, true);
    await stop();
    for (const name of ['store.json', 'store.last-good.json']) fs.unlinkSync(path.join(server, 'data', name));
    await start();
    a = (await request('/api/staff-hour-policies')).rows.find((row) => row.staffId === 'A');
    assert.equal(a.policy.preferConsecutiveDuties, true); assert.equal(a.policy.preferConsecutiveDays, true);
    assert.equal(a.effectivePolicy.hardLimitHours, 2);
    assert.equal(a.policy.allowEngagementOverride, false, 'An explicit opt-out survives SQLite recovery.');
    await save({ mode: 'exact', hoursValue: 2, preferConsecutiveDuties: true, preferConsecutiveDays: true, allowEngagementOverride: true });
    await request('/api/staff-hour-policies', { staffId: 'B', mode: 'exclude' }, 201);
    await request('/api/on-call/config', { mode: 'fixed_per_period', fixedTAsPerPeriod: 0, fixedDoctorsPerPeriod: 0 }, 200, 'PATCH');
    await request('/api/engagements', { staffId: 'A', date: '2026-11-01', startTime: '09:00', endTime: '12:00', notes: 'Unavailable all morning' }, 201);
    const engagementBefore = await request('/api/data/export');
    const overridePlan = await request('/api/scheduling/combined/preview', { mode: 'rebalance_all', policyMode: 'cover_shortage' });
    assert.equal(overridePlan.sessionShortage, 1, 'Engagement permission must not relax the 2h cap or B exclusion, even in shortage mode.');
    assert.equal(overridePlan.engagementOverrides.length, 2);
    assert.equal(overridePlan.engagementOverrideMinutes, 120);
    assert.ok(overridePlan.engagementOverrides.every((row) => row.staffId === 'A'));
    assert.deepEqual(await request('/api/data/export'), engagementBefore, 'Preview must not persist assignments or change engagements.');
    await request('/api/scheduling/combined/apply', { planToken: overridePlan.planToken });
    const overrideReport = await request('/api/reports/engagement-overrides');
    assert.deepEqual(overrideReport.summary, { affectedStaff: 1, affectedDuties: 2, overlapMinutes: 120 });
    assert.equal(overrideReport.rows.length, 2);
    assert.ok(overrideReport.rows.every((row) => row.reason.startsWith('Cover exam shortage')));
    assert.ok(overrideReport.rows.every((row) => row.engagementNotes === 'Unavailable all morning' && row.currentlyAllowed === 'Yes'));
    assert.equal((await request('/api/reports/engagement-overrides?role=Doctor')).rows.length, 0);
    assert.equal((await request('/api/reports/engagement-overrides?staffId=B')).rows.length, 0);
    const sessionOverridePlan = await request('/api/scheduling/auto-schedule-preview', { mode: 'rebalance_all' });
    assert.equal(sessionOverridePlan.engagementOverrides.length, 2);
    const overrideExport = await request('/api/scheduling/auto-schedule-preview/export', { planToken: sessionOverridePlan.planToken });
    const overrideWorkbook = XLSX.read(Buffer.from(await (await fetch(base + overrideExport.url)).arrayBuffer()), { type: 'buffer' });
    assert.equal(XLSX.utils.sheet_to_json(overrideWorkbook.Sheets.EngagementOverrides).length, 2);
    const policyExport = await request('/api/export/staff-hour-policies');
    const policyWorkbook = XLSX.read(Buffer.from(await (await fetch(base + policyExport.url)).arrayBuffer()), { type: 'buffer' });
    assert.equal(XLSX.utils.sheet_to_json(policyWorkbook.Sheets.StaffHourPolicies).find((row) => row.StaffID === 'A').AllowEngagementOverride, 'Yes');
    const imported = await request('/api/import/staff-hour-policies', { rows: [{ StaffID: 'A', Mode: 'exact', HoursValue: 2, AllowEngagementOverride: 'No' }] });
    assert.equal(imported.rejected, 0);
    assert.equal((await request('/api/staff-hour-policies')).rows.find((row) => row.staffId === 'A').policy.allowEngagementOverride, false);
    const noOverride = await request('/api/scheduling/combined/preview', { mode: 'rebalance_all', policyMode: 'cover_shortage', shortageExcludedInvigilatorIds: [(await request('/api/invigilators')).find((row) => row.staffId === 'B').id] });
    assert.equal(noOverride.sessionShortage, 3, 'Turning the checkbox off keeps engagements strict even in shortage mode.');
    assert.equal(noOverride.engagementOverrides.length, 0);
    assert.deepEqual((await request('/api/data/export')).engagements, engagementBefore.engagements);
    // Both exam and on-call reasons survive a real database-only recovery.
    await request('/api/data/import', { data: { ...seed, assignments: [], staffHourPolicies: [],
      engagements: ['A', 'B'].map((staffId) => ({ staffId, date: '2026-11-01', startTime: '09:00', endTime: '12:00', engagement: 1, notes: 'External commitment' })),
      onCallConfig: { mode: 'fixed_per_period', fixedTAsPerPeriod: 1, fixedDoctorsPerPeriod: 0 } } });
    await request('/api/on-call/config', { mode: 'fixed_per_period', fixedTAsPerPeriod: 1, fixedDoctorsPerPeriod: 0 }, 200, 'PATCH');
    const allOverrides = await request('/api/scheduling/combined/preview', { mode: 'rebalance_all' });
    assert.equal(allOverrides.previewTotalShortage, 0);
    assert.equal(allOverrides.engagementOverrides.length, 6);
    await request('/api/scheduling/combined/apply', { planToken: allOverrides.planToken });
    await request('/api/scheduling/config', weightedConfig, 200, 'PATCH');
    await stop();
    for (const name of ['store.json', 'store.last-good.json']) fs.unlinkSync(path.join(server, 'data', name));
    await start();
    assert.deepEqual(await request('/api/scheduling/config'), weightedConfig, 'SQLite recovers custom weights and priorities.');
    const recoveredReport = await request('/api/reports/engagement-overrides');
    assert.deepEqual(recoveredReport.summary, { affectedStaff: 2, affectedDuties: 6, overlapMinutes: 360 });
    assert.ok(recoveredReport.rows.filter((row) => row.dutyType === 'OnCall').every((row) => row.reason.startsWith('Cover on-call shortage')));
    assert.ok(recoveredReport.rows.filter((row) => row.dutyType === 'Session').every((row) => row.reason.startsWith('Cover exam shortage')));
    console.log('PASS: policy migration/defaults, opt-outs, strict caps, engagement permission, preview/apply, reports/reasons, exports/imports, SQLite-only recovery, on-call scheduling and unchanged availability.');
  } finally {
    await stop();
    const resolved = fs.realpathSync(isolated); assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
