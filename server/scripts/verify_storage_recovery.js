const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const dataDir = path.join(projectRoot, 'server', 'data');
const storePath = path.join(dataDir, 'store.json');
const backupPath = path.join(dataDir, 'store.last-good.json');
const sqlitePath = path.join(dataDir, 'scheduler.sqlite');

function requireFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

function fileBufferOrNull(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restoreFile(filePath, buffer) {
  if (buffer === null) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  fs.writeFileSync(filePath, buffer);
}

function buildCounts(storeModule) {
  return storeModule.summarizeStoreCounts(storeModule.readStore());
}

function sessionSignature(session) {
  return [
    session.date || '',
    session.startTime || '',
    session.endTime || '',
    session.room || '',
  ].join('|');
}

async function main() {
  const originalStore = fileBufferOrNull(storePath);
  const originalBackup = fileBufferOrNull(backupPath);
  const originalSqlite = fileBufferOrNull(sqlitePath);

  let pass = false;

  try {
    let storeModule = requireFresh(path.join(projectRoot, 'server', 'store.js'));
    await storeModule.initStoreFromPrimary();
    let store = storeModule.readStore();

    if (!Array.isArray(store.sessions) || store.sessions.length === 0) {
      throw new Error('Verification requires at least one session.');
    }
    if (!Array.isArray(store.invigilators) || store.invigilators.length === 0) {
      throw new Error('Verification requires at least one invigilator.');
    }

    const targetSession = store.sessions.find((item) => Number(item.taNeeded || 0) > 0 || Number(item.doctorNeeded || 0) > 0) || store.sessions[0];
    const preferredRole = Number(targetSession.taNeeded || 0) > 0 ? 'TA' : (Number(targetSession.doctorNeeded || 0) > 0 ? 'Doctor' : null);
    const targetInvigilator = store.invigilators.find((item) => !preferredRole || item.role === preferredRole) || store.invigilators[0];

    const verificationAssignmentKey = `${sessionSignature(targetSession)}|${targetInvigilator.staffId}|${targetInvigilator.role}`;
    const storeSessions = new Map(store.sessions.map((item) => [item.id, item]));
    const storeInvigilators = new Map(store.invigilators.map((item) => [item.id, item]));
    if (!store.assignments.some((item) => {
      const session = storeSessions.get(item.sessionId);
      const invigilator = storeInvigilators.get(item.invigilatorId);
      if (!session || !invigilator) return false;
      return `${sessionSignature(session)}|${invigilator.staffId}|${item.role}` === verificationAssignmentKey;
    })) {
      store.assignments = [
        ...store.assignments,
        {
          id: `verify_${Date.now()}`,
          sessionId: targetSession.id,
          invigilatorId: targetInvigilator.id,
          role: targetInvigilator.role,
        },
      ];
    }

    await storeModule.writeStore(store);

    const statusModule = requireFresh(path.join(projectRoot, 'server', 'store.js'));
    const statusBefore = await statusModule.getStorageStatus();
    const countsBefore = buildCounts(statusModule);
    const beforeStore = statusModule.readStore();
    const beforeSessions = new Map(beforeStore.sessions.map((item) => [item.id, item]));
    const beforeInvigilators = new Map(beforeStore.invigilators.map((item) => [item.id, item]));
    const assignmentPresentBefore = beforeStore.assignments.some((item) => {
      const session = beforeSessions.get(item.sessionId);
      const invigilator = beforeInvigilators.get(item.invigilatorId);
      if (!session || !invigilator) return false;
      return `${sessionSignature(session)}|${invigilator.staffId}|${item.role}` === verificationAssignmentKey;
    });

    fs.writeFileSync(storePath, JSON.stringify({
      sessions: [],
      invigilators: [],
      engagements: [],
      assignments: [],
      superAssignments: [],
      controlSessions: [],
      controlAssignments: [],
    }, null, 2));
    fs.writeFileSync(backupPath, JSON.stringify({
      sessions: [],
      invigilators: [],
      engagements: [],
      assignments: [],
      superAssignments: [],
      controlSessions: [],
      controlAssignments: [],
    }, null, 2));

    storeModule = requireFresh(path.join(projectRoot, 'server', 'store.js'));
    await storeModule.initStoreFromPrimary();
    const restoredStore = storeModule.readStore();
    const countsAfter = storeModule.summarizeStoreCounts(restoredStore);
    const restoredSessions = new Map(restoredStore.sessions.map((item) => [item.id, item]));
    const restoredInvigilators = new Map(restoredStore.invigilators.map((item) => [item.id, item]));
    const assignmentPresentAfter = restoredStore.assignments.some((item) => {
      const session = restoredSessions.get(item.sessionId);
      const invigilator = restoredInvigilators.get(item.invigilatorId);
      if (!session || !invigilator) return false;
      return `${sessionSignature(session)}|${invigilator.staffId}|${item.role}` === verificationAssignmentKey;
    });
    const statusAfter = await storeModule.getStorageStatus();

    const sameCounts = JSON.stringify(countsBefore) === JSON.stringify(countsAfter);
    const assignmentSurvived = assignmentPresentBefore && assignmentPresentAfter;
    pass = sameCounts && assignmentSurvived;

    console.log(JSON.stringify({
      result: pass ? 'PASS' : 'FAIL',
      countsBefore,
      countsAfter,
      verificationAssignmentKey,
      assignmentPresentBefore,
      assignmentPresentAfter,
      startupSourceAfter: statusAfter.startup.startupSource,
      sqliteAssignments: statusBefore.sqlite.counts.assignments,
      storeJsonAssignments: statusBefore.storeJson.counts.assignments,
      storeLastGoodAssignments: statusBefore.storeLastGoodJson.counts.assignments,
    }, null, 2));
  } finally {
    restoreFile(storePath, originalStore);
    restoreFile(backupPath, originalBackup);
    restoreFile(sqlitePath, originalSqlite);
  }

  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message }, null, 2));
  process.exitCode = 1;
});
