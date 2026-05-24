const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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
  throw new Error('Timed out waiting for role-scope verification server.');
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
      { id: 'asg_seed_1', sessionId: 'ses_db_1', invigilatorId: 'inv_ta_1', role: 'TA', assignmentSource: 'auto', locked: false, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_2', sessionId: 'ses_db_1', invigilatorId: 'inv_doc_1', role: 'Doctor', assignmentSource: 'auto', locked: false, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_3', sessionId: 'ses_db_2', invigilatorId: 'inv_ta_1', role: 'TA', assignmentSource: 'auto', locked: false, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_4', sessionId: 'ses_db_2', invigilatorId: 'inv_doc_1', role: 'Doctor', assignmentSource: 'auto', locked: false, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
    ],
    onCallAssignments: [],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: [],
    staffHourPolicies: [
      { id: 'pol_ta_1', invigilatorId: 'inv_ta_1', staffId: 'TA001', role: 'TA', mode: 'exclude', hoursValue: 0, excludeFromAutoSchedule: true, notes: 'Force TA replacement' },
      { id: 'pol_doc_1', invigilatorId: 'inv_doc_1', staffId: 'DR001', role: 'Doctor', mode: 'exclude', hoursValue: 0, excludeFromAutoSchedule: true, notes: 'Force Doctor replacement' },
    ],
  };
}

async function run() {
  const liveRepoRoot = path.resolve(__dirname, '..', '..');
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-role-scope-verify-'));
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
  const port = 3191;
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
    const schedulingBefore = await getJson(`${baseUrl}/api/scheduling`);
    const currentRoleCounts = (schedulingBefore.sessions || []).reduce((acc, session) => {
      acc.TA += Number(session.assignedTACount || 0);
      acc.Doctor += Number(session.assignedDoctorCount || 0);
      return acc;
    }, { TA: 0, Doctor: 0 });

    const preserveAllTa = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_all', roleScope: 'ta_only' }),
    });
    const preserveAllDoctor = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'preserve_all', roleScope: 'doctor_only' }),
    });
    const both = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'rebalance_all', roleScope: 'both' }),
    });
    const taOnly = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'rebalance_all', roleScope: 'ta_only' }),
    });
    const doctorOnly = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'rebalance_all', roleScope: 'doctor_only' }),
    });

    assert(Number(taOnly.doctorAssignmentsWouldCreate || 0) === 0, 'ta_only must not create doctor assignments.');
    assert(Number(taOnly.doctorAssignmentsWouldRemove || 0) === 0, 'ta_only must not remove doctor assignments.');
    assert(Number(taOnly.preservedDoctorAssignments || 0) === currentRoleCounts.Doctor, 'ta_only must preserve current doctor assignments.');
    assert(Number(doctorOnly.taAssignmentsWouldCreate || 0) === 0, 'doctor_only must not create TA assignments.');
    assert(Number(doctorOnly.taAssignmentsWouldRemove || 0) === 0, 'doctor_only must not remove TA assignments.');
    assert(Number(doctorOnly.preservedTAAssignments || 0) === currentRoleCounts.TA, 'doctor_only must preserve current TA assignments.');
    assert(Number(preserveAllTa.assignmentsWouldCreate || 0) === 0, 'preserve_all + ta_only must not change assignments.');
    assert(Number(preserveAllDoctor.assignmentsWouldRemove || 0) === 0, 'preserve_all + doctor_only must not change assignments.');

    const exportResult = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview/export`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'rebalance_all', roleScope: 'ta_only' }),
    });
    const workbookPath = resolveWorkbookPath(tempRepoRoot, exportResult.url);
    assert(fs.readFileSync(workbookPath).subarray(0, 2).toString('utf8') === 'PK', 'Role-scope preview export must be a valid XLSX zip.');
    const workbook = XLSX.readFile(workbookPath);
    const summaryRows = XLSX.utils.sheet_to_json(workbook.Sheets.PreviewSummary || {});
    const diagnosticsRows = XLSX.utils.sheet_to_json(workbook.Sheets.SolverDiagnostics || {});
    assert(String(summaryRows.find((row) => row.Metric === 'RoleScope')?.Value || '') === 'ta_only', 'PreviewSummary must include roleScope.');
    assert(String(diagnosticsRows.find((row) => row.Metric === 'roleScope')?.Value || '') === 'ta_only', 'SolverDiagnostics must include roleScope.');

    const schedulingAfter = await getJson(`${baseUrl}/api/scheduling`);
    const storeJsonAfter = fs.readFileSync(storeJsonPath, 'utf8');
    const sqliteAfter = fs.statSync(sqlitePath).size;
    assert(storeJsonBefore === storeJsonAfter, 'Role-scope preview must not rewrite store.json.');
    assert(sqliteBefore === sqliteAfter, 'Role-scope preview must not rewrite sqlite.');
    assert(
      (schedulingAfter.sessions || []).reduce((sum, session) => sum + Number(session.assignmentCount || 0), 0)
        === (schedulingBefore.sessions || []).reduce((sum, session) => sum + Number(session.assignmentCount || 0), 0),
      'Role-scope preview must not change assignment count.'
    );

    console.log(JSON.stringify({
      result: 'PASS',
      currentRoleCounts,
      preserveAll: {
        ta_only: {
          roleScope: preserveAllTa.roleScope,
          assignmentsWouldCreate: preserveAllTa.assignmentsWouldCreate,
          assignmentsWouldRemove: preserveAllTa.assignmentsWouldRemove,
        },
        doctor_only: {
          roleScope: preserveAllDoctor.roleScope,
          assignmentsWouldCreate: preserveAllDoctor.assignmentsWouldCreate,
          assignmentsWouldRemove: preserveAllDoctor.assignmentsWouldRemove,
        },
      },
      rebalanceAll: {
        both: {
          roleScope: both.roleScope,
          assignmentsWouldCreate: both.assignmentsWouldCreate,
          assignmentsWouldRemove: both.assignmentsWouldRemove,
        },
        ta_only: {
          roleScope: taOnly.roleScope,
          preservedDoctorAssignments: taOnly.preservedDoctorAssignments,
          taAssignmentsWouldCreate: taOnly.taAssignmentsWouldCreate,
          taAssignmentsWouldRemove: taOnly.taAssignmentsWouldRemove,
          doctorAssignmentsWouldCreate: taOnly.doctorAssignmentsWouldCreate,
          doctorAssignmentsWouldRemove: taOnly.doctorAssignmentsWouldRemove,
          taShortage: taOnly.taShortage,
          doctorShortage: taOnly.doctorShortage,
        },
        doctor_only: {
          roleScope: doctorOnly.roleScope,
          preservedTAAssignments: doctorOnly.preservedTAAssignments,
          taAssignmentsWouldCreate: doctorOnly.taAssignmentsWouldCreate,
          taAssignmentsWouldRemove: doctorOnly.taAssignmentsWouldRemove,
          doctorAssignmentsWouldCreate: doctorOnly.doctorAssignmentsWouldCreate,
          doctorAssignmentsWouldRemove: doctorOnly.doctorAssignmentsWouldRemove,
          taShortage: doctorOnly.taShortage,
          doctorShortage: doctorOnly.doctorShortage,
        },
      },
      exportChecks: {
        roleScopeSummaryValue: summaryRows.find((row) => row.Metric === 'RoleScope')?.Value || '',
        roleScopeDiagnosticsValue: diagnosticsRows.find((row) => row.Metric === 'roleScope')?.Value || '',
      },
      noWriteChecks: {
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
