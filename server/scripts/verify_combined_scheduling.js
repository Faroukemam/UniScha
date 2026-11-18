// Run: node server/scripts/verify_combined_scheduling.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '../..');
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-combined-'));
  const server = path.join(isolatedRoot, 'server');
  fs.mkdirSync(path.join(server, 'data'), { recursive: true });
  fs.mkdirSync(path.join(server, 'scripts'));
  for (const file of ['index.js', 'store.js', 'db.js', 'reports.js', 'courseRoomAssignment.js']) fs.copyFileSync(path.join(root, 'server', file), path.join(server, file));
  fs.copyFileSync(path.join(__dirname, 'auto_schedule.py'), path.join(server, 'scripts/auto_schedule.py'));
  fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(isolatedRoot, 'node_modules/sql.js'), { recursive: true });
  const seed = {
    sessions: [
      { id: 'S0', room: 'R0', date: '2026-11-06', startTime: '09:00', endTime: '11:00', taNeeded: 1, doctorNeeded: 0 },
      { id: 'S1', room: 'R1', date: '2026-11-07', startTime: '09:00', endTime: '10:00', taNeeded: 1, doctorNeeded: 1 },
    ],
    invigilators: ['A', 'B', 'D', 'E'].map((id) => ({ id, staffId: id, name: id, role: ['D', 'E'].includes(id) ? 'Doctor' : 'TA', maxHours: 0 })),
    assignments: [{ id: 'FIXED', sessionId: 'S0', invigilatorId: 'A', role: 'TA', locked: true, assignmentSource: 'manual' }],
    engagements: [], superAssignments: [], controlSessions: [], controlAssignments: [],
    onCallAssignments: [{ id: 'RESERVE', date: '2026-11-06', startTime: '09:00', endTime: '11:00', invigilatorId: 'D', role: 'Doctor' }],
    staffHourPolicies: [], onCallConfig: { mode: 'fixed_per_period', fixedTAsPerPeriod: 1, fixedDoctorsPerPeriod: 1, excludedInvigilatorIds: ['A'] },
  };
  for (const file of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(server, 'data', file), JSON.stringify(seed));
  const child = spawn(process.execPath, [path.join(server, 'index.js')], { cwd: isolatedRoot, env: { ...process.env, PORT: '3190', NODE_PATH: path.join(root, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = 'http://127.0.0.1:3190';
  const request = async (route, body, status = 200, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const preview = (mode = 'preserve_all', roleScope = 'both') => request('/api/scheduling/combined/preview', { mode, roleScope });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/sessions')).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, stderr);
    const before = await request('/api/data/export');
    const plan = await preview();
    assert.equal(plan.combined, true); assert.ok(plan.planToken);
    assert.equal(plan.sessionShortage, 0); assert.equal(plan.onCallShortage, 0);
    const ta = plan.staffLoads.filter((person) => person.role === 'TA');
    assert.deepEqual(ta.map((person) => person.totalHours).sort(), [3, 3], 'Both duty types must balance as one total.');
    assert.equal(ta.find((person) => person.staffId === 'A').onCallHours, 0, 'On-call exclusions must not exclude exam duties.');
    assert.deepEqual(await request('/api/data/export'), before, 'Preview must not persist.');
    const saved = await request('/api/scheduling/combined/apply', { planToken: plan.planToken });
    assert.equal(saved.dryRun, false); assert.equal(saved.shortageRemaining, 0);
    const after = await request('/api/data/export');
    const p0 = before.assignments[0];
    assert.ok(after.assignments.some((item) => item.id === p0.id));
    assert.ok(after.onCallAssignments.some((item) => item.id === before.onCallAssignments[0].id));
    const view = await request('/api/scheduling/combined');
    assert.equal(view.sessions.length, 2); assert.equal(view.onCall.periods.length, 2);
    const people = new Map(after.invigilators.map((person) => [person.id, person.staffId]));
    const actual = [
      ...after.assignments.map((item) => { const session = after.sessions.find((s) => s.id === item.sessionId); return `Session|${session.date}|${session.startTime}|${session.endTime}|${people.get(item.invigilatorId)}|${item.role}`; }),
      ...after.onCallAssignments.map((item) => `On-call|${item.date}|${item.startTime}|${item.endTime}|${people.get(item.invigilatorId)}|${item.role}`),
    ].sort();
    const expected = plan.duties.map((item) => `${item.DutyType}|${item.Date}|${item.Start}|${item.End}|${item.StaffID}|${item.Role}`).sort();
    assert.deepEqual(actual, expected, 'Apply must save the exact preview, not rerun the solver.');
    await request('/api/scheduling/combined/apply', { planToken: plan.planToken }, 409);
    const scoped = await preview('rebalance_all', 'ta_only');
    await request('/api/scheduling/combined/apply', { planToken: scoped.planToken });
    const scopedAfter = await request('/api/data/export');
    assert.deepEqual(scopedAfter.assignments.filter((item) => item.role === 'Doctor'), after.assignments.filter((item) => item.role === 'Doctor'));
    assert.deepEqual(scopedAfter.onCallAssignments.filter((item) => item.role === 'Doctor'), after.onCallAssignments.filter((item) => item.role === 'Doctor'));
    const reservesOnly = await request('/api/scheduling/combined/preview', { mode: 'rebalance_all', roleScope: 'both', dutyScope: 'on_call' });
    await request('/api/scheduling/combined/apply', { planToken: reservesOnly.planToken });
    assert.deepEqual((await request('/api/data/export')).assignments, scopedAfter.assignments, 'Reserve-only planning must preserve every exam assignment.');
    const stale = await preview();
    await request('/api/staff-hour-policies', { staffId: 'A', mode: 'exact', hoursValue: 2, allowEngagementOverride: false }, 201);
    await request('/api/scheduling/combined/apply', { planToken: stale.planToken }, 409);
    const constrained = await preview('rebalance_all');
    assert.equal(constrained.sessionShortage, 0, 'Exam coverage takes priority over reserves.');
    assert.ok(constrained.onCallShortage > 0);
    assert.ok(constrained.staffLoads.find((person) => person.staffId === 'A').totalHours <= 2);
    assert.equal(constrained.policyMode, 'strict', 'Omitting policyMode must retain strict policies.');
    const relaxedRequest = (extra = {}) => request('/api/scheduling/combined/preview', { mode: 'rebalance_all', roleScope: 'both', policyMode: 'cover_shortage', ...extra });
    const relaxed = await relaxedRequest();
    assert.equal(relaxed.sessionShortage, 0); assert.equal(relaxed.onCallShortage, 0);
    assert.ok(relaxed.policyOverrides.some((row) => row.Rule === 'Hour-policy limit' && row.StaffID === 'A'));
    const protectedPlan = await relaxedRequest({ shortageExcludedInvigilatorIds: ['B'] });
    assert.ok(!protectedPlan.duties.some((row) => row.StaffID === 'B'), 'Explicit shortage exclusions must not be overridden.');
    assert.equal(protectedPlan.shortageExcludedStaff[0].StaffID, 'B');
    assert.ok(protectedPlan.shortageStaff.some((row) => row.id === 'B' && row.newDuties === 0), 'Excluded staff must remain available for a later Keep choice.');
    assert.equal(protectedPlan.sessionShortage, 0, 'Protected staff cannot cause reserves to displace exams.');
    assert.ok(protectedPlan.onCallShortage > 0);
    await request('/api/scheduling/combined/preview', { policyMode: 'cover_shortage', shortageExcludedInvigilatorIds: ['unknown'] }, 400);
    await request('/api/scheduling/combined/preview', { policyMode: 'bad-mode' }, 400);
    await request('/api/engagements', { staffId: 'B', date: '2026-11-07', startTime: '09:00', endTime: '10:00', notes: 'Requested day off' }, 201);
    await request('/api/staff-hour-policies', { staffId: 'E', mode: 'exclude', allowEngagementOverride: false }, 201);
    const priorOverrides = await request('/api/data/export');
    const exceptionPlan = await relaxedRequest();
    assert.equal(exceptionPlan.sessionShortage, 0); assert.equal(exceptionPlan.onCallShortage, 0);
    assert.ok(exceptionPlan.policyOverrides.some((row) => row.Rule === 'Unavailable' && row.StaffID === 'B'));
    assert.ok(exceptionPlan.policyOverrides.some((row) => row.Rule === 'Staff excluded' && row.StaffID === 'E'));
    assert.deepEqual(await request('/api/data/export'), priorOverrides, 'Override preview must not edit any data.');
    await request('/api/scheduling/combined/apply', { planToken: exceptionPlan.planToken });
    const appliedOverrides = await request('/api/data/export');
    assert.deepEqual(appliedOverrides.staffHourPolicies, priorOverrides.staffHourPolicies, 'Saving exceptions must preserve policy definitions.');
    assert.deepEqual(appliedOverrides.engagements, priorOverrides.engagements, 'Saving exceptions must preserve availability.');
    await request('/api/scheduling/combined/apply', { planToken: 'missing' }, 409);
    // Directly verify exam priority for CP-SAT and the no-OR-Tools fallback.
    const python = `import importlib.util,json\ns=importlib.util.spec_from_file_location('m',r'${path.join(__dirname, 'auto_schedule.py').replace(/\\/g, '/')}');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np={'sessions':[{'id':'reserve1','date':'2026-11-06','startTime':'09:00','endTime':'10:00','ta_needed':1,'duty_type':'on_call'},{'id':'reserve2','date':'2026-11-06','startTime':'10:00','endTime':'11:00','ta_needed':1,'duty_type':'on_call'},{'id':'exam','date':'2026-11-06','startTime':'09:00','endTime':'11:00','ta_needed':1}],'invigilators':[{'staff_id':'A','role':'TA'}],'options':{'time_limit_seconds':1}}\nfor fallback in [False,True]:\n if fallback:m.cp_model=None\n r=m.solve(p)\n assert [a['session_id'] for a in r['assignments']]==['exam'],r\nprint('priority passed')`;
    const checked = spawnSync('python', ['-c', python], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    console.log('PASS: joint coverage and fairness, session priority, strict default, optional hour/availability/exclusion overrides, protected staff, exact apply, unchanged policies and availability, role scopes, stale/replayed tokens.');
  } finally {
    child.kill(); await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const resolved = fs.realpathSync(isolatedRoot); assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
