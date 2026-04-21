const fs = require('fs');
const path = require('path');
const { initDb, write: writeDb } = require('./db');

const dataDir = path.join(__dirname, 'data');
const storePath = path.join(dataDir, 'store.json');

const emptyStore = {
  sessions: [],
  invigilators: [],
  engagements: [],
  assignments: [],
  superAssignments: [],
  controlSessions: [],
  controlAssignments: []
};

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify(emptyStore, null, 2));
  }
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(storePath, 'utf8');
  const parsed = JSON.parse(raw);
  return normalizeStoreSessions({
    ...emptyStore,
    ...parsed,
    engagements: Array.isArray(parsed.engagements) ? parsed.engagements : [],
    controlSessions: Array.isArray(parsed.controlSessions) ? parsed.controlSessions : []
  });
}

function writeStore(data) {
  ensureStore();
  const normalized = normalizeStoreSessions({
    ...emptyStore,
    ...data,
    engagements: Array.isArray(data.engagements) ? data.engagements : [],
    controlSessions: Array.isArray(data.controlSessions) ? data.controlSessions : []
  });
  fs.writeFileSync(storePath, JSON.stringify(normalized, null, 2));
  syncStoreToDb(normalized).catch(() => {});
  return normalized;
}

function getSessionRoomTimeKey(session) {
  return [
    String(session.date || session.exam_date || '').trim(),
    String(session.startTime || session.start_time || '').trim(),
    String(session.endTime || session.end_time || '').trim(),
    String(session.room || '').trim().toLowerCase()
  ].join('|');
}

