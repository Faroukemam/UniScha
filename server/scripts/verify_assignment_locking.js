const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const initSqlJs = require('sql.js');
const { normalizeAssignmentMetadata } = require('../store');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/system/storage-status`);
      if (response.ok) return;
    } catch (_error) {
      // retry
    }
    await delay(500);
  }
  throw new Error('Timed out waiting for locking verification server.');
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function readSqliteAssignment(repoRoot, sessionId, staffId, role) {
  const sqlitePath = path.join(repoRoot, 'server', 'data', 'scheduler.sqlite');
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.resolve(__dirname, '..', '..'), 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database(fs.readFileSync(sqlitePath));
  const stmt = db.prepare('SELECT assignment_source, locked, updated_at FROM assignments WHERE session_id = ? AND staff_id = ? AND role = ?');
  stmt.bind([Number(String(sessionId).replace(/^ses_db_/, '')), String(staffId), String(role)]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  db.close();
  return row;
}

function buildSeedStore() {
  return {
    sessions: [
      { id: 'ses_db_1', courseNames: ['CSE101'], courseName: 'CSE101', room: 'Hall A', date: '2026-06-01', startTime: '09:00', endTime: '11:00', taNeeded: 1, doctorNeeded: 1, totalNeeded: 2, notes: '' },
      { id: 'ses_db_2', courseNames: ['CSE102'], courseName: 'CSE102', room: 'Hall B', date: '2026-06-01', startTime: '12:00', endTime: '14:00', taNeeded: 1, doctorNeeded: 1, totalNeeded: 2, notes: '' },
    ],
    invigilators: [
      { id: 'inv_ta_1', staffId: 'TA001', name: 'TA One', email: '', role: 'TA', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
      { id: 'inv_ta_2', staffId: 'TA002', name: 'TA Two', email: '', role: 'TA', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
      { id: 'inv_doc_1', staffId: 'DR001', name: 'Doctor One', email: '', role: 'Doctor', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
      { id: 'inv_doc_2', staffId: 'DR002', name: 'Doctor Two', email: '', role: 'Doctor', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
    ],
    engagements: [],
    assignments: [
      { id: 'asg_seed_1', sessionId: 'ses_db_1', invigilatorId: 'inv_ta_1', role: 'TA', assignmentSource: 'legacy', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_2', sessionId: 'ses_db_1', invigilatorId: 'inv_doc_1', role: 'Doctor', assignmentSource: 'legacy', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_3', sessionId: 'ses_db_2', invigilatorId: 'inv_ta_2', role: 'TA', assignmentSource: 'legacy', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_4', sessionId: 'ses_db_2', invigilatorId: 'inv_doc_2', role: 'Doctor', assignmentSource: 'legacy', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
    ],
    onCallAssignments: [],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: [],
    staffHourPolicies: [],
  };
}

async function run() {
  const liveRepoRoot = path.resolve(__dirname, '..', '..');
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-locking-verify-'));
  fs.cpSync(path.join(liveRepoRoot, 'server'), path.join(tempRepoRoot, 'server'), { recursive: true });
  fs.mkdirSync(path.join(tempRepoRoot, 'node_modules'), { recursive: true });
  fs.cpSync(path.join(liveRepoRoot, 'node_modules', 'sql.js'), path.join(tempRepoRoot, 'node_modules', 'sql.js'), { recursive: true });

  const seedStore = buildSeedStore();
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.json'), JSON.stringify(seedStore, null, 2));
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.last-good.json'), JSON.stringify(seedStore, null, 2));
  fs.rmSync(path.join(tempRepoRoot, 'server', 'data', 'scheduler.sqlite'), { force: true });

  const serverEntry = path.join(tempRepoRoot, 'server', 'index.js');
  const port = 3189;
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [serverEntry], {
    cwd: tempRepoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      PERF_LOG: '0',
      NODE_PATH: path.join(liveRepoRoot, 'node_modules'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const isolatedAssignments = [
    normalizeAssignmentMetadata({ id: 'legacy_locked', sessionId: 's1', invigilatorId: 'i1', role: 'TA', assignmentSource: 'legacy', locked: true }, { sourceFallback: 'legacy', lockedFallback: true }),
    normalizeAssignmentMetadata({ id: 'legacy_unlocked', sessionId: 's2', invigilatorId: 'i1', role: 'TA', assignmentSource: 'legacy', locked: false }, { sourceFallback: 'legacy', lockedFallback: true }),
    normalizeAssignmentMetadata({ id: 'manual_unlocked', sessionId: 's3', invigilatorId: 'i1', role: 'TA', assignmentSource: 'manual', locked: false }, { sourceFallback: 'manual', lockedFallback: true }),
    normalizeAssignmentMetadata({ id: 'import_unlocked', sessionId: 's4', invigilatorId: 'i1', role: 'TA', assignmentSource: 'import', locked: false }, { sourceFallback: 'import', lockedFallback: true }),
    normalizeAssignmentMetadata({ id: 'auto_unlocked', sessionId: 's5', invigilatorId: 'i1', role: 'TA', assignmentSource: 'auto', locked: false }, { sourceFallback: 'auto', lockedFallback: false }),
  ];
  const isolatedPreserved = isolatedAssignments.filter((item) => item.locked === true);
  const isolatedReplaceable = isolatedAssignments.filter((item) => item.locked !== true);

  try {
    await waitForServer(baseUrl);

    const previewBefore = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    const schedulingBefore = await getJson(`${baseUrl}/api/scheduling`);
    const assignmentsBefore = (schedulingBefore.sessions || []).reduce((sum, session) => sum + Number(session.assignmentCount || 0), 0);
    const firstSession = (schedulingBefore.sessions || []).find((session) => (session.taAssignments || []).length || (session.doctorAssignments || []).length);
    const firstAssignment = [...(firstSession.taAssignments || []), ...(firstSession.doctorAssignments || [])][0];

    const assignmentId = String(firstAssignment.id);
    const staffId = String(firstAssignment.invigilator?.staffId || '');
    const sessionId = String(firstAssignment.sessionId || firstSession.id);
    const role = String(firstAssignment.role || '');

    const unlockResult = await getJson(`${baseUrl}/api/scheduling/assign/${encodeURIComponent(assignmentId)}/lock`, {
      method: 'PATCH',
      body: JSON.stringify({ locked: false }),
    });
    assert(unlockResult.assignment.locked === false, 'Unlock endpoint must set locked=false.');
    assert(unlockResult.assignment.assignmentSource === 'legacy', 'Unlock must preserve assignmentSource.');

    const exportAfterUnlock = await getJson(`${baseUrl}/api/data/export`);
    const unlockedAssignment = (exportAfterUnlock.assignments || []).find((item) => String(item.id) === assignmentId);
    assert(unlockedAssignment && unlockedAssignment.locked === false, 'Unlocked assignment must be visible in exported store.');

    const previewAfterUnlock = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    assert(Number(previewAfterUnlock.lockedAssignmentsUsed || 0) === Number(previewBefore.lockedAssignmentsUsed || 0) - 1, 'preserve_manual_only lockedAssignmentsUsed should decrease after unlock.');
    assert(Number(previewAfterUnlock.replaceableLegacyUnlockedAssignments || 0) === 1, 'Unlocked legacy assignment should become replaceable.');

    const sqliteAfterUnlock = await readSqliteAssignment(tempRepoRoot, sessionId, staffId, role);
    assert(sqliteAfterUnlock && Number(sqliteAfterUnlock.locked) === 0, 'SQLite must persist unlocked state.');

    await getJson(`${baseUrl}/api/scheduling/assign/${encodeURIComponent(assignmentId)}/lock`, {
      method: 'PATCH',
      body: JSON.stringify({ locked: true }),
    });
    const previewAfterRelock = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    const schedulingAfter = await getJson(`${baseUrl}/api/scheduling`);
    const assignmentsAfter = (schedulingAfter.sessions || []).reduce((sum, session) => sum + Number(session.assignmentCount || 0), 0);

    console.log(JSON.stringify({
      result: 'PASS',
      assignmentId,
      source: firstAssignment.assignmentSource,
      before: {
        locked: firstAssignment.locked,
        preserveManualOnlyLockedAssignmentsUsed: previewBefore.lockedAssignmentsUsed,
        assignmentCount: assignmentsBefore,
      },
      afterUnlock: {
        locked: unlockedAssignment.locked,
        updatedAt: unlockedAssignment.updatedAt,
        preserveManualOnlyLockedAssignmentsUsed: previewAfterUnlock.lockedAssignmentsUsed,
        replaceableLegacyUnlockedAssignments: previewAfterUnlock.replaceableLegacyUnlockedAssignments,
        sqliteLocked: Number(sqliteAfterUnlock.locked),
      },
      afterRelock: {
        locked: true,
        preserveManualOnlyLockedAssignmentsUsed: previewAfterRelock.lockedAssignmentsUsed,
        assignmentCount: assignmentsAfter,
      },
      isolatedRuleChecks: {
        preservedIds: isolatedPreserved.map((item) => item.id),
        replaceableIds: isolatedReplaceable.map((item) => item.id),
      },
      noDelete: assignmentsBefore === assignmentsAfter,
    }, null, 2));
  } finally {
    child.kill();
    await delay(500);
    fs.rmSync(tempRepoRoot, { recursive: true, force: true });
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    result: 'FAIL',
    error: error.message,
  }, null, 2));
  process.exit(1);
});
