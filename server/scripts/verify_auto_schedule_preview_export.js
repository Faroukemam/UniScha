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
  throw new Error('Timed out waiting for preview export test server to start.');
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

function buildSeedStore() {
  return {
    sessions: [
      { id: 'ses_db_1', courseNames: ['CSE101'], courseName: 'CSE101', room: 'Hall A', date: '2026-06-01', startTime: '09:00', endTime: '11:00', taNeeded: 1, doctorNeeded: 1, totalNeeded: 2, notes: '' },
      { id: 'ses_db_2', courseNames: ['CSE102'], courseName: 'CSE102', room: 'Hall B', date: '2026-06-01', startTime: '12:00', endTime: '14:00', taNeeded: 1, doctorNeeded: 1, totalNeeded: 2, notes: '' },
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
      { id: 'asg_seed_1', sessionId: 'ses_db_1', invigilatorId: 'inv_ta_1', role: 'TA', assignmentSource: 'legacy', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_2', sessionId: 'ses_db_1', invigilatorId: 'inv_doc_1', role: 'Doctor', assignmentSource: 'legacy', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_3', sessionId: 'ses_db_2', invigilatorId: 'inv_ta_2', role: 'TA', assignmentSource: 'legacy', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
      { id: 'asg_seed_4', sessionId: 'ses_db_2', invigilatorId: 'inv_doc_2', role: 'Doctor', assignmentSource: 'legacy', locked: true, createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z', notes: '' },
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
}

async function run() {
  const liveRepoRoot = path.resolve(__dirname, '..', '..');
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-preview-export-verify-'));
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
  const port = 3190;
  const baseUrl = `http://127.0.0.1:${port}`;
  const requiredSheets = [
    'PreviewSummary',
    'CurrentAssignments',
    'PreviewAssignments',
    'AssignmentsToKeep',
    'AssignmentsToCreate',
    'AssignmentsToRemove',
    'StaffHourComparison',
    'OverTargetStaff',
    'UnderTargetStaff',
    'PolicyViolations',
    'SolverDiagnostics',
  ];

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

    const storeJsonBefore = summarizeFile(storeJsonPath);
    const sqliteBefore = summarizeFile(sqlitePath);
    const statusBefore = await getJson(`${baseUrl}/api/system/storage-status`);

    const runMode = async (mode) => {
      const exportResult = await getJson(`${baseUrl}/api/scheduling/auto-schedule-preview/export`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      const workbookPath = resolveWorkbookPath(tempRepoRoot, exportResult.url);
      const signature = fs.readFileSync(workbookPath).subarray(0, 2).toString('utf8');
      assert(signature === 'PK', `Preview export for mode ${mode} is not a valid XLSX zip.`);
      const workbook = XLSX.readFile(workbookPath);
      requiredSheets.forEach((sheet) => {
        assert(workbook.Sheets[sheet], `Missing sheet ${sheet} for mode ${mode}.`);
      });
      return {
        previewMode: mode,
        sheetNames: workbook.SheetNames,
        signature,
      };
    };

    const preserveAll = await runMode('preserve_all');
    const rebalanceAll = await runMode('rebalance_all');
    const preserveManualOnly = await runMode('preserve_manual_only');

    const statusAfter = await getJson(`${baseUrl}/api/system/storage-status`);
    const storeJsonAfter = summarizeFile(storeJsonPath);
    const sqliteAfter = summarizeFile(sqlitePath);

    const assignmentsBefore = Number(statusBefore.selected?.counts?.assignments ?? statusBefore.sqlite?.counts?.assignments ?? 0);
    const assignmentsAfter = Number(statusAfter.selected?.counts?.assignments ?? statusAfter.sqlite?.counts?.assignments ?? 0);
    const sqliteAssignmentsBefore = Number(statusBefore.sqlite?.counts?.assignments ?? 0);
    const sqliteAssignmentsAfter = Number(statusAfter.sqlite?.counts?.assignments ?? 0);
    const jsonAssignmentsBefore = countAssignmentsFromStoreJson(storeJsonBefore.content);
    const jsonAssignmentsAfter = countAssignmentsFromStoreJson(storeJsonAfter.content);

    assert(assignmentsBefore === assignmentsAfter, 'Assignment count changed after preview export.');
    assert(sqliteAssignmentsBefore === sqliteAssignmentsAfter, 'SQLite assignment count changed after preview export.');
    assert(jsonAssignmentsBefore === jsonAssignmentsAfter, 'store.json assignment count changed after preview export.');
    assert(storeJsonBefore.content === storeJsonAfter.content, 'store.json content changed after preview export.');
    assert(sqliteBefore.size === sqliteAfter.size, 'SQLite file size changed after preview export.');

    console.log(JSON.stringify({
      result: 'PASS',
      endpoint: '/api/scheduling/auto-schedule-preview/export',
      modes: {
        preserve_all: preserveAll,
        rebalance_all: rebalanceAll,
        preserve_manual_only: preserveManualOnly,
      },
      assignmentCounts: {
        before: assignmentsBefore,
        after: assignmentsAfter,
      },
      sqliteAssignments: {
        before: sqliteAssignmentsBefore,
        after: sqliteAssignmentsAfter,
      },
      jsonAssignments: {
        before: jsonAssignmentsBefore,
        after: jsonAssignmentsAfter,
      },
      fileChecks: {
        storeJsonContentUnchanged: storeJsonBefore.content === storeJsonAfter.content,
        sqliteSizeUnchanged: sqliteBefore.size === sqliteAfter.size,
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
