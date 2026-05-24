const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const initSqlJs = require('sql.js');
const XLSX = require('xlsx');

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
  throw new Error('Timed out waiting for lock-management verification server.');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function getJson(url, options = {}) {
  const { response, payload } = await requestJson(url, options);
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function resolveWorkbookPath(tempRepoRoot, url) {
  const normalized = String(url || '').replace(/^\/+/, '');
  const relative = normalized.startsWith('api/temp/')
    ? normalized.replace(/^api\//, '')
    : normalized;
  return path.join(tempRepoRoot, 'server', relative.replace(/\//g, path.sep));
}

async function readSqliteAssignment(repoRoot, sessionId, staffId, role) {
  const sqlitePath = path.join(repoRoot, 'server', 'data', 'scheduler.sqlite');
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.resolve(__dirname, '..', '..'), 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database(fs.readFileSync(sqlitePath));
  const stmt = db.prepare('SELECT assignment_source, locked FROM assignments WHERE session_id = ? AND staff_id = ? AND role = ?');
  stmt.bind([Number(String(sessionId).replace(/^ses_db_/, '')), String(staffId), String(role)]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  db.close();
  return row;
}

function buildSeedStore() {
  return {
    sessions: [
      { id: 'ses_db_1', courseNames: ['CSE101'], courseName: 'CSE101', room: 'Hall A', date: '2026-06-16', startTime: '09:00', endTime: '11:00', taNeeded: 2, doctorNeeded: 1, totalNeeded: 3, notes: '' },
      { id: 'ses_db_2', courseNames: ['CSE102'], courseName: 'CSE102', room: 'Hall B', date: '2026-06-16', startTime: '09:00', endTime: '11:00', taNeeded: 1, doctorNeeded: 1, totalNeeded: 2, notes: '' },
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
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-lock-mgmt-verify-'));
  fs.cpSync(path.join(liveRepoRoot, 'server'), path.join(tempRepoRoot, 'server'), { recursive: true });
  fs.mkdirSync(path.join(tempRepoRoot, 'node_modules'), { recursive: true });
  fs.cpSync(path.join(liveRepoRoot, 'node_modules', 'sql.js'), path.join(tempRepoRoot, 'node_modules', 'sql.js'), { recursive: true });

  const seedStore = buildSeedStore();
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.json'), JSON.stringify(seedStore, null, 2));
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.last-good.json'), JSON.stringify(seedStore, null, 2));
  fs.rmSync(path.join(tempRepoRoot, 'server', 'data', 'scheduler.sqlite'), { force: true });

  const serverEntry = path.join(tempRepoRoot, 'server', 'index.js');
  const storeJsonPath = path.join(tempRepoRoot, 'server', 'data', 'store.json');
  const port = 3192;
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

  try {
    await waitForServer(baseUrl);

    const schedulingBefore = await getJson(`${baseUrl}/api/scheduling`);
    const previewBefore = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    const assignmentsBefore = (schedulingBefore.sessions || []).reduce((sum, session) => sum + Number(session.assignmentCount || 0), 0);

    const emptyFilterAttempt = await requestJson(`${baseUrl}/api/scheduling/assign/lock-by-filter`, {
      method: 'PATCH',
      body: JSON.stringify({ locked: false, filters: {} }),
    });
    assert(emptyFilterAttempt.response.status === 400, 'Empty filters must be rejected without confirmAll.');

    const unlockByRoleDate = await getJson(`${baseUrl}/api/scheduling/assign/lock-by-filter`, {
      method: 'PATCH',
      body: JSON.stringify({
        locked: false,
        filters: { role: 'Doctor', date: '2026-06-16', onlyLocked: true },
      }),
    });
    assert(Number(unlockByRoleDate.matchedCount || 0) === 2, 'Role/date filter should match two doctor assignments.');
    assert(Number(unlockByRoleDate.updatedCount || 0) === 2, 'Role/date unlock should update two doctor assignments.');

    const previewAfterUnlock = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    assert(Number(previewAfterUnlock.lockedAssignmentsUsed || 0) === Number(previewBefore.lockedAssignmentsUsed || 0) - 2, 'Unlock by filter should reduce lockedAssignmentsUsed by two.');

    const relockBySource = await getJson(`${baseUrl}/api/scheduling/assign/lock-by-filter`, {
      method: 'PATCH',
      body: JSON.stringify({
        locked: true,
        filters: { assignmentSource: 'legacy', role: 'Doctor', date: '2026-06-16', onlyUnlocked: true },
      }),
    });
    assert(Number(relockBySource.updatedCount || 0) === 2, 'Relock by source should restore the same two assignments.');

    const exportLockPlan = await getJson(`${baseUrl}/api/scheduling/assign/lock-plan/export`);
    const workbookPath = resolveWorkbookPath(tempRepoRoot, exportLockPlan.url);
    assert(fs.readFileSync(workbookPath).subarray(0, 2).toString('utf8') === 'PK', 'Lock plan export must be a valid XLSX zip.');
    const workbook = XLSX.readFile(workbookPath);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets.AssignmentLockPlan);
    const firstRow = rows[0] || {};
    ['AssignmentID', 'SessionID', 'CourseCode', 'Room', 'Date', 'Start', 'End', 'StaffID', 'StaffName', 'Role', 'AssignmentSource', 'Locked', 'NewLocked', 'Notes'].forEach((column) => {
      assert(Object.prototype.hasOwnProperty.call(firstRow, column), `Missing lock-plan column ${column}.`);
    });

    const importTarget = rows.find((row) => String(row.AssignmentID || '') === 'asg_seed_1');
    const importResult = await getJson(`${baseUrl}/api/scheduling/assign/lock-plan/import`, {
      method: 'POST',
      body: JSON.stringify({
        rows: [
          { AssignmentID: importTarget.AssignmentID, NewLocked: 'No', Notes: 'Verify unlock' },
          { AssignmentID: 'missing_assignment', NewLocked: 'Yes', Notes: 'Should reject' },
        ],
      }),
    });
    assert(Number(importResult.updated || 0) === 1, 'Lock-plan import should update one assignment.');
    assert(Number(importResult.rejected || 0) === 1, 'Lock-plan import should reject one unknown assignment.');

    const previewAfterImport = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    assert(Number(previewAfterImport.lockedAssignmentsUsed || 0) === Number(previewBefore.lockedAssignmentsUsed || 0) - 1, 'Lock-plan import unlock should reduce lockedAssignmentsUsed by one.');

    const storeJsonAfterImport = JSON.parse(fs.readFileSync(storeJsonPath, 'utf8'));
    const jsonAssignment = (storeJsonAfterImport.assignments || []).find((item) => String(item.id) === 'asg_seed_1');
    assert(jsonAssignment && jsonAssignment.locked === false, 'store.json must persist imported lock change.');

    const sqliteAfterImport = await readSqliteAssignment(tempRepoRoot, 'ses_db_1', 'TA001', 'TA');
    assert(sqliteAfterImport && Number(sqliteAfterImport.locked) === 0, 'SQLite must persist imported lock change.');

    await getJson(`${baseUrl}/api/scheduling/assign/lock-plan/import`, {
      method: 'POST',
      body: JSON.stringify({
        rows: [{ AssignmentID: 'asg_seed_1', NewLocked: 'Yes', Notes: 'Restore' }],
      }),
    });

    const previewAfterRestore = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    const schedulingAfter = await getJson(`${baseUrl}/api/scheduling`);
    const assignmentsAfter = (schedulingAfter.sessions || []).reduce((sum, session) => sum + Number(session.assignmentCount || 0), 0);

    console.log(JSON.stringify({
      result: 'PASS',
      targetGroup: {
        role: 'Doctor',
        date: '2026-06-16',
        assignmentSource: 'legacy',
        matchedCount: 2,
      },
      roleDateUnlock: unlockByRoleDate,
      sourceRelock: relockBySource,
      previewImpact: {
        beforeLockedAssignmentsUsed: previewBefore.lockedAssignmentsUsed,
        afterUnlockLockedAssignmentsUsed: previewAfterUnlock.lockedAssignmentsUsed,
        afterImportLockedAssignmentsUsed: previewAfterImport.lockedAssignmentsUsed,
        afterRestoreLockedAssignmentsUsed: previewAfterRestore.lockedAssignmentsUsed,
      },
      lockPlan: {
        columns: Object.keys(firstRow),
        rowsExported: rows.length,
        importUpdated: importResult.updated,
        importRejected: importResult.rejected,
      },
      persistence: {
        assignmentCountBefore: assignmentsBefore,
        assignmentCountAfter: assignmentsAfter,
        sqliteLockedAfterImport: Number(sqliteAfterImport.locked),
        storeJsonLockedAfterImport: jsonAssignment.locked,
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
