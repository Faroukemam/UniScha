const {
  normalizeStoreSessions,
  getSessionRoomStartKey,
  getSessionRoomStartCourseKey,
  getSessionRoomTimeKey,
  buildSchedulingView,
} = require('../store');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildNeedsMatchMaps(sessions) {
  return {
    byId: new Map(sessions.map((session) => [String(session.id), session])),
    byBlock: new Map(sessions.map((session) => [getSessionRoomStartKey(session), session])),
    byBlockCourse: new Map(sessions.map((session) => [getSessionRoomStartCourseKey(session), session])),
    byExact: new Map(sessions.map((session) => [getSessionRoomTimeKey(session), session])),
  };
}

function matchSessionNeedsRow(sessions, row) {
  const maps = buildNeedsMatchMaps(sessions);
  const sessionId = String(row.SessionID ?? row.sessionId ?? row.id ?? '').trim();
  const blockKey = getSessionRoomStartKey({
    date: row.Date,
    startTime: row.Start,
    room: row.Room,
  });
  const courseKey = getSessionRoomStartCourseKey({
    date: row.Date,
    startTime: row.Start,
    room: row.Room,
    courseNames: String(row.CourseCode || row.CourseCodes || '').split(/[\n;,]+/).map((item) => item.trim()).filter(Boolean),
  });
  const exactKey = getSessionRoomTimeKey({
    date: row.Date,
    startTime: row.Start,
    endTime: row.End,
    room: row.Room,
  });
  return maps.byId.get(sessionId)
    || maps.byBlock.get(blockKey)
    || maps.byBlockCourse.get(courseKey)
    || maps.byExact.get(exactKey)
    || null;
}

function exportSessionRows(sessions) {
  return sessions.map((session) => ({
    Room: session.room || '',
    CourseCode: Array.isArray(session.courseNames) ? session.courseNames.join('; ') : (session.courseName || ''),
    Date: session.date || '',
    Start: session.startTime || '',
    End: session.endTime || '',
  }));
}

function main() {
  const rawStore = {
    sessions: [
      {
        id: 'ses_A_short',
        courseNames: ['ME101'],
        courseName: 'ME101',
        room: 'Room A',
        date: '2026-06-01',
        startTime: '09:30',
        endTime: '11:30',
        taNeeded: 1,
        doctorNeeded: 0,
        totalNeeded: 1,
        notes: 'short block',
      },
      {
        id: 'ses_A_long',
        courseNames: ['ME102'],
        courseName: 'ME102',
        room: 'Room A',
        date: '2026-06-01',
        startTime: '09:30',
        endTime: '12:30',
        taNeeded: 2,
        doctorNeeded: 1,
        totalNeeded: 3,
        notes: 'long block',
      },
      {
        id: 'ses_B',
        courseNames: ['CE201'],
        courseName: 'CE201',
        room: 'Room B',
        date: '2026-06-01',
        startTime: '09:30',
        endTime: '11:30',
        taNeeded: 1,
        doctorNeeded: 0,
        totalNeeded: 1,
      },
    ],
    invigilators: [
      { id: 'inv_1', staffId: '1001', name: 'TA 1', role: 'TA', maxHours: 8 },
      { id: 'inv_2', staffId: '1002', name: 'TA 2', role: 'TA', maxHours: 8 },
      { id: 'inv_3', staffId: '2001', name: 'Dr 1', role: 'Doctor', maxHours: 8 },
    ],
    engagements: [],
    assignments: [
      { id: 'asg_1', sessionId: 'ses_A_short', invigilatorId: 'inv_1', role: 'TA' },
      { id: 'asg_2', sessionId: 'ses_A_long', invigilatorId: 'inv_2', role: 'TA' },
      { id: 'asg_3', sessionId: 'ses_B', invigilatorId: 'inv_3', role: 'Doctor' },
    ],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: [],
    onCallAssignments: [],
  };

  const normalized = normalizeStoreSessions(rawStore);
  const mergedA = normalized.sessions.find((session) => session.room === 'Room A' && session.date === '2026-06-01' && session.startTime === '09:30');
  const sessionB = normalized.sessions.find((session) => session.room === 'Room B');

  assert(normalized.sessions.length === 2, `Expected 2 merged sessions, got ${normalized.sessions.length}`);
  assert(mergedA, 'Merged Room A block was not found');
  assert(sessionB, 'Room B block was not preserved');
  assert(mergedA.endTime === '12:30', `Expected Room A max End 12:30, got ${mergedA.endTime}`);
  assert((mergedA.courseNames || []).length === 2, `Expected 2 merged Room A courses, got ${(mergedA.courseNames || []).length}`);
  assert(sessionB.endTime === '11:30', `Expected Room B End 11:30, got ${sessionB.endTime}`);

  const roomAAssignments = normalized.assignments.filter((assignment) => assignment.sessionId === mergedA.id);
  assert(roomAAssignments.length === 2, `Expected 2 remapped assignments on merged Room A block, got ${roomAAssignments.length}`);

  const matchedNeeds = matchSessionNeedsRow(normalized.sessions, {
    Room: 'Room A',
    Date: '2026-06-01',
    Start: '09:30',
    End: '11:30',
    CourseCode: 'ME101',
    TANeeded: 5,
    DoctorNeeded: 2,
    InvigilatorsNeeded: 7,
  });
  assert(matchedNeeds && matchedNeeds.id === mergedA.id, 'Session Needs row with shorter End did not match the merged block');

  mergedA.taNeeded = 5;
  mergedA.doctorNeeded = 2;
  mergedA.totalNeeded = 7;

  const schedulingView = buildSchedulingView(normalized);
  const schedulingSession = schedulingView.sessions.find((session) => session.id === mergedA.id);
  assert(schedulingSession && schedulingSession.endTime === '12:30', 'Scheduling view did not preserve merged max End');

  const exportedRows = exportSessionRows(normalized.sessions);
  const exportedRoomA = exportedRows.find((row) => row.Room === 'Room A');
  assert(exportedRoomA && exportedRoomA.End === '12:30', 'Workbook export row did not use merged max End');
  assert(String(exportedRoomA.CourseCode || '').includes('ME101') && String(exportedRoomA.CourseCode || '').includes('ME102'), 'Workbook export row did not merge course codes');

  const output = {
    result: 'PASS',
    oldMergeKey: 'Room + Date + Start + End',
    newMergeKey: 'Room + Date + Start',
    before: rawStore.sessions.map((session) => ({
      room: session.room,
      date: session.date,
      start: session.startTime,
      end: session.endTime,
      course: session.courseName,
    })),
    after: normalized.sessions.map((session) => ({
      id: session.id,
      room: session.room,
      date: session.date,
      start: session.startTime,
      end: session.endTime,
      courses: session.courseNames,
      taNeeded: session.taNeeded,
      doctorNeeded: session.doctorNeeded,
      totalNeeded: session.totalNeeded,
    })),
    assignmentRemap: {
      beforeAssignments: rawStore.assignments,
      afterAssignments: normalized.assignments,
      mergedRoomAAssignmentCount: roomAAssignments.length,
    },
    needsMatch: {
      matchedSessionId: matchedNeeds.id,
      matchedRoom: matchedNeeds.room,
      matchedEnd: matchedNeeds.endTime,
    },
    schedulingViewRoomA: {
      endTime: schedulingSession.endTime,
      taRemaining: schedulingSession.taRemaining,
      doctorRemaining: schedulingSession.doctorRemaining,
    },
    exportRoomA: exportedRoomA,
  };

  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    result: 'FAIL',
    error: error.message,
  }, null, 2));
  process.exit(1);
}
