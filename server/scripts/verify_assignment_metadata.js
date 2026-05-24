const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
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
  throw new Error('Timed out waiting for metadata verification server.');
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

function resolveWorkbookPath(tempRepoRoot, url) {
  const normalized = String(url || '').replace(/^\/+/, '');
  const relative = normalized.startsWith('api/temp/')
    ? normalized.replace(/^api\//, '')
    : normalized;
  return path.join(tempRepoRoot, 'server', relative.replace(/\//g, path.sep));
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
      { id: 'asg_seed_3', sessionId: 'ses_db_2', invigilatorId: 'inv_ta_2', role: 'TA', assignmentSource: 'auto', locked: false, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_4', sessionId: 'ses_db_2', invigilatorId: 'inv_doc_2', role: 'Doctor', assignmentSource: 'import', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
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
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-metadata-verify-'));
  fs.cpSync(path.join(liveRepoRoot, 'server'), path.join(tempRepoRoot, 'server'), { recursive: true });
  fs.mkdirSync(path.join(tempRepoRoot, 'node_modules'), { recursive: true });
  fs.cpSync(path.join(liveRepoRoot, 'node_modules', 'sql.js'), path.join(tempRepoRoot, 'node_modules', 'sql.js'), { recursive: true });

  const seedStore = buildSeedStore();
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.json'), JSON.stringify(seedStore, null, 2));
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.last-good.json'), JSON.stringify(seedStore, null, 2));
  fs.rmSync(path.join(tempRepoRoot, 'server', 'data', 'scheduler.sqlite'), { force: true });

  const existingAssignment = normalizeAssignmentMetadata({ id: 'asg_legacy', sessionId: 'ses_1', invigilatorId: 'inv_1', role: 'TA' }, { sourceFallback: 'legacy', lockedFallback: true });
  const manualAssignment = normalizeAssignmentMetadata({ id: 'asg_manual', sessionId: 'ses_1', invigilatorId: 'inv_1', role: 'TA', assignmentSource: 'manual', locked: true }, { sourceFallback: 'manual', lockedFallback: true });
  const autoAssignment = normalizeAssignmentMetadata({ id: 'asg_auto', sessionId: 'ses_2', invigilatorId: 'inv_2', role: 'Doctor', assignmentSource: 'auto', locked: false }, { sourceFallback: 'auto', lockedFallback: false });
  const importAssignment = normalizeAssignmentMetadata({ id: 'asg_import', sessionId: 'ses_3', invigilatorId: 'inv_3', role: 'TA', assignmentSource: 'import' }, { sourceFallback: 'import', lockedFallback: true });

  const serverEntry = path.join(tempRepoRoot, 'server', 'index.js');
  const storeJsonPath = path.join(tempRepoRoot, 'server', 'data', 'store.json');
  const sqlitePath = path.join(tempRepoRoot, 'server', 'data', 'scheduler.sqlite');
  const port = 3188;
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

    const storeJsonBefore = fs.readFileSync(storeJsonPath, 'utf8');
    const sqliteBefore = fs.statSync(sqlitePath).size;
    const statusBefore = await getJson(`${baseUrl}/api/system/storage-status`);
    const preserveManualOnly = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_manual_only' }),
    });
    const exportWorkbook = await getJson(`${baseUrl}/api/export/workbook`);
    const workbookPath = resolveWorkbookPath(tempRepoRoot, exportWorkbook.url);
    assert(fs.readFileSync(workbookPath).subarray(0, 2).toString('utf8') === 'PK', 'Global export workbook must be a valid XLSX zip.');
    const workbook = XLSX.readFile(workbookPath);
    const assignmentRows = XLSX.utils.sheet_to_json(workbook.Sheets.Assignments || {});
    const firstAssignmentRow = assignmentRows[0] || {};
    const statusAfter = await getJson(`${baseUrl}/api/system/storage-status`);
    const storeJsonAfter = fs.readFileSync(storeJsonPath, 'utf8');
    const sqliteAfter = fs.statSync(sqlitePath).size;

    const liveAssignmentsBefore = Number(statusBefore.selected?.counts?.assignments ?? statusBefore.sqlite?.counts?.assignments ?? 0);
    const liveAssignmentsAfter = Number(statusAfter.selected?.counts?.assignments ?? statusAfter.sqlite?.counts?.assignments ?? 0);

    assert(Object.prototype.hasOwnProperty.call(firstAssignmentRow, 'AssignmentSource'), 'Assignments export must include AssignmentSource.');
    assert(Object.prototype.hasOwnProperty.call(firstAssignmentRow, 'Locked'), 'Assignments export must include Locked.');

    console.log(JSON.stringify({
      result: 'PASS',
      normalization: {
        existing: { assignmentSource: existingAssignment.assignmentSource, locked: existingAssignment.locked },
        manual: { assignmentSource: manualAssignment.assignmentSource, locked: manualAssignment.locked },
        auto: { assignmentSource: autoAssignment.assignmentSource, locked: autoAssignment.locked },
        import: { assignmentSource: importAssignment.assignmentSource, locked: importAssignment.locked },
      },
      preserveManualOnly: {
        liveLockedAssignmentsUsed: preserveManualOnly.lockedAssignmentsUsed,
        preservedManualLockedAssignments: preserveManualOnly.preservedManualLockedAssignments,
        preservedLegacyLockedAssignments: preserveManualOnly.preservedLegacyLockedAssignments,
        preservedImportLockedAssignments: preserveManualOnly.preservedImportLockedAssignments,
        replaceableAutoUnlockedAssignments: preserveManualOnly.replaceableAutoUnlockedAssignments,
      },
      export: {
        assignmentColumns: Object.keys(firstAssignmentRow),
        includesAssignmentSource: Object.prototype.hasOwnProperty.call(firstAssignmentRow, 'AssignmentSource'),
        includesLocked: Object.prototype.hasOwnProperty.call(firstAssignmentRow, 'Locked'),
      },
      noWriteChecks: {
        assignmentsBefore: liveAssignmentsBefore,
        assignmentsAfter: liveAssignmentsAfter,
        storeJsonUnchanged: storeJsonBefore === storeJsonAfter,
        sqliteUnchanged: sqliteBefore === sqliteAfter,
      },
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