function normalizeCourseList(session) {
  if (Array.isArray(session.courseNames)) {
    return session.courseNames.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(session.courseName || session.course_name || '')
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStoreSessions(store) {
  if (!Array.isArray(store.sessions) || store.sessions.length < 2) {
    return store;
  }

  const hasLegacySampleDateBug = store.sessions.some((session) => {
    const match = String(session.date || '').match(/^(\d{4})-(\d{2})-06$/);
    return match && Number(match[2]) > 12;
  });

  const groups = new Map();
  const sessionIdRemap = new Map();

  store.sessions.forEach((session) => {
    const normalizedSession = hasLegacySampleDateBug ? repairLegacySampleDate(session) : session;
    const key = getSessionRoomTimeKey(normalizedSession);
    if (!key.replace(/\|/g, '').trim()) {
      groups.set(`${key}|${normalizedSession.id}`, { ...normalizedSession });
      return;
    }

    if (!groups.has(key)) {
      groups.set(key, {
        ...normalizedSession,
        courseNames: [],
        courseName: '',
        taNeeded: Number(normalizedSession.taNeeded ?? normalizedSession.ta_needed ?? 0),
        doctorNeeded: Number(normalizedSession.doctorNeeded ?? normalizedSession.doctor_needed ?? 0),
        totalNeeded: Number(normalizedSession.totalNeeded ?? normalizedSession.total_needed ?? 0)
      });
    }

    const merged = groups.get(key);
    sessionIdRemap.set(String(normalizedSession.id), merged.id);
    const existingCourses = new Set(merged.courseNames.map((item) => item.toLowerCase()));
    normalizeCourseList(normalizedSession).forEach((course) => {
      const normalized = course.toLowerCase();
      if (!existingCourses.has(normalized)) {
        merged.courseNames.push(course);
        existingCourses.add(normalized);
      }
    });

    merged.courseName = merged.courseNames.join('; ');
    merged.taNeeded = Math.max(Number(merged.taNeeded || 0), Number(normalizedSession.taNeeded ?? normalizedSession.ta_needed ?? 0));
    merged.doctorNeeded = Math.max(Number(merged.doctorNeeded || 0), Number(normalizedSession.doctorNeeded ?? normalizedSession.doctor_needed ?? 0));
    merged.totalNeeded = Math.max(
      Number(merged.totalNeeded || 0),
      Number(normalizedSession.totalNeeded ?? normalizedSession.total_needed ?? ((normalizedSession.taNeeded || 0) + (normalizedSession.doctorNeeded || 0)))
    );
    if (!merged.notes && normalizedSession.notes) {
      merged.notes = normalizedSession.notes;
    }
  });

  const seenAssignments = new Set();
  const assignments = (Array.isArray(store.assignments) ? store.assignments : [])
    .map((assignment) => ({
      ...assignment,
      sessionId: sessionIdRemap.get(String(assignment.sessionId)) || assignment.sessionId
    }))
    .filter((assignment) => {
      const key = `${assignment.sessionId}|${assignment.invigilatorId}|${assignment.role || ''}`;
      if (seenAssignments.has(key)) return false;
      seenAssignments.add(key);
      return true;
    });

  return {
    ...store,
    sessions: Array.from(groups.values()),
    assignments
  };
}

function repairLegacySampleDate(session) {
  const match = String(session.date || '').match(/^(\d{4})-(\d{2})-06$/);
  if (!match) return session;
  const [, year, misplacedDay] = match;
  const day = Number(misplacedDay);
  if (day < 1 || day > 31) return session;
  return {
    ...session,
    date: `${year}-06-${String(day).padStart(2, '0')}`
  };
}

async function syncStoreToDb(store) {
  await initDb();
  await writeDb((db) => {
    db.run('DELETE FROM assignments');
    db.run('DELETE FROM super_assignments');
    db.run('DELETE FROM control_assignments');
    db.run('DELETE FROM control_sessions');
    db.run('DELETE FROM engagements');
    db.run('DELETE FROM sessions');
    db.run('DELETE FROM invigilators');

    const sessionStmt = db.prepare(`
      INSERT INTO sessions (id, course_name, room, exam_date, start_time, end_time, duration_hours, ta_needed, doctor_needed, total_needed, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const session of store.sessions) {
      const taNeeded = Number(session.taNeeded ?? session.ta_needed ?? 0);
      const doctorNeeded = Number(session.doctorNeeded ?? session.doctor_needed ?? 0);
      const totalNeeded = Number(session.totalNeeded ?? session.total_needed ?? 0);
      sessionStmt.run([
        Number(String(session.id).replace(/\D/g, '')) || null,
        getCourseLabel(session, ''),
        String(session.room || ''),
        String(session.date || session.exam_date || ''),
        String(session.startTime || session.start_time || ''),
        String(session.endTime || session.end_time || ''),
        Number(session.durationHours || session.duration_hours || 0),
        taNeeded,
        doctorNeeded,
        totalNeeded,
        String(session.notes || '')
      ]);
    }
    sessionStmt.free();

    const invigilatorStmt = db.prepare(`
      INSERT INTO invigilators (staff_id, name, email, role, load_type, max_hours, department, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const invigilator of store.invigilators) {
      invigilatorStmt.run([
        String(invigilator.staffId || invigilator.staff_id || invigilator.id || ''),
        String(invigilator.name || ''),
        String(invigilator.email || ''),
        String(invigilator.role || 'TA'),
        String(invigilator.loadType || invigilator.load_type || 'full'),
        Number(invigilator.maxHours || invigilator.max_hours || 0),
        String(invigilator.department || ''),
        String(invigilator.notes || '')
      ]);
    }
    invigilatorStmt.free();

    const engagementStmt = db.prepare(`
      INSERT INTO engagements (staff_id, exam_date, start_time, end_time, engagement, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const engagement of store.engagements) {
      engagementStmt.run([
        String(engagement.staffId || engagement.staff_id || ''),
        String(engagement.date || engagement.exam_date || ''),
        String(engagement.startTime || engagement.start_time || ''),
        String(engagement.endTime || engagement.end_time || ''),
        Number(engagement.engagement ?? 1),
        String(engagement.notes || '')
      ]);
    }
    engagementStmt.free();

    const assignmentStmt = db.prepare(`
      INSERT INTO assignments (session_id, staff_id, role)
      VALUES (?, ?, ?)
    `);
    for (const assignment of store.assignments) {
      assignmentStmt.run([
        Number(String(assignment.sessionId || assignment.session_id || '').replace(/\D/g, '')) || null,
        String(assignment.staffId || assignment.staff_id || assignment.invigilatorId || ''),
        String(assignment.role || '')
      ]);
    }
    assignmentStmt.free();

    const superStmt = db.prepare(`
      INSERT INTO super_assignments (exam_date, staff_id)
      VALUES (?, ?)
    `);
    for (const row of store.superAssignments) {
      superStmt.run([
        String(row.date || row.exam_date || ''),
        String(row.staffId || row.staff_id || row.invigilatorId || '')
      ]);
    }
    superStmt.free();

    const controlSessionStmt = db.prepare(`
      INSERT INTO control_sessions (id, course_name, room, exam_date, start_time, end_time, ta_needed, doctor_needed, total_needed, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const session of store.controlSessions) {
      controlSessionStmt.run([
        Number(String(session.id).replace(/\D/g, '')) || null,
        getCourseLabel(session, ''),
        String(session.room || ''),
        String(session.date || session.exam_date || ''),
        String(session.startTime || session.start_time || ''),
        String(session.endTime || session.end_time || ''),
        Number(session.taNeeded || session.ta_needed || 0),
        Number(session.doctorNeeded || session.doctor_needed || 0),
        Number(session.totalNeeded || session.total_needed || 0),
        String(session.notes || '')
      ]);
    }
    controlSessionStmt.free();

    const controlStmt = db.prepare(`
      INSERT INTO control_assignments (control_session_id, staff_id, role)
      VALUES (?, ?, ?)
    `);
    for (const row of store.controlAssignments) {
      controlStmt.run([
        Number(String(row.controlSessionId || row.control_session_id || '').replace(/\D/g, '')) || null,
        String(row.staffId || row.staff_id || row.invigilatorId || ''),
        String(row.role || '')
      ]);
    }
    controlStmt.free();
  });
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTimeToMinutes(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return 0;
  }
  if (raw.includes(':')) {
    const [hours, minutes] = raw.split(':').map(Number);
    return (hours * 60) + minutes;
  }
  const numeric = Number(raw);
  const hours = Math.floor(numeric / 100);
  const minutes = numeric % 100;
  return (hours * 60) + minutes;
}

function getDurationMinutes(start, end) {
  return Math.max(0, parseTimeToMinutes(end) - parseTimeToMinutes(start));
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function getCourseLabel(session, fallback = 'Session') {
  if (Array.isArray(session.courseNames) && session.courseNames.length) {
    return session.courseNames.join('; ');
  }
  return String(session.courseName || session.course_name || fallback || '').trim();
}

function getDayWindows(sessions) {
  const grouped = new Map();
  for (const session of sessions) {
    if (!session.date) {
      continue;
    }
    const start = parseTimeToMinutes(session.startTime);
    const end = parseTimeToMinutes(session.endTime);
    if (!grouped.has(session.date)) {
      grouped.set(session.date, { date: session.date, start, end });
      continue;
    }
    const current = grouped.get(session.date);
    current.start = Math.min(current.start, start);
    current.end = Math.max(current.end, end);
  }

  return Array.from(grouped.values())
    .map((item) => ({
      date: item.date,
      startTime: minutesToTime(item.start),
      endTime: minutesToTime(item.end),
      durationMinutes: Math.max(0, item.end - item.start)
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function rangesOverlap(startA, endA, startB, endB) {
  return parseTimeToMinutes(startA) < parseTimeToMinutes(endB)
    && parseTimeToMinutes(startB) < parseTimeToMinutes(endA);
}

function getAssignedMinutesByInvigilator(store) {
  const totals = new Map();
  const { sessionDuties, superDuties, controlDuties } = buildDutyCollections(store);

  [...sessionDuties, ...superDuties, ...controlDuties].forEach((duty) => {
    totals.set(duty.invigilatorId, (totals.get(duty.invigilatorId) || 0) + Number(duty.durationMinutes || 0));
  });

  return totals;
}

function getEligibilityForSession(store, session, person, assignedMinutesByInvigilator) {
  const sessionAssignments = store.assignments.filter((item) => item.sessionId === session.id);
  const alreadyAssignedToSession = sessionAssignments.some((item) => item.invigilatorId === person.id);
  if (alreadyAssignedToSession) {
    return { eligible: false, reason: 'already_assigned', currentMinutes: assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const blockedByEngagement = store.engagements.some((item) =>
    item.staffId === person.staffId
    && item.date === session.date
    && Number(item.engagement ?? 1) === 1
    && rangesOverlap(session.startTime, session.endTime, item.startTime, item.endTime)
  );
  if (blockedByEngagement) {
    return { eligible: false, reason: 'engagement', currentMinutes: assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingAssignment = store.assignments.some((assignment) => {
    if (assignment.invigilatorId !== person.id) return false;
    const otherSession = store.sessions.find((item) => item.id === assignment.sessionId);
    if (!otherSession || otherSession.id === session.id || otherSession.date !== session.date) return false;
    return rangesOverlap(session.startTime, session.endTime, otherSession.startTime, otherSession.endTime);
  });
  if (overlappingAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const currentMinutes = assignedMinutesByInvigilator.get(person.id) || 0;
  const projectedMinutes = currentMinutes + getDurationMinutes(session.startTime, session.endTime);
  const maxMinutes = Number(person.maxHours || 0) * 60;
  if (maxMinutes > 0 && projectedMinutes > maxMinutes) {
    return { eligible: false, reason: 'max_hours', currentMinutes, projectedMinutes, maxMinutes };
  }

  return {
    eligible: true,
    currentMinutes,
    projectedMinutes,
    maxMinutes
  };
}

function buildSchedulingView(store) {
  const bySession = new Map();
  for (const assignment of store.assignments) {
    const list = bySession.get(assignment.sessionId) || [];
    list.push(assignment);
    bySession.set(assignment.sessionId, list);
  }

  const invigilatorMap = new Map(store.invigilators.map((item) => [item.id, item]));
  const assignedMinutesByInvigilator = getAssignedMinutesByInvigilator(store);

  const sessions = store.sessions.map((session) => {
    const assignments = bySession.get(session.id) || [];
    const taAssignments = assignments
      .filter((item) => item.role === 'TA')
      .map((item) => ({ ...item, invigilator: invigilatorMap.get(item.invigilatorId) }));
    const doctorAssignments = assignments
      .filter((item) => item.role === 'Doctor')
      .map((item) => ({ ...item, invigilator: invigilatorMap.get(item.invigilatorId) }));

    const eligibleTAs = store.invigilators
      .filter((item) => item.role === 'TA')
      .map((item) => {
        const eligibility = getEligibilityForSession(store, session, item, assignedMinutesByInvigilator);
        return {
          ...item,
          ...eligibility
        };
      })
      .filter((item) => item.eligible)
      .sort((a, b) => (a.projectedMinutes || 0) - (b.projectedMinutes || 0) || String(a.name || '').localeCompare(String(b.name || '')));

    const eligibleDoctors = store.invigilators
      .filter((item) => item.role === 'Doctor')
      .map((item) => {
        const eligibility = getEligibilityForSession(store, session, item, assignedMinutesByInvigilator);
        return {
          ...item,
          ...eligibility
        };
      })
      .filter((item) => item.eligible)
      .sort((a, b) => (a.projectedMinutes || 0) - (b.projectedMinutes || 0) || String(a.name || '').localeCompare(String(b.name || '')));

    return {
      ...session,
      durationMinutes: getDurationMinutes(session.startTime, session.endTime),
      taAssignments,
      doctorAssignments,
      eligibleTAs,
      eligibleDoctors,
      taRemaining: Math.max(0, Number(session.taNeeded || 0) - taAssignments.length),
      doctorRemaining: Math.max(0, Number(session.doctorNeeded || 0) - doctorAssignments.length)
    };
  });

  return {
    sessions,
    taInvigilators: store.invigilators.filter((item) => item.role === 'TA'),
    doctorInvigilators: store.invigilators.filter((item) => item.role === 'Doctor')
  };
}

function buildDutyCollections(store) {
  const invigilatorMap = new Map(store.invigilators.map((item) => [item.id, item]));
  const sessionMap = new Map(store.sessions.map((item) => [item.id, item]));
  const controlSessionMap = new Map(store.controlSessions.map((item) => [item.id, item]));
  const dayWindows = getDayWindows(store.sessions);
  const dayWindowMap = new Map(dayWindows.map((item) => [item.date, item]));

  const sessionDuties = store.assignments.map((item) => {
    const session = sessionMap.get(item.sessionId);
    return {
      ...item,
      dutyType: 'Session',
      date: session?.date || '',
      startTime: session?.startTime || '',
      endTime: session?.endTime || '',
      durationMinutes: session ? getDurationMinutes(session.startTime, session.endTime) : 0,
      invigilator: invigilatorMap.get(item.invigilatorId),
      label: session ? `${getCourseLabel(session, session.room || 'Session')} (${session.room || 'No room'})` : 'Session'
    };
  });

  const superDuties = store.superAssignments.map((item) => {
    const window = dayWindowMap.get(item.date);
    return {
      ...item,
      dutyType: 'Super',
      date: item.date,
      startTime: window?.startTime || '',
      endTime: window?.endTime || '',
      durationMinutes: window?.durationMinutes || 0,
      invigilator: invigilatorMap.get(item.invigilatorId),
      label: 'Super Invigilator'
    };
  });

  const controlDuties = store.controlAssignments.map((item) => {
    const session = controlSessionMap.get(item.controlSessionId);
    const window = session ? null : dayWindowMap.get(item.date);
    return {
      ...item,
      dutyType: 'Control',
      date: session?.date || item.date,
      startTime: session?.startTime || window?.startTime || '',
      endTime: session?.endTime || window?.endTime || '',
      durationMinutes: session ? getDurationMinutes(session.startTime, session.endTime) : (window?.durationMinutes || 0),
      invigilator: invigilatorMap.get(item.invigilatorId),
      label: session ? `${getCourseLabel(session, 'Control')} (${session.room || 'Control'})` : 'Control Session'
    };
  });

  return { dayWindows, sessionDuties, superDuties, controlDuties };
}

function buildWorkloadView(store) {
  const { sessionDuties, superDuties, controlDuties } = buildDutyCollections(store);
  const allDuties = [...sessionDuties, ...superDuties, ...controlDuties];

  const rows = store.invigilators.map((person) => {
    const duties = allDuties.filter((item) => item.invigilatorId === person.id);
    const sessionMinutes = duties
      .filter((item) => item.dutyType === 'Session')
      .reduce((sum, item) => sum + item.durationMinutes, 0);
    const superMinutes = duties
      .filter((item) => item.dutyType === 'Super')
      .reduce((sum, item) => sum + item.durationMinutes, 0);
    const controlMinutes = duties
      .filter((item) => item.dutyType === 'Control')
      .reduce((sum, item) => sum + item.durationMinutes, 0);

    return {
      ...person,
      sessionCount: duties.filter((item) => item.dutyType === 'Session').length,
      superCount: duties.filter((item) => item.dutyType === 'Super').length,
      controlCount: duties.filter((item) => item.dutyType === 'Control').length,
      sessionMinutes,
      superMinutes,
      controlMinutes,
      totalMinutes: sessionMinutes + superMinutes + controlMinutes
    };
  });

  return rows.sort((a, b) => b.totalMinutes - a.totalMinutes || a.name.localeCompare(b.name));
}

module.exports = {
  readStore,
  writeStore,
  generateId,
  getDayWindows,
  parseTimeToMinutes,
  getDurationMinutes,
  rangesOverlap,
  getEligibilityForSession,
  buildSchedulingView,
  buildDutyCollections,
  buildWorkloadView
};
