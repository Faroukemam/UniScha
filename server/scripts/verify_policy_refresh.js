// Run: node server/scripts/verify_policy_refresh.js
// All writes use an in-memory filesystem and database substitute.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const storeTools = require('../store');

function seed() {
  return {
    sessions: [{ id: 'S', date: '2026-11-01', room: 'R', startTime: '09:00', endTime: '11:00', taNeeded: 2, doctorNeeded: 0 }],
    invigilators: [{ id: 'A', staffId: 'A', role: 'TA', maxHours: 0, name: 'A' },
      { id: 'B', staffId: 'B', role: 'TA', maxHours: 0, name: 'B' }],
    assignments: [], engagements: [], superAssignments: [], controlSessions: [], controlAssignments: [], onCallAssignments: [],
    onCallConfig: { mode: 'fixed_per_period', fixedTAsPerPeriod: 0, fixedDoctorsPerPeriod: 0 },
    staffHourPolicies: [{ id: 'P', invigilatorId: 'A', staffId: 'A', role: 'TA', mode: 'reduce', hoursValue: 1 }],
  };
}

async function main() {
  const first = seed();
  let summary = storeTools.buildStaffHourPolicySummary(first);
  assert.equal(summary.effectivePolicyByInvigilatorId.get('A').allowedMinutes, 60);
  const changedNeeds = structuredClone(first);
  changedNeeds.sessions[0].taNeeded = 4;
  summary = storeTools.buildStaffHourPolicySummary(changedNeeds);
  assert.equal(summary.rawAverageMinutesByRole.TA, 240);
  assert.equal(summary.effectivePolicyByInvigilatorId.get('A').allowedMinutes, 180,
    'A changed snapshot must recalculate even before the global store version changes');
  changedNeeds.staffHourPolicies[0].hoursValue = 2;
  summary = storeTools.buildStaffHourPolicySummary(changedNeeds);
  assert.equal(summary.effectivePolicyByInvigilatorId.get('A').allowedMinutes, 120,
    'Editing the same snapshot must invalidate the policy calculation');
  changedNeeds.staffHourPolicies[0].mode = 'exact';
  changedNeeds.staffHourPolicies[0].hoursValue = 0;
  summary = storeTools.buildStaffHourPolicySummary(changedNeeds);
  const zeroPolicy = summary.effectivePolicyByInvigilatorId.get('A');
  assert.equal(zeroPolicy.hasHardLimit, true);
  assert.equal(zeroPolicy.hardLimitMinutes, 0);
  const eligibility = storeTools.getEligibilityForSession(changedNeeds, changedNeeds.sessions[0], changedNeeds.invigilators[0]);
  assert.equal(eligibility.reason, 'policy_limit');
  changedNeeds.staffHourPolicies.push({ id: 'P2', invigilatorId: 'B', staffId: 'B', role: 'TA', mode: 'exclude', hoursValue: 0 });
  assert.equal(storeTools.buildStaffHourPolicySummary(changedNeeds).rawAverageMinutesByRole.TA, 480);

  // Verify the write version inside the queue, including two writes queued
  // before either has completed. No actual disk writes are performed.
  let writes = 0;
  const fakeFs = { existsSync: () => true, mkdirSync() {}, writeFileSync() { writes += 1; } };
  const fakeDb = { initDb: async () => {}, write: async () => {}, all: async () => [], dbPath: 'memory' };
  const filename = path.resolve(__dirname, '../store.js');
  const context = { module: { exports: {} }, __dirname: path.dirname(filename), process, console,
    require: (name) => name === 'fs' ? fakeFs : name === './db' ? fakeDb : require(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  const isolated = context.module.exports;
  const saved = seed();
  saved.staffHourPolicies[0].hoursValue = 2;
  const outcomes = await Promise.allSettled([
    isolated.writeStore(saved, { expectedVersion: 0 }),
    isolated.writeStore(first, { expectedVersion: 0 }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.status, 409);
  assert.equal(isolated.readStore().staffHourPolicies[0].hoursValue, 2);
  assert.equal(writes, 2, 'Only the accepted snapshot should update the JSON mirrors');

  // Exercise the browser API cache without a browser or a real server.
  const originalFetch = global.fetch;
  const originalWindow = global.window;
  let sessionVersion = 1;
  let policyReads = 0;
  let pendingGet;
  let holdGet = false;
  const fakeWindow = new EventTarget();
  fakeWindow.localStorage = { setItem() {} };
  global.window = fakeWindow;
  global.fetch = async (url, options) => {
    assert.equal(options.cache, 'no-store');
    if (url === '/api/sessions' && holdGet) {
      holdGet = false;
      return new Promise((resolve) => { pendingGet = () => resolve(response([{ version: 1 }])); });
    }
    if (url === '/api/staff-hour-policies' && !options.method) return response({ version: ++policyReads });
    return response(url === '/api/sessions' ? [{ version: sessionVersion }] : { success: true });
  };
  function response(value) { return { ok: true, text: async () => JSON.stringify(value) }; }
  try {
    const source = fs.readFileSync(path.resolve(__dirname, '../../client/src/api.js'), 'utf8');
    const { api } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.equal((await api.getStaffHourPolicies()).version, 1);
    assert.equal((await api.getStaffHourPolicies()).version, 2, 'Refresh must fetch fresh policy data');
    holdGet = true;
    const staleRequest = api.getSessions();
    await api.saveStaffHourPolicy({ mode: 'exact', hoursValue: 2 });
    sessionVersion = 2;
    pendingGet();
    await staleRequest;
    assert.equal((await api.getSessions())[0].version, 2, 'An old response must not repopulate an invalidated cache');
    sessionVersion = 3;
    fakeWindow.dispatchEvent(new Event('focus'));
    assert.equal((await api.getSessions())[0].version, 3, 'Returning to the app must refresh cached data');
  } finally {
    global.fetch = originalFetch;
    global.window = originalWindow;
  }
  console.log('Policy refresh checks passed: need edits, policy edits, exclusions, zero limits, stale-write prevention, browser refresh, request races, and focus.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
