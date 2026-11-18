// Every registered API route is called in a disposable server; live data is untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = process.env.REVIEW_OUTPUT || path.join(root, 'artifacts/application-review');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'unisc-endpoints-'));
  const server = path.join(temporary, 'server');
  fs.mkdirSync(path.join(server, 'data'), { recursive: true });
  fs.mkdirSync(path.join(temporary, 'node_modules'), { recursive: true });
  for (const file of fs.readdirSync(path.join(root, 'server')).filter((file) => file.endsWith('.js'))) fs.copyFileSync(path.join(root, 'server', file), path.join(server, file));
  fs.cpSync(path.join(root, 'server/scripts'), path.join(server, 'scripts'), { recursive: true, filter: (file) => !file.includes('__pycache__') });
  fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(temporary, 'node_modules/sql.js'), { recursive: true });
  const source = fs.readFileSync(path.join(server, 'index.js'), 'utf8');
  const routes = [...source.matchAll(/^app\.(get|post|put|patch|delete)\('([^']+)'/gm)].filter((match) => match[2].startsWith('/api/')).map((match) => ({ method: match[1].toUpperCase(), path: match[2] }));
  const seed = { sessions: [{ id: 'S1', room: 'R1', date: '2026-11-18', startTime: '09:00', endTime: '10:00', taNeeded: 1, doctorNeeded: 1 }], invigilators: ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ id: 'I' + id, staffId: id, name: 'Staff ' + id, role: 'DEF'.includes(id) ? 'Doctor' : 'TA', maxHours: 0 })), assignments: [], engagements: [], onCallAssignments: [], controlSessions: [], controlAssignments: [], superAssignments: [], staffHourPolicies: [], onCallConfig: { mode: 'fixed_per_period', fixedTAsPerPeriod: 1, fixedDoctorsPerPeriod: 1 } };
  for (const file of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(server, 'data', file), JSON.stringify(seed));
  const child = spawn(process.execPath, [path.join(server, 'index.js')], { cwd: temporary, env: { ...process.env, PORT: '3199', NODE_PATH: path.join(root, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const calls = [], failures = [];
  const request = async (method, route, body, expected) => {
    const response = await fetch('http://127.0.0.1:3199' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 150) }; }
    calls.push({ method, path: route, status: response.status });
    if (response.status >= 500 || data.raw !== undefined || (expected !== undefined && response.status !== expected)) failures.push({ method, path: route, expected, status: response.status, response: data });
    return data;
  };
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) { try { if ((await fetch('http://127.0.0.1:3199/api/sessions')).ok) { ready = true; break; } } catch {} await delay(100); }
    assert.ok(ready, stderr);
    // Success flows: create/update/delete, assignment, locks, preview/apply, and exports.
    const person = await request('POST', '/api/invigilators', { staffId: 'NEW', name: 'New staff', role: 'TA', maxHours: 8 }, 201);
    await request('PUT', '/api/invigilators/' + person.id, { staffId: 'NEW', name: 'Updated staff', role: 'TA', maxHours: 9 }, 200);
    const period = { date: '2026-11-18', startTime: '12:00', endTime: '13:00' };
    const session = await request('POST', '/api/sessions', { ...period, room: 'R2', taNeeded: 1, doctorNeeded: 0 }, 201);
    await request('PUT', '/api/sessions/' + session.id, { ...period, room: 'R2', taNeeded: 1, doctorNeeded: 0 }, 200);
    const engagement = await request('POST', '/api/engagements', { ...period, staffId: 'NEW', engagement: 1 }, 201);
    await request('PUT', '/api/engagements/' + engagement.id, { ...period, staffId: 'NEW', engagement: 0 }, 200);
    const control = await request('POST', '/api/control-sessions', { ...period, room: 'Control', taNeeded: 1, doctorNeeded: 0 }, 201);
    await request('PUT', '/api/control-sessions/' + control.id, { ...period, room: 'Control', taNeeded: 1, doctorNeeded: 0 }, 200);
    const assignment = await request('POST', '/api/scheduling/assign', { sessionId: 'S1', invigilatorId: 'IA' }, 201);
    await request('PATCH', '/api/scheduling/assign/' + assignment.id + '/lock', { locked: true }, 200);
    await request('PATCH', '/api/scheduling/assign/bulk-lock', { assignmentIds: [assignment.id], locked: false }, 200);
    await request('PATCH', '/api/scheduling/assign/lock-by-filter', { confirmAll: true, locked: true }, 200);
    await request('POST', '/api/control-sessions/assign', { controlSessionId: control.id, invigilatorId: 'IB' }, 201);
    const reserve = await request('POST', '/api/on-call/assign', { date: '2026-11-18', startTime: '09:00', endTime: '10:00', invigilatorId: 'IC' }, 201);
    const supervisor = await request('POST', '/api/super-invigilators/assign', { date: '2026-11-18', invigilatorId: 'IF' }, 201);
    const combined = await request('POST', '/api/scheduling/combined/preview', { mode: 'rebalance_all' }, 200);
    await request('POST', '/api/scheduling/combined/apply', { planToken: combined.planToken }, 200);
    await request('POST', '/api/scheduling/combined/apply', { planToken: combined.planToken }, 409);
    const preview = await request('POST', '/api/scheduling/auto-schedule-preview', { mode: 'preserve_all' }, 200);
    await request('POST', '/api/scheduling/auto-schedule-preview/export', { planToken: preview.planToken }, 200);
    await request('POST', '/api/scheduling/auto-schedule', { planToken: preview.planToken }, 200);
    // Backup restore must preserve reserve rules as well as assignments.
    await request('PATCH', '/api/on-call/config', { mode: 'fixed_per_period', fixedTAsPerPeriod: 2, fixedDoctorsPerPeriod: 2 }, 200);
    const backup = await request('GET', '/api/data/export', undefined, 200);
    await request('POST', '/api/data/import', { data: backup }, 200);
    const restored = await request('GET', '/api/data/export', undefined, 200);
    assert.deepEqual(restored.onCallConfig, backup.onCallConfig, 'Backup restore must retain on-call rules');
    // Invalid input must be rejected before it can poison scheduling data.
    const invalidCases = [
      ['/api/engagements', {}], ['/api/engagements', { ...period, staffId: 'missing', engagement: 1 }],
      ['/api/engagements', { ...period, staffId: 'A', engagement: 3 }], ['/api/engagements', { ...period, staffId: 'A', endTime: '11:00' }],
      ['/api/sessions', { ...period, endTime: '11:00', taNeeded: 1 }], ['/api/sessions', { ...period, taNeeded: -1 }],
      ['/api/sessions', { ...period, doctorNeeded: 1.5 }], ['/api/sessions', { ...period, date: '2026-02-30' }],
      ['/api/control-sessions', { ...period, taNeeded: -1 }], ['/api/control-sessions', { ...period, endTime: '11:00' }],
      ['/api/invigilators', { name: ' ', role: 'TA' }], ['/api/invigilators', { name: 'Duplicate', staffId: 'A', role: 'TA' }],
      ['/api/invigilators', { name: 'Bad cap', role: 'TA', maxHours: -1 }],
    ];
    const beforeInvalid = await request('GET', '/api/data/export', undefined, 200);
    await request('POST', '/api/super-invigilators/assign', { date: '2026-12-31', invigilatorId: 'IF' }, 400);
    for (const [route, body] of invalidCases) await request('POST', route, body, 400);
    for (const [route, body] of [
      ['/api/sessions/' + session.id, { ...period, taNeeded: -1 }],
      ['/api/control-sessions/' + control.id, { ...period, endTime: '11:00' }],
      ['/api/invigilators/' + person.id, { name: 'Updated staff', staffId: 'A', role: 'TA' }],
      ['/api/invigilators/' + person.id, { staffId: 'NEW', role: 'TA' }],
      ['/api/engagements/' + engagement.id, { ...period, staffId: 'missing' }],
    ]) await request('PUT', route, body, 400);
    const afterInvalid = await request('GET', '/api/data/export', undefined, 200);
    assert.deepEqual(afterInvalid, beforeInvalid, 'Rejected inputs must not change stored data');
    await request('POST', '/api/data/import', { data: seed }, 200);
    await request('DELETE', '/api/engagements/' + engagement.id, undefined, 200);
    await request('DELETE', '/api/invigilators/' + person.id, undefined, 200);
    // Read each GET route before generic mutation probes clear the fixture.
    for (const route of routes.filter((row) => row.method === 'GET')) {
      const actual = route.path.replace(':sessionId', 'S1').replace(':staffId', 'A').replace(':id', 'missing');
      const query = route.path === '/api/on-call/eligible' ? '?date=2026-11-18&startTime=09%3A00&endTime=10%3A00' : '';
      await request('GET', actual + query);
    }
    // Calls without bodies exercise validation/error contracts; destructive routes affect only this fixture.
    for (const route of routes.filter((row) => row.method !== 'GET')) {
      const actual = route.path.replace(/:[^/]+/g, 'missing');
      if (calls.some((call) => call.method === route.method && call.path.split('?')[0] === actual)) continue;
      await request(route.method, actual, route.method === 'DELETE' ? undefined : {});
    }
    const report = { routeCount: routes.length, requestCount: calls.length, routes, calls, failures, note: 'Every route received a contract probe. A probe may exercise an expected error path; it is not proof of every success branch.' };
    fs.writeFileSync(path.join(output, 'endpoint-contract-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ routes: routes.length, requests: calls.length, failures: failures.length }));
    if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
  } finally {
    child.kill(); if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    const resolved = fs.realpathSync(temporary); assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)); fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
