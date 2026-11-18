const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const initSqlJs = require('sql.js');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  throw new Error('Timed out waiting for scheduling import/export verification server.');
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

function summarizeFile(filePath) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, filePath.endsWith('.json') ? 'utf8' : null);
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    content: raw,
  };
}

function countAssignmentsFromStoreJson(raw) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return Array.isArray(parsed.assignments) ? parsed.assignments.length : 0;
  } catch (_error) {
    return 0;
  }
}

function countSchedulingAssignments(payload) {
  return (payload.sessions || []).reduce((sum, session) => sum + Number(session.assignmentCount || 0), 0);
}

function resolveWorkbookPath(tempRepoRoot, url) {
  const normalized = String(url || '').replace(/^\/+/, '');
  const relative = normalized.startsWith('api/temp/')
    ? normalized.replace(/^api\//, '')
    : normalized;
  return path.join(tempRepoRoot, 'server', relative.replace(/\//g, path.sep));
}

function validateWorkbookFile(tempRepoRoot, url, expectedSheets = []) {
  const workbookPath = resolveWorkbookPath(tempRepoRoot, url);
  assert(fs.existsSync(workbookPath), `Workbook file does not exist: ${url}`);
  const stat = fs.statSync(workbookPath);
  assert(stat.size > 0, `Workbook file is empty: ${url}`);
  const signature = fs.readFileSync(workbookPath).subarray(0, 2).toString('utf8');
  assert(signature === 'PK', `Workbook file does not have XLSX ZIP signature: ${url}`);
  const workbook = XLSX.readFile(workbookPath);
  expectedSheets.forEach((sheet) => {
    assert(workbook.Sheets[sheet], `Missing workbook sheet ${sheet}.`);
  });
  return { workbookPath, workbook, signature, size: stat.size };
}

function getSheetHeaders(workbook, sheetName) {
  const objectRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
  if (objectRows.length) {
    return Object.keys(objectRows[0]);
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
  return Array.isArray(rows[0]) ? rows[0].map((item) => String(item || '')) : [];
}

function flattenAssignments(payload) {
  return (payload.sessions || []).flatMap((session) => [
    ...(session.taAssignments || []).map((assignment) => ({
      ...assignment,
      sessionId: session.id,
      sessionDate: session.date,
      sessionRoom: session.room,
      courseCode: Array.isArray(session.courseNames) && session.courseNames.length
        ? session.courseNames.join('; ')
        : session.courseName || '',
    })),
    ...(session.doctorAssignments || []).map((assignment) => ({
      ...assignment,
      sessionId: session.id,
      sessionDate: session.date,
      sessionRoom: session.room,
      courseCode: Array.isArray(session.courseNames) && session.courseNames.length
        ? session.courseNames.join('; ')
        : session.courseName || '',
    })),
  ]);
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

async function run() {
  const liveRepoRoot = path.resolve(__dirname, '..', '..');
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-scheduling-verify-'));
  fs.cpSync(path.join(liveRepoRoot, 'server'), path.join(tempRepoRoot, 'server'), { recursive: true });
  fs.mkdirSync(path.join(tempRepoRoot, 'node_modules'), { recursive: true });
  fs.cpSync(path.join(liveRepoRoot, 'node_modules', 'sql.js'), path.join(tempRepoRoot, 'node_modules', 'sql.js'), { recursive: true });

  const seedStore = {
    sessions: [
      {
        id: 'ses_db_1',
        courseNames: ['CSE101'],
        courseName: 'CSE101',
        room: 'Hall A',
        date: '2026-06-01',
        startTime: '09:00',
        endTime: '11:00',
        taNeeded: 1,
        doctorNeeded: 1,
        totalNeeded: 2,
        notes: '',
      },
      {
        id: 'ses_db_2',
        courseNames: ['CSE102'],
        courseName: 'CSE102',
        room: 'Hall B',
        date: '2026-06-01',
        startTime: '12:00',
        endTime: '14:00',
        taNeeded: 1,
        doctorNeeded: 1,
        totalNeeded: 2,
        notes: '',
      },
    ],
    invigilators: [
      { id: 'inv_ta_1', staffId: 'TA001', name: 'TA One', email: '', role: 'TA', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
      { id: 'inv_ta_2', staffId: 'TA002', name: 'TA Two', email: '', role: 'TA', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
      { id: 'inv_ta_3', staffId: 'TA003', name: 'TA Three', email: '', role: 'TA', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
      { id: 'inv_doc_1', staffId: 'DR001', name: 'Doctor One', email: '', role: 'Doctor', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
      { id: 'inv_doc_2', staffId: 'DR002', name: 'Doctor Two', email: '', role: 'Doctor', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
      { id: 'inv_doc_3', staffId: 'DR003', name: 'Doctor Three', email: '', role: 'Doctor', loadType: 'full', department: 'CS', maxHours: 8, notes: '' },
    ],
    engagements: [],
    assignments: [
      { id: 'asg_seed_1', sessionId: 'ses_db_1', invigilatorId: 'inv_ta_1', role: 'TA', assignmentSource: 'manual', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_2', sessionId: 'ses_db_1', invigilatorId: 'inv_doc_1', role: 'Doctor', assignmentSource: 'manual', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_3', sessionId: 'ses_db_2', invigilatorId: 'inv_ta_2', role: 'TA', assignmentSource: 'manual', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_4', sessionId: 'ses_db_2', invigilatorId: 'inv_doc_2', role: 'Doctor', assignmentSource: 'manual', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
    ],
    onCallAssignments: [],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: [],
    staffHourPolicies: [
      { id: 'pol_ta_3', invigilatorId: 'inv_ta_3', staffId: 'TA003', role: 'TA', mode: 'exact', hoursValue: 4, excludeFromAutoSchedule: false, notes: 'Verifier override' },
      { id: 'pol_doc_3', invigilatorId: 'inv_doc_3', staffId: 'DR003', role: 'Doctor', mode: 'exact', hoursValue: 4, excludeFromAutoSchedule: false, notes: 'Verifier override' },
    ],
  };
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.json'), JSON.stringify(seedStore, null, 2));
  fs.writeFileSync(path.join(tempRepoRoot, 'server', 'data', 'store.last-good.json'), JSON.stringify(seedStore, null, 2));
  fs.rmSync(path.join(tempRepoRoot, 'server', 'data', 'scheduler.sqlite'), { force: true });

  const serverEntry = path.join(tempRepoRoot, 'server', 'index.js');
  const storeJsonPath = path.join(tempRepoRoot, 'server', 'data', 'store.json');
  const sqlitePath = path.join(tempRepoRoot, 'server', 'data', 'scheduler.sqlite');
  const port = 3197;
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

    const guardedImportRoutes = [
      '/api/import/sessions',
      '/api/import/session-needs',
      '/api/import/control-sessions',
      '/api/import/control-session-loads',
      '/api/import/invigilators',
      '/api/import/staff-hour-policies',
      '/api/import/engagements',
      '/api/course-room-assignment/import-schedule',
      '/api/course-room-assignment/import-room-sessions',
      '/api/course-room-assignment/import-room-capacity',
    ];
    for (const route of guardedImportRoutes) {
      const { response, payload } = await requestJson(`${baseUrl}${route}`, {
        method: 'POST',
        body: JSON.stringify({ rows: [] }),
      });
      assert(response.status === 400, `Expected ${route} to reject an empty import with HTTP 400.`);
      assert(String(payload.error || '').includes('contains no data rows'), `Expected ${route} to return a useful empty-import error.`);
    }

    const exportCurrent = await getJson(`${baseUrl}/api/scheduling/export/current`);
    const currentValidation = validateWorkbookFile(
      tempRepoRoot,
      exportCurrent.url,
      ['Instructions', 'CurrentSchedule', 'SessionsReference', 'StaffReference', 'Summary']
    );
    const currentWorkbook = currentValidation.workbook;
    ['Instructions', 'CurrentSchedule', 'SessionsReference', 'StaffReference', 'Summary'].forEach((sheet) => {
      assert(currentWorkbook.Sheets[sheet], `Missing scheduling export sheet ${sheet}.`);
    });
    [
      'AssignmentID', 'SessionID', 'CourseCode', 'CourseName', 'Room', 'Date', 'Start', 'End',
      'DurationHours', 'Role', 'StaffID', 'StaffName', 'AssignmentSource', 'Locked',
      'CurrentAssignedHours', 'RoleAverageHours', 'EffectiveAllowedHours', 'PolicyMode', 'Notes',
    ].forEach((column) => {
      assert(getSheetHeaders(currentWorkbook, 'CurrentSchedule').includes(column), `Missing CurrentSchedule column ${column}.`);
    });

    const exportTemplate = await getJson(`${baseUrl}/api/scheduling/export/assignment-template`);
    const templateValidation = validateWorkbookFile(
      tempRepoRoot,
      exportTemplate.url,
      ['Instructions', 'AssignmentActions', 'SessionsReference', 'StaffReference']
    );
    const templateWorkbook = templateValidation.workbook;
    ['Instructions', 'AssignmentActions', 'SessionsReference', 'StaffReference'].forEach((sheet) => {
      assert(templateWorkbook.Sheets[sheet], `Missing assignment template sheet ${sheet}.`);
    });
    ['Action', 'AssignmentID', 'SessionID', 'StaffID', 'Role', 'Locked', 'Notes'].forEach((column) => {
      assert(getSheetHeaders(templateWorkbook, 'AssignmentActions').includes(column), `Missing AssignmentActions column ${column}.`);
    });

    const globalExport = await getJson(`${baseUrl}/api/export/workbook`);
    const globalValidation = validateWorkbookFile(tempRepoRoot, globalExport.url, ['Sessions']);
    const globalWorkbook = globalValidation.workbook;
    assert(globalWorkbook.Sheets.Sessions, 'Global workbook export should still include Sessions.');

    const exportLockPlan = await getJson(`${baseUrl}/api/scheduling/assign/lock-plan/export`);
    validateWorkbookFile(tempRepoRoot, exportLockPlan.url, ['AssignmentLockPlan']);

    const sessionPreview = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_all', roleScope: 'both' }),
    });
    const previewExport = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview/export`, {
      method: 'POST', body: JSON.stringify({ planToken: sessionPreview.planToken }),
    });
    validateWorkbookFile(tempRepoRoot, previewExport.url, ['PreviewSummary', 'CurrentAssignments', 'PreviewAssignments', 'SolverDiagnostics']);

    const storeBeforeDryRun = summarizeFile(storeJsonPath);
    const sqliteBeforeDryRun = summarizeFile(sqlitePath);
    const schedulingBefore = await getJson(`${baseUrl}/api/scheduling`);
    const assignmentsBefore = countSchedulingAssignments(schedulingBefore);
    const allAssignments = flattenAssignments(schedulingBefore);
    const sampleAssignment = allAssignments[0];
    assert(sampleAssignment, 'Expected at least one assignment for scheduling import verification.');

    const dryRunLock = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        rows: [{ Action: 'UNLOCK', AssignmentID: sampleAssignment.id, Notes: 'Dry-run unlock' }],
      }),
    });
    assert(dryRunLock.dryRun === true, 'Dry-run import must return dryRun=true.');
    assert(Number(dryRunLock.unlocked || 0) === 1, 'Dry-run UNLOCK should validate one row.');

    const dryRunInvalids = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        rows: [
          { Action: 'ADD', SessionID: 'missing_session', StaffID: 'missing_staff', Role: 'TA' },
          { Action: 'ADD', SessionID: sampleAssignment.sessionId, StaffID: 'missing_staff', Role: sampleAssignment.role },
          { Action: 'ADD', SessionID: sampleAssignment.sessionId, StaffID: sampleAssignment.invigilator?.staffId || '', Role: sampleAssignment.role === 'TA' ? 'Doctor' : 'TA' },
          { Action: 'LOCK', AssignmentID: 'missing_assignment' },
        ],
      }),
    });
    const invalidReasons = new Set((dryRunInvalids.errors || []).map((item) => item.reason));
    assert(invalidReasons.has('unknown_session'), 'Dry-run should reject unknown_session.');
    assert(invalidReasons.has('unknown_staff'), 'Dry-run should reject unknown_staff.');
    assert(invalidReasons.has('role_mismatch'), 'Dry-run should reject role_mismatch.');
    assert(invalidReasons.has('unknown_assignment'), 'Dry-run should reject unknown_assignment.');

    const storeAfterDryRun = summarizeFile(storeJsonPath);
    const sqliteAfterDryRun = summarizeFile(sqlitePath);
    const schedulingAfterDryRun = await getJson(`${baseUrl}/api/scheduling`);
    assert(assignmentsBefore === countSchedulingAssignments(schedulingAfterDryRun), 'Assignment count changed after dry-run import.');
    assert(storeBeforeDryRun.content === storeAfterDryRun.content, 'store.json changed after dry-run import.');
    assert(sqliteBeforeDryRun.size === sqliteAfterDryRun.size, 'SQLite changed after dry-run import.');

    const unlockApply = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions`, {
      method: 'POST',
      body: JSON.stringify({
        confirmText: 'IMPORT',
        rows: [{ Action: 'UNLOCK', AssignmentID: sampleAssignment.id, Notes: 'Apply unlock' }],
      }),
    });
    assert(Number(unlockApply.unlocked || 0) === 1, 'Apply UNLOCK should update one assignment.');
    const exportAfterUnlock = await getJson(`${baseUrl}/api/data/export`);
    const unlockedAssignment = (exportAfterUnlock.assignments || []).find((item) => String(item.id) === String(sampleAssignment.id));
    assert(unlockedAssignment && unlockedAssignment.locked === false, 'Applied UNLOCK should persist locked=false.');
    const unlockedSqlite = await readSqliteAssignment(tempRepoRoot, sampleAssignment.sessionId, sampleAssignment.invigilator?.staffId || '', sampleAssignment.role);
    assert(unlockedSqlite && Number(unlockedSqlite.locked) === 0, 'SQLite should persist unlocked state after apply.');

    const relockApply = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions`, {
      method: 'POST',
      body: JSON.stringify({
        confirmText: 'IMPORT',
        rows: [{ Action: 'LOCK', AssignmentID: sampleAssignment.id, Notes: 'Restore lock' }],
      }),
    });
    assert(Number(relockApply.locked || 0) === 1, 'Apply LOCK should restore one assignment.');

    const schedulingForAdd = await getJson(`${baseUrl}/api/scheduling`);
    const addTargetSession = (schedulingForAdd.sessions || []).find((session) => session.id === 'ses_db_1');
    assert(addTargetSession, 'Expected seeded session ses_db_1 for ADD verification.');
    const addTargetEligible = await getJson(`${baseUrl}/api/scheduling/session/${encodeURIComponent(addTargetSession.id)}/eligible`);
    const addTarget = {
      session: addTargetSession,
      role: 'TA',
      removable: (addTargetSession.taAssignments || []).find((item) => String(item.invigilator?.staffId || '') === 'TA001'),
      replacement: (addTargetEligible.eligibleTAs || []).find((item) => String(item.staffId || '') === 'TA003'),
    };
    assert(addTarget.removable, 'Expected removable seeded TA assignment for ADD verification.');
    assert(addTarget.replacement, 'Expected alternate eligible TA003 for ADD verification.');

    const removeOriginal = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions`, {
      method: 'POST',
      body: JSON.stringify({
        confirmText: 'IMPORT',
        rows: [{ Action: 'REMOVE', AssignmentID: addTarget.removable.id, ForceRemove: 'YES', Notes: 'Create temp gap' }],
      }),
    });
    assert(Number(removeOriginal.removed || 0) === 1, 'Expected one removable assignment to create add gap.');

    const countAfterGap = countSchedulingAssignments(await getJson(`${baseUrl}/api/scheduling`));
    const storeBeforeValidAddDryRun = summarizeFile(storeJsonPath);
    const sqliteBeforeValidAddDryRun = summarizeFile(sqlitePath);
    const validAddDryRun = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        rows: [{
          Action: 'ADD',
          SessionID: addTarget.session.id,
          StaffID: String(addTarget.replacement.staffId || addTarget.replacement.id || ''),
          Role: addTarget.role,
          Notes: 'Dry-run imported assignment',
        }],
      }),
    });
    assert(Number(validAddDryRun.added || 0) === 1, 'Dry-run ADD should validate successfully after creating a temporary gap.');
    const countAfterValidAddDryRun = countSchedulingAssignments(await getJson(`${baseUrl}/api/scheduling`));
    const storeAfterValidAddDryRun = summarizeFile(storeJsonPath);
    const sqliteAfterValidAddDryRun = summarizeFile(sqlitePath);
    assert(countAfterGap === countAfterValidAddDryRun, 'Valid dry-run ADD must not change assignment count.');
    assert(storeBeforeValidAddDryRun.content === storeAfterValidAddDryRun.content, 'store.json changed after valid dry-run ADD.');
    assert(sqliteBeforeValidAddDryRun.size === sqliteAfterValidAddDryRun.size, 'SQLite changed after valid dry-run ADD.');

    const addApply = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions`, {
      method: 'POST',
      body: JSON.stringify({
        confirmText: 'IMPORT',
        rows: [{
          Action: 'ADD',
          SessionID: addTarget.session.id,
          StaffID: String(addTarget.replacement.staffId || addTarget.replacement.id || ''),
          Role: addTarget.role,
          Notes: 'Imported assignment verification',
        }],
      }),
    });
    assert(Number(addApply.added || 0) === 1, 'Expected one imported ADD to succeed.');

    const exportAfterAdd = await getJson(`${baseUrl}/api/data/export`);
    const importedAssignment = (exportAfterAdd.assignments || []).find((item) =>
      String(item.sessionId) === String(addTarget.session.id)
      && String(item.invigilatorId) === String(addTarget.replacement.id)
      && String(item.role) === String(addTarget.role)
    );
    assert(importedAssignment, 'Imported assignment should exist after ADD apply.');
    assert(importedAssignment.assignmentSource === 'import', 'Imported assignment should use assignmentSource=import.');
    assert(importedAssignment.locked === true, 'Imported assignment should default locked=true.');

    const removeLockedReject = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions?dryRun=true`, {
      method: 'POST',
      body: JSON.stringify({
        rows: [{ Action: 'REMOVE', AssignmentID: importedAssignment.id, Notes: 'Should reject without force' }],
      }),
    });
    assert((removeLockedReject.errors || []).some((item) => item.reason === 'locked_assignment_requires_force'), 'Locked imported assignment should reject REMOVE without ForceRemove.');

    const removeImported = await getJson(`${baseUrl}/api/scheduling/import/assignment-actions`, {
      method: 'POST',
      body: JSON.stringify({
        confirmText: 'IMPORT',
        rows: [{ Action: 'REMOVE', AssignmentID: importedAssignment.id, ForceRemove: 'YES', Notes: 'Cleanup imported assignment' }],
      }),
    });
    assert(Number(removeImported.removed || 0) === 1, 'Imported assignment cleanup REMOVE should succeed.');

    const finalScheduling = await getJson(`${baseUrl}/api/scheduling`);
    assert(countSchedulingAssignments(finalScheduling) === assignmentsBefore - 1, 'Expected isolated add/remove flow to leave one removed original assignment in temp verification dataset.');

    const sessionImport = await getJson(`${baseUrl}/api/import/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        rows: [
          { Room: 'Hall C', CourseCode: 'IMP101', Date: '2026-06-03', Start: '09:00', End: '11:00', TANeeded: 2, DoctorNeeded: 1 },
          { Room: 'Hall C', CourseCode: 'IMP102', Date: '2026-06-03', Start: '09:00', End: '12:00', TANeeded: 1, DoctorNeeded: 2 },
        ],
      }),
    });
    assert(Number(sessionImport.rowsImported || 0) === 2, 'Expected the Sessions import endpoint to accept valid rows.');
    assert(Number(sessionImport.sessionsCreatedAfterMerge || 0) === 1, 'Expected matching Sessions import rows to merge into one block.');
    const importedSessions = await getJson(`${baseUrl}/api/sessions`);
    assert(importedSessions.length === 1 && importedSessions[0].endTime === '12:00', 'Expected imported Sessions block to preserve the latest End time.');

    console.log(JSON.stringify({
      result: 'PASS',
      exports: {
        currentSheets: currentWorkbook.SheetNames,
        templateSheets: templateWorkbook.SheetNames,
        lockPlanSheets: ['AssignmentLockPlan'],
        previewSheets: ['PreviewSummary', 'CurrentAssignments', 'PreviewAssignments', 'SolverDiagnostics'],
        globalSheets: globalWorkbook.SheetNames.slice(0, 10),
        templateFile: {
          url: exportTemplate.url,
          signature: templateValidation.signature,
          size: templateValidation.size,
        },
      },
      dryRun: {
        assignmentCountBefore: assignmentsBefore,
        assignmentCountAfter: countSchedulingAssignments(schedulingAfterDryRun),
        storeJsonUnchanged: storeBeforeDryRun.content === storeAfterDryRun.content,
        sqliteUnchanged: sqliteBeforeDryRun.size === sqliteAfterDryRun.size,
        lockValidationUnlocked: dryRunLock.unlocked,
        validAddDryRunAdded: validAddDryRun.added,
        invalidReasons: Array.from(invalidReasons),
      },
      apply: {
        unlockUpdated: unlockApply.unlocked,
        relockUpdated: relockApply.locked,
        removeOriginal: removeOriginal.removed,
        addImported: addApply.added,
        removeImported: removeImported.removed,
        importedAssignmentSource: importedAssignment.assignmentSource,
        importedAssignmentLocked: importedAssignment.locked,
      },
      finalCounts: {
        before: assignmentsBefore,
        final: countSchedulingAssignments(finalScheduling),
      },
      sessionImport: {
        rowsImported: sessionImport.rowsImported,
        sessionsCreatedAfterMerge: sessionImport.sessionsCreatedAfterMerge,
        rowsMerged: sessionImport.rowsMerged,
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
