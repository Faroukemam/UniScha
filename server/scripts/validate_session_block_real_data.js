const { readStore, normalizeStoreSessions, getSessionRoomStartKey } = require('../store');

function splitCourses(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueCourses(session) {
  return [...new Set(splitCourses(session.courseNames?.length ? session.courseNames : session.courseName).map((item) => item.toUpperCase()))];
}

function matchNeedsRow(simulatedSessions, row) {
  const byId = new Map(simulatedSessions.map((session) => [String(session.id), session]));
  const byBlock = new Map(simulatedSessions.map((session) => [getSessionRoomStartKey(session), session]));
  const byBlockCourse = new Map(simulatedSessions.map((session) => [
    `${getSessionRoomStartKey(session)}|${uniqueCourses(session).sort().join(';')}`,
    session,
  ]));
  const byExact = new Map(simulatedSessions.map((session) => [
    `${getSessionRoomStartKey(session)}|${String(session.endTime || '').trim()}`,
    session,
  ]));

  const sessionId = String(row.SessionID ?? row.sessionId ?? row.id ?? '').trim();
  if (sessionId && byId.has(sessionId)) {
    return { priority: 'SessionID', session: byId.get(sessionId) };
  }

  const blockKey = getSessionRoomStartKey({
    date: row.Date,
    startTime: row.Start,
    room: row.Room,
  });
  if (byBlock.has(blockKey)) {
    return { priority: 'Room+Date+Start', session: byBlock.get(blockKey) };
  }

  const courseKey = `${blockKey}|${splitCourses(row.CourseCode || row.CourseCodes || row.courseCode || row.courseCodes || '').map((item) => item.toUpperCase()).sort().join(';')}`;
  if (byBlockCourse.has(courseKey)) {
    return { priority: 'Room+Date+Start+CourseCodes', session: byBlockCourse.get(courseKey) };
  }

  const exactKey = `${blockKey}|${String(row.End || '').trim()}`;
  if (byExact.has(exactKey)) {
    return { priority: 'Room+Date+Start+End', session: byExact.get(exactKey) };
  }

  return { priority: 'unmatched', session: null };
}

function buildCurrentDuplicateGroups(sessions) {
  const grouped = new Map();
  sessions.forEach((session) => {
    const key = getSessionRoomStartKey(session);
    const entry = grouped.get(key) || {
      room: session.room,
      date: session.date,
      start: session.startTime,
      rows: [],
      ends: new Set(),
    };
    entry.rows.push(session);
    entry.ends.add(String(session.endTime || ''));
    grouped.set(key, entry);
  });
  return Array.from(grouped.values()).filter((entry) => entry.rows.length > 1 || entry.ends.size > 1);
}

function buildMergedExamples(beforeSessions, afterSessions, maxCount = 5) {
  const afterByBlock = new Map(afterSessions.map((session) => [getSessionRoomStartKey(session), session]));
  const grouped = new Map();
  beforeSessions.forEach((session) => {
    const key = getSessionRoomStartKey(session);
    const entry = grouped.get(key) || [];
    entry.push(session);
    grouped.set(key, entry);
  });
  return Array.from(grouped.entries())
    .filter(([, rows]) => rows.length > 1)
    .slice(0, maxCount)
    .map(([key, rows]) => {
      const merged = afterByBlock.get(key);
      return {
        room: merged?.room || rows[0]?.room || '',
        date: merged?.date || rows[0]?.date || '',
        start: merged?.startTime || rows[0]?.startTime || '',
        originalRows: rows.map((row) => ({
          id: row.id,
          end: row.endTime,
          courseCodes: uniqueCourses(row),
          taNeeded: Number(row.taNeeded || 0),
          doctorNeeded: Number(row.doctorNeeded || 0),
          totalNeeded: Number(row.totalNeeded || 0),
        })),
        merged: merged ? {
          id: merged.id,
          end: merged.endTime,
          courseCodes: uniqueCourses(merged),
          taNeeded: Number(merged.taNeeded || 0),
          doctorNeeded: Number(merged.doctorNeeded || 0),
          totalNeeded: Number(merged.totalNeeded || 0),
        } : null,
      };
    });
}

function buildNeedsRowsFromCurrentSessions(sessions) {
  return sessions.map((session) => ({
    SessionID: session.id,
    Room: session.room,
    Date: session.date,
    Start: session.startTime,
    End: session.endTime,
    CourseCodes: uniqueCourses(session).join('; '),
    TANeeded: Number(session.taNeeded || 0),
    DoctorNeeded: Number(session.doctorNeeded || 0),
    InvigilatorsNeeded: Number(session.totalNeeded || ((session.taNeeded || 0) + (session.doctorNeeded || 0))),
  }));
}

function main() {
  const current = readStore();
  const beforeSessions = current.sessions || [];
  const beforeAssignments = current.assignments || [];
  const beforeDuplicateGroups = buildCurrentDuplicateGroups(beforeSessions);

  const dryRunStore = normalizeStoreSessions(JSON.parse(JSON.stringify(current)));
  const afterSessions = dryRunStore.sessions || [];
  const afterAssignments = dryRunStore.assignments || [];

  const assignmentKeySet = new Set();
  const duplicateAssignments = [];
  afterAssignments.forEach((assignment) => {
    const key = `${assignment.sessionId}|${assignment.invigilatorId}|${assignment.role || ''}`;
    if (assignmentKeySet.has(key)) {
      duplicateAssignments.push(assignment);
      return;
    }
    assignmentKeySet.add(key);
  });

  const afterAssignmentById = new Map(afterAssignments.map((assignment) => [assignment.id, assignment]));
  const assignmentRemapCount = beforeAssignments.reduce((count, assignment) => {
    const next = afterAssignmentById.get(assignment.id);
    if (!next) return count;
    return count + (String(next.sessionId) !== String(assignment.sessionId) ? 1 : 0);
  }, 0);

  const beforeNeedsRows = buildNeedsRowsFromCurrentSessions(beforeSessions);
  const needsMatchCounts = {
    SessionID: 0,
    'Room+Date+Start': 0,
    'Room+Date+Start+CourseCodes': 0,
    'Room+Date+Start+End': 0,
    unmatched: 0,
  };
  const unmatchedNeedsExamples = [];
  beforeNeedsRows.forEach((row, index) => {
    const match = matchNeedsRow(afterSessions, row);
    needsMatchCounts[match.priority] = (needsMatchCounts[match.priority] || 0) + 1;
    if (match.priority === 'unmatched' && unmatchedNeedsExamples.length < 5) {
      unmatchedNeedsExamples.push({ row: index + 1, ...row });
    }
  });

  const mergedExamples = buildMergedExamples(beforeSessions, afterSessions, 10);
  const sessionsReduced = beforeSessions.length - afterSessions.length;

  const output = {
    result: 'PASS',
    workingDirectory: process.cwd(),
    sessionsBefore: beforeSessions.length,
    sessionsAfterDryRunMerge: afterSessions.length,
    groupsThatWouldMerge: mergedExamples.length,
    sessionsReduced,
    currentDuplicateBlockGroups: beforeDuplicateGroups.length,
    currentDuplicateExamples: beforeDuplicateGroups.slice(0, 10).map((entry) => ({
      room: entry.room,
      date: entry.date,
      start: entry.start,
      ends: Array.from(entry.ends),
      sessionIds: entry.rows.map((row) => row.id),
      courseCodes: entry.rows.map((row) => uniqueCourses(row)),
    })),
    assignmentSafety: {
      assignmentsBefore: beforeAssignments.length,
      assignmentsAfterDryRun: afterAssignments.length,
      assignmentRemapCount,
      assignmentDropCount: Math.max(0, beforeAssignments.length - afterAssignments.length),
      duplicateAssignmentsAfterRemap: duplicateAssignments.length,
      duplicateExamples: duplicateAssignments.slice(0, 5),
    },
    sessionNeedsMatch: {
      totalNeedsRowsChecked: beforeNeedsRows.length,
      counts: needsMatchCounts,
      unmatchedExamples: unmatchedNeedsExamples,
    },
    mergedExamples,
    demandRule: {
      taNeeded: 'maximum value across rows in the same Room + Date + Start block',
      doctorNeeded: 'maximum value across rows in the same Room + Date + Start block',
      totalNeeded: 'maximum explicit total value across rows in the same block',
      notes: 'course codes are merged uniquely and end time becomes the maximum end in the block',
    },
    alreadyNormalizedToBlockLogic: beforeDuplicateGroups.length === 0,
  };

  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message }, null, 2));
  process.exit(1);
}
