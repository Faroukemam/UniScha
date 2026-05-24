const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const initSqlJs = require('sql.js');

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
  throw new Error('Timed out waiting for committee assignment verification server.');
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

function summarizeFile(filePath) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, filePath.endsWith('.json') ? 'utf8' : null);
  return { size: stat.size, content: raw };
}

function resolveWorkbookPath(tempRepoRoot, url) {
  const normalized = String(url || '').replace(/^\/+/, '');
  const relative = normalized.startsWith('api/temp/')
    ? normalized.replace(/^api\//, '')
    : normalized;
  return path.join(tempRepoRoot, 'server', relative.replace(/\//g, path.sep));
}

function validateWorkbook(tempRepoRoot, url, expectedSheets) {
  const workbookPath = resolveWorkbookPath(tempRepoRoot, url);
  assert(fs.existsSync(workbookPath), `Workbook missing: ${url}`);
  assert(fs.statSync(workbookPath).size > 0, `Workbook empty: ${url}`);
  const signature = fs.readFileSync(workbookPath).subarray(0, 2).toString('utf8');
  assert(signature === 'PK', `Workbook signature invalid: ${url}`);
  const workbook = XLSX.readFile(workbookPath);
  expectedSheets.forEach((sheet) => {
    assert(workbook.Sheets[sheet], `Missing sheet ${sheet}`);
  });
  return { workbook, signature };
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
      { id: 'ses_db_1', courseNames: ['ME101'], courseName: 'ME101', room: '315 TH PH', date: '2026-06-01', startTime: '09:30', endTime: '11:30', taNeeded: 1, doctorNeeded: 1, totalNeeded: 2, notes: '' },
      { id: 'ses_db_2', courseNames: ['ME102'], courseName: 'ME102', room: '316 TH PH', date: '2026-06-01', startTime: '12:00', endTime: '14:00', taNeeded: 2, doctorNeeded: 1, totalNeeded: 3, notes: '' },
    ],
    invigilators: [
      { id: 'inv_ta_1', staffId: 'TA001', name: 'TA One', email: '', role: 'TA', loadType: 'full', department: 'ME', maxHours: 8, notes: '' },
      { id: 'inv_ta_2', staffId: 'TA002', name: 'TA Two', email: '', role: 'TA', loadType: 'full', department: 'ME', maxHours: 8, notes: '' },
      { id: 'inv_ta_3', staffId: 'TA003', name: 'Same Name', email: '', role: 'TA', loadType: 'full', department: 'ME', maxHours: 8, notes: '' },
      { id: 'inv_ta_4', staffId: 'TA004', name: 'Same Name', email: '', role: 'TA', loadType: 'full', department: 'ME', maxHours: 8, notes: '' },
      { id: 'inv_ta_5', staffId: 'TA005', name: 'Excluded TA', email: '', role: 'TA', loadType: 'full', department: 'ME', maxHours: 8, notes: '' },
      { id: 'inv_ta_6', staffId: 'TA006', name: 'Busy TA', email: '', role: 'TA', loadType: 'full', department: 'ME', maxHours: 8, notes: '' },
      { id: 'inv_doc_1', staffId: 'DR001', name: 'Doctor One', email: '', role: 'Doctor', loadType: 'full', department: 'ME', maxHours: 8, notes: '' },
      { id: 'inv_doc_2', staffId: 'DR002', name: 'Doctor Two', email: '', role: 'Doctor', loadType: 'full', department: 'ME', maxHours: 8, notes: '' },
    ],
    engagements: [
      { id: 'eng_1', staffId: 'TA006', date: '2026-06-01', startTime: '12:00', endTime: '14:00', engagement: 1, notes: '' },
    ],
    assignments: [
      { id: 'asg_seed_1', sessionId: 'ses_db_1', invigilatorId: 'inv_ta_1', role: 'TA', assignmentSource: 'manual', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_2', sessionId: 'ses_db_1', invigilatorId: 'inv_doc_1', role: 'Doctor', assignmentSource: 'manual', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
    ],
    onCallAssignments: [],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: [],
    staffHourPolicies: [
      { id: 'pol_ta_3', invigilatorId: 'inv_ta_3', staffId: 'TA003', role: 'TA', mode: 'exact', hoursValue: 8, excludeFromAutoSchedule: false, notes: '' },
      { id: 'pol_exclude', invigilatorId: 'inv_ta_5', staffId: 'TA005', role: 'TA', mode: 'exclude', hoursValue: 0, excludeFromAutoSchedule: true, notes: '' },
    ],
  };
}

async function run() {
  const liveRepoRoot = path.resolve(__dirname, '..', '..');
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-committee-import-verify-'));
  fs.cpSync(path.join(liveRepoRoot, 'server'), path.join(tempRepoRoot, 'server'), { recursive: true });
  fs.mkdirSync(path.join(tempRepoRoot, 'node_modules'), { recursive: true });
  fs.cpSync(path.join(liveRepoRoot, 'node_modules', 'sql.js'), path.join(tempRepoRoot, 'node_modules', 'sql.js'), { recursive: true });

  const seedStore = buildSeedStore();
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.json'), JSON.stringify(seedStore, null, 2));
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.last-good.json'), JSON.stringify(seedStore, null, 2));
  fs.rmSync(path.join(tempRepoRoot, 'server', 'data', 'scheduler.sqlite'), { force: true });

  const serverEntry = path.join(tempRepoRoot, 'server', 'index.js');
  const storeJsonPath = path.join(tempRepoRoot, 'server', 'data', 'store.json');
  const sqlitePath = path.join(tempRepoRoot, 'server', 'data', 'scheduler.sqlite');
  const port = 3198;
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

    const templateExport = await getJson(`${baseUrl}/api/scheduling/export/committee-assignment-template`);
    const templateValidation = validateWorkbook(tempRepoRoot, templateExport.url, ['Instructions', 'CommitteeAssignments', 'SessionsReference', 'StaffReference']);
    const templateHeaders = Object.keys((XLSX.utils.sheet_to_json(templateValidation.workbook.Sheets.CommitteeAssignments)[0]) || {});
    [
      'Date', 'Start', 'End', 'Room', 'CourseCode', 'Role', 'StaffID', 'StaffName', 'Locked', 'Notes',
      'TA1StaffID', 'TA1Name', 'TA2StaffID', 'TA2Name', 'TA3StaffID', 'TA3Name',
      'Doctor1StaffID', 'Doctor1Name', 'Doctor2StaffID', 'Doctor2Name', 'ForceReplaceLocked', 'AllowOverstaffing',
    ].forEach((column) => assert(templateHeaders.includes(column), `Missing committee template column ${column}`));

    const storeBeforeDryRun = summarizeFile(storeJsonPath);
    const sqliteBeforeDryRun = summarizeFile(sqlitePath);

    const oneRowDryRun = await getJson(`${baseUrl}/api/scheduling/import/committee-assignments?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'append',
        rows: [
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: '316 TH PH', CourseCode: 'ME102', Role: 'TA', StaffID: 'TA003', Locked: 'Yes', Notes: 'single row add' },
        ],
      }),
    });
    assert(oneRowDryRun.dryRun === true, 'Committee dry-run must return dryRun=true.');
    assert(Number(oneRowDryRun.assignmentsToAdd || 0) === 1, 'One-row dry-run should plan one add.');

    const multiRowDryRun = await getJson(`${baseUrl}/api/scheduling/import/committee-assignments?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'append',
        rows: [
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: '316 TH PH', CourseCode: 'ME102', TA1StaffID: 'TA003', TA1Name: 'Same Name', Doctor1StaffID: 'DR002', Doctor1Name: 'Doctor Two', Locked: 'Yes' },
        ],
      }),
    });
    assert(Number(multiRowDryRun.expandedAssignments || 0) === 2, 'Committee row should expand to two assignments.');
    assert(Number(multiRowDryRun.assignmentsToAdd || 0) === 2, 'Expanded committee row should plan two adds.');

    const invalidDryRun = await getJson(`${baseUrl}/api/scheduling/import/committee-assignments?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'append',
        rows: [
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: 'Unknown Room', CourseCode: 'ME102', Role: 'TA', StaffID: 'TA002' },
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: '316 TH PH', CourseCode: 'ME102', Role: 'TA', StaffID: 'TA999' },
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: '316 TH PH', CourseCode: 'ME102', Role: 'Doctor', StaffID: 'TA002' },
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: '316 TH PH', CourseCode: 'ME102', StaffName: 'Same Name' },
          { Date: '2026-06-01', Start: '09:30', End: '11:30', Room: '315 TH PH', CourseCode: 'ME101', Role: 'TA', StaffID: 'TA001' },
          { Date: '2026-06-01', Start: '09:30', End: '11:30', Room: '315 TH PH', CourseCode: 'ME101', Role: 'TA', StaffID: 'TA002' },
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: '316 TH PH', CourseCode: 'ME102', Role: 'TA', StaffID: 'TA006' },
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: '316 TH PH', CourseCode: 'ME102', Role: 'TA', StaffID: 'TA005' },
        ],
      }),
    });
    const reasons = new Set((invalidDryRun.errors || []).map((item) => item.reason));
    assert(reasons.has('unknown_session'), 'Committee import should reject unknown_session.');
    assert(reasons.has('unknown_staff'), 'Committee import should reject unknown_staff.');
    assert(reasons.has('role_mismatch'), 'Committee import should reject role_mismatch.');
    assert(reasons.has('ambiguous_staff_name'), 'Committee import should reject ambiguous_staff_name.');
    assert(Number(invalidDryRun.duplicatesSkipped || 0) >= 1, 'Committee import should skip duplicate assignments.');
    assert(reasons.has('session_full'), 'Committee import should reject session_full.');
    assert(reasons.has('engagement'), 'Committee import should reject engagement conflicts.');
    assert(reasons.has('staff_hour_policy_exceeded'), 'Committee import should reject excluded staff by policy.');

    const overstaffingDryRun = await getJson(`${baseUrl}/api/scheduling/import/committee-assignments?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'append',
        rows: [
          { Date: '2026-06-01', Start: '09:30', End: '11:30', Room: '315 TH PH', CourseCode: 'ME101', Role: 'TA', StaffID: 'TA003', AllowOverstaffing: 'YES' },
        ],
      }),
    });
    assert(Number(overstaffingDryRun.assignmentsToAdd || 0) === 1, 'AllowOverstaffing should allow extra assignment.');

    const replaceNoForce = await getJson(`${baseUrl}/api/scheduling/import/committee-assignments?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'replace_matching_sessions',
        rows: [
          { Date: '2026-06-01', Start: '09:30', End: '11:30', Room: '315 TH PH', CourseCode: 'ME101', Role: 'TA', StaffID: 'TA003' },
        ],
      }),
    });
    assert(Number(replaceNoForce.assignmentsToRemove || 0) === 0, 'Replace without force must not remove locked assignments.');

    const replaceForce = await getJson(`${baseUrl}/api/scheduling/import/committee-assignments?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'replace_matching_sessions',
        rows: [
          { Date: '2026-06-01', Start: '09:30', End: '11:30', Room: '315 TH PH', CourseCode: 'ME101', Role: 'TA', StaffID: 'TA003', ForceReplaceLocked: 'YES' },
        ],
      }),
    });
    assert(Number(replaceForce.assignmentsToRemove || 0) === 1, 'Replace with force should remove locked target assignment.');
    assert(Number(replaceForce.assignmentsToAdd || 0) === 1, 'Replace with force should add replacement assignment.');

    const storeAfterDryRun = summarizeFile(storeJsonPath);
    const sqliteAfterDryRun = summarizeFile(sqlitePath);
    assert(storeBeforeDryRun.content === storeAfterDryRun.content, 'store.json changed after committee dry-run.');
    assert(sqliteBeforeDryRun.size === sqliteAfterDryRun.size, 'sqlite changed after committee dry-run.');

    const applyResult = await getJson(`${baseUrl}/api/scheduling/import/committee-assignments`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'append',
        dryRun: false,
        confirmationText: 'IMPORT',
        rows: [
          { Date: '2026-06-01', Start: '12:00', End: '14:00', Room: '316 TH PH', CourseCode: 'ME102', Role: 'TA', StaffID: 'TA003', Notes: 'apply import' },
        ],
      }),
    });
    assert(Number(applyResult.added || 0) === 1, 'Committee apply should add one assignment.');

    const exportData = await getJson(`${baseUrl}/api/data/export`);
    const imported = (exportData.assignments || []).find((item) => String(item.sessionId) === 'ses_db_2' && String(item.staffId || item.invigilatorId) !== '');
    const sqliteImported = await readSqliteAssignment(tempRepoRoot, 'ses_db_2', 'TA003', 'TA');
    assert(sqliteImported && String(sqliteImported.assignment_source) === 'import', 'SQLite should persist assignment_source=import.');
    assert(sqliteImported && Number(sqliteImported.locked) === 1, 'Imported assignment should default locked=true.');

    console.log(JSON.stringify({
      result: 'PASS',
      template: {
        sheets: templateValidation.workbook.SheetNames,
        signature: templateValidation.signature,
        columns: templateHeaders,
      },
      dryRun: {
        oneRowAssignmentsToAdd: oneRowDryRun.assignmentsToAdd,
        multiRowExpandedAssignments: multiRowDryRun.expandedAssignments,
        multiRowAssignmentsToAdd: multiRowDryRun.assignmentsToAdd,
        invalidReasons: Array.from(reasons),
        overstaffingAssignmentsToAdd: overstaffingDryRun.assignmentsToAdd,
        replaceNoForceAssignmentsToRemove: replaceNoForce.assignmentsToRemove,
        replaceForceAssignmentsToRemove: replaceForce.assignmentsToRemove,
      },
      apply: {
        added: applyResult.added,
        sqliteAssignmentSource: sqliteImported.assignment_source,
        sqliteLocked: sqliteImported.locked,
      },
      noWriteChecks: {
        dryRunStoreJsonUnchanged: storeBeforeDryRun.content === storeAfterDryRun.content,
        dryRunSqliteUnchanged: sqliteBeforeDryRun.size === sqliteAfterDryRun.size,
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
