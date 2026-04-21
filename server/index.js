const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const {
  readStore,
  writeStore,
  generateId,
  getDayWindows,
  getDurationMinutes,
  getEligibilityForSession,
  buildSchedulingView,
  buildDutyCollections,
  buildWorkloadView
} = require('./store');
const {
  buildReportsSummary,
  buildWorkloadReport,
  buildFairnessReport,
  buildDailyCoverageReport,
  buildConflictReport,
  buildStaffReport,
  buildSessionCoverageReport,
  buildUtilizationReport,
  buildQualityScoreReport,
} = require('./reports');

const app = express();
const PORT = process.env.PORT || 3001;
const tempDir = path.join(__dirname, 'temp');

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/temp', express.static(tempDir));

function respondError(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

function normalizeDate(value, dayName = '') {
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    }
  }

  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parts = raw.split(/[./-]/).map((item) => item.trim()).filter(Boolean);
  const currentYear = new Date().getFullYear();
  if (parts.length === 2) {
    const [day, month] = parts;
    return `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
    }
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    const year = Number(parts[2]);
    if (raw.includes('/')) {
      const expectedDay = String(dayName).trim().toLowerCase().slice(0, 3);
      if (first <= 12 && second <= 12 && expectedDay) {
        const dmy = new Date(year, second - 1, first);
        const mdy = new Date(year, first - 1, second);
        const dmyDay = dmy.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
        const mdyDay = mdy.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
        if (dmyDay === expectedDay && mdyDay !== expectedDay) {
          return `${year}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`;
        }
      }
      if (first <= 12) {
        return `${year}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`;
      }
    }
    return `${parts[2]}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
  }
  return raw;
}

function normalizeTime(value) {
  if (typeof value === 'number' && value > 0 && value < 1) {
    const totalMinutes = Math.round(value * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.includes(':')) {
    const [hours, minutes] = raw.split(':');
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) {
    return raw;
  }
  const hours = Math.floor(numeric / 100);
  const minutes = numeric % 100;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeCourseNames(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatCourseNames(value, fallback = '') {
  const courses = normalizeCourseNames(value);
  return courses.length ? courses.join('; ') : String(fallback || '').trim();
}

function readCourseInput(source, fallback = '') {
  return source?.CourseCodes
    ?? source?.courseCodes
    ?? source?.CourseCode
    ?? source?.courseCode
    ?? source?.Courses
    ?? source?.courses
    ?? source?.CourseNames
    ?? source?.courseNames
    ?? source?.CourseName
    ?? source?.courseName
    ?? fallback;
}

function readRoomInput(source, fallback = '') {
  return source?.RoomPlacement
    ?? source?.roomPlacement
    ?? source?.Room
    ?? source?.room
    ?? fallback;
}

function readNotesInput(source, fallback = '') {
  return source?.Notes
    ?? source?.notes
    ?? source?.OverRide
    ?? source?.override
    ?? source?.Override
    ?? fallback;
}

function buildSessionMatchKey({ date, startTime, endTime, room, courseNames, courseName }) {
  const courses = normalizeCourseNames(courseNames?.length ? courseNames : courseName)
    .map((item) => item.toLowerCase())
    .join(';');
  return [
    String(date || '').trim(),
    String(startTime || '').trim(),
    String(endTime || '').trim(),
    String(room || '').trim().toLowerCase(),
    courses
  ].join('|');
}

function buildSessionTimeRoomKey({ date, startTime, endTime, room }) {
  return [
    String(date || '').trim(),
    String(startTime || '').trim(),
    String(endTime || '').trim(),
    String(room || '').trim().toLowerCase()
  ].join('|');
}

function makeSessionFromImportRow(row, id) {
  return {
    id,
    courseNames: normalizeCourseNames(readCourseInput(row)),
    courseName: formatCourseNames(readCourseInput(row)),
    room: String(readRoomInput(row)).trim(),
    date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
    startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
    endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
    notes: String(readNotesInput(row)).trim()
  };
}

function mergeSessionRowsByRoomTime(rows, existingSessions = []) {
  const existingByTimeRoom = new Map();
  existingSessions.forEach((session) => {
    const key = buildSessionTimeRoomKey(session);
    if (!existingByTimeRoom.has(key)) {
      existingByTimeRoom.set(key, session);
    }
  });

  const grouped = new Map();
  rows.forEach((row) => {
    const candidate = makeSessionFromImportRow(row, '');
    const key = buildSessionTimeRoomKey(candidate);
    if (!key.replace(/\|/g, '').trim()) return;

    if (!grouped.has(key)) {
      const existing = existingByTimeRoom.get(key);
      grouped.set(key, {
        ...candidate,
        id: existing?.id || generateId(`ses${grouped.size}`),
        courseNames: [],
        courseName: '',
        taNeeded: Number(existing?.taNeeded || 0),
        doctorNeeded: Number(existing?.doctorNeeded || 0),
        totalNeeded: Number(existing?.totalNeeded || ((existing?.taNeeded || 0) + (existing?.doctorNeeded || 0)))
      });
    }

    const session = grouped.get(key);
    const knownCourses = new Set(session.courseNames.map((item) => item.toLowerCase()));
    candidate.courseNames.forEach((course) => {
      const normalized = course.toLowerCase();
      if (!knownCourses.has(normalized)) {
        session.courseNames.push(course);
        knownCourses.add(normalized);
      }
    });
    session.courseName = formatCourseNames(session.courseNames);
    if (!session.notes && candidate.notes) {
      session.notes = candidate.notes;
    }
  });

  return Array.from(grouped.values());
}

function makeSessionIdentityRows(sessions) {
  return sessions.map((session) => {
    const courseCodes = formatCourseNames(session.courseNames?.length ? session.courseNames : session.courseName);
    return {
      Room: session.room || '',
      CourseCode: courseCodes,
      Date: session.date || '',
      Start: session.startTime || '',
      End: session.endTime || ''
    };
  });
}

function makeSessionNeedRows(sessions) {
  return sessions.map((session) => {
    return {
      SessionID: session.id,
      Room: session.room || '',
      Date: session.date || '',
      Start: session.startTime || '',
      End: session.endTime || '',
      TANeeded: Number(session.taNeeded || 0),
      DoctorNeeded: Number(session.doctorNeeded || 0),
      InvigilatorsNeeded: Number(session.totalNeeded || ((session.taNeeded || 0) + (session.doctorNeeded || 0)))
    };
  });
}

function getAssignedMinutesByInvigilator(store) {
  const totals = new Map();

  store.assignments.forEach((assignment) => {
    const session = store.sessions.find((item) => item.id === assignment.sessionId);
    if (!session) return;
    totals.set(
      assignment.invigilatorId,
      (totals.get(assignment.invigilatorId) || 0) + getDurationMinutes(session.startTime, session.endTime)
    );
  });

  const dayWindows = getDayWindows(store.sessions);
  const windowMap = new Map(dayWindows.map((item) => [item.date, item]));
  const controlSessionMap = new Map(store.controlSessions.map((item) => [item.id, item]));

  store.superAssignments.forEach((assignment) => {
    const window = windowMap.get(assignment.date);
    if (!window) return;
    totals.set(
      assignment.invigilatorId,
      (totals.get(assignment.invigilatorId) || 0) + Number(window.durationMinutes || 0)
    );
  });

  store.controlAssignments.forEach((assignment) => {
    const controlSession = controlSessionMap.get(assignment.controlSessionId);
    const durationMinutes = controlSession
      ? getDurationMinutes(controlSession.startTime, controlSession.endTime)
      : Number(windowMap.get(assignment.date)?.durationMinutes || 0);
    totals.set(
      assignment.invigilatorId,
      (totals.get(assignment.invigilatorId) || 0) + durationMinutes
    );
  });

  return totals;
}

function makeWorkbookFile(sheets, prefix) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sheet.rows), sheet.name);
  }
  const fileName = `${Date.now()}_${prefix}.xlsx`;
  const fullPath = path.join(tempDir, fileName);
  XLSX.writeFile(workbook, fullPath);
  return { fileName, url: `/temp/${fileName}` };
}

app.get('/api/dashboard', (_req, res) => {
  const store = readStore();
  const dayWindows = getDayWindows(store.sessions);
  const scheduling = buildSchedulingView(store);

  res.json({
    totals: {
      sessions: store.sessions.length,
      invigilators: store.invigilators.length,
      doctors: store.invigilators.filter((item) => item.role === 'Doctor').length,
      tas: store.invigilators.filter((item) => item.role === 'TA').length,
      assignedSessionDuties: store.assignments.length,
      superAssignments: store.superAssignments.length,
      controlAssignments: store.controlAssignments.length,
      engagements: store.engagements.length
    },
    openNeeds: scheduling.sessions.reduce((acc, item) => ({
      ta: acc.ta + item.taRemaining,
      doctor: acc.doctor + item.doctorRemaining
    }), { ta: 0, doctor: 0 }),
    dayWindows
  });
});

app.get('/api/sessions', (_req, res) => {
  res.json(readStore().sessions);
});

app.post('/api/sessions', (req, res) => {
  const store = readStore();
  const payload = req.body || {};
  if (!payload.date || !payload.startTime || !payload.endTime) {
    return respondError(res, 'Date, start time, and end time are required.');
  }

  const session = {
    id: generateId('ses'),
    courseNames: normalizeCourseNames(readCourseInput(payload)),
    courseName: formatCourseNames(readCourseInput(payload)),
    room: String(readRoomInput(payload)).trim(),
    date: normalizeDate(payload.date),
    startTime: normalizeTime(payload.startTime),
    endTime: normalizeTime(payload.endTime),
    taNeeded: Number(payload.taNeeded || 0),
    doctorNeeded: Number(payload.doctorNeeded || 0),
    totalNeeded: Number(payload.totalNeeded || (Number(payload.taNeeded || 0) + Number(payload.doctorNeeded || 0))),
    notes: String(readNotesInput(payload)).trim()
  };
  store.sessions.push(session);
  writeStore(store);
  res.status(201).json(session);
});

app.put('/api/sessions/:id', (req, res) => {
  const store = readStore();
  const session = store.sessions.find((item) => item.id === req.params.id);
  if (!session) {
    return respondError(res, 'Session not found.', 404);
  }

  Object.assign(session, {
    courseNames: normalizeCourseNames(readCourseInput(req.body)),
    courseName: formatCourseNames(readCourseInput(req.body)),
    room: String(readRoomInput(req.body)).trim(),
    date: normalizeDate(req.body.date || session.date),
    startTime: normalizeTime(req.body.startTime || session.startTime),
    endTime: normalizeTime(req.body.endTime || session.endTime),
    taNeeded: Number(req.body.taNeeded || 0),
    doctorNeeded: Number(req.body.doctorNeeded || 0),
    totalNeeded: Number(req.body.totalNeeded || (Number(req.body.taNeeded || 0) + Number(req.body.doctorNeeded || 0))),
    notes: String(readNotesInput(req.body)).trim()
  });

  writeStore(store);
  res.json(session);
});

app.delete('/api/sessions/:id', (req, res) => {
  const store = readStore();
  store.sessions = store.sessions.filter((item) => item.id !== req.params.id);
  store.assignments = store.assignments.filter((item) => item.sessionId !== req.params.id);
  writeStore(store);
  res.json({ success: true });
});

app.delete('/api/sessions', (_req, res) => {
  const store = readStore();
  store.sessions = [];
  store.assignments = [];
  store.superAssignments = [];
  writeStore(store);
  res.json({ success: true });
});

app.get('/api/invigilators', (_req, res) => {
  res.json(readStore().invigilators);
});

app.post('/api/invigilators', (req, res) => {
  const store = readStore();
  const payload = req.body || {};
  if (!payload.name || !payload.role) {
    return respondError(res, 'Name and role are required.');
  }
  if (!['TA', 'Doctor'].includes(payload.role)) {
    return respondError(res, 'Role must be TA or Doctor.');
  }

  const person = {
    id: generateId('inv'),
    staffId: String(payload.staffId || payload.name || generateId('staff')).trim(),
    name: String(payload.name).trim(),
    email: String(payload.email || '').trim(),
    role: payload.role,
    loadType: String(payload.loadType || 'full').trim() || 'full',
    department: String(payload.department || '').trim(),
    maxHours: Number(payload.maxHours || 0),
    notes: String(payload.notes || '').trim()
  };

  store.invigilators.push(person);
  writeStore(store);
  res.status(201).json(person);
});

app.put('/api/invigilators/:id', (req, res) => {
  const store = readStore();
  const person = store.invigilators.find((item) => item.id === req.params.id);
  if (!person) {
    return respondError(res, 'Invigilator not found.', 404);
  }
  if (!['TA', 'Doctor'].includes(req.body.role)) {
    return respondError(res, 'Role must be TA or Doctor.');
  }

  Object.assign(person, {
    staffId: String(req.body.staffId || person.staffId || person.id).trim(),
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim(),
    role: req.body.role,
    loadType: String(req.body.loadType || person.loadType || 'full').trim() || 'full',
    department: String(req.body.department || '').trim(),
    maxHours: Number(req.body.maxHours || 0),
    notes: String(req.body.notes || '').trim()
  });

  writeStore(store);
  res.json(person);
});

app.delete('/api/invigilators/:id', (req, res) => {
  const store = readStore();
  const person = store.invigilators.find((item) => item.id === req.params.id);
  store.invigilators = store.invigilators.filter((item) => item.id !== req.params.id);
  store.assignments = store.assignments.filter((item) => item.invigilatorId !== req.params.id);
  store.superAssignments = store.superAssignments.filter((item) => item.invigilatorId !== req.params.id);
  store.controlAssignments = store.controlAssignments.filter((item) => item.invigilatorId !== req.params.id);
  if (person) {
    store.engagements = store.engagements.filter((item) => item.staffId !== person.staffId);
  }
  writeStore(store);
  res.json({ success: true });
});

app.delete('/api/invigilators', (_req, res) => {
  const store = readStore();
  store.invigilators = [];
  store.assignments = [];
  store.superAssignments = [];
  store.controlAssignments = [];
  store.engagements = [];
  writeStore(store);
  res.json({ success: true });
});

app.get('/api/engagements', (_req, res) => {
  const store = readStore();
  res.json(store.engagements);
});

app.post('/api/engagements', (req, res) => {
  const store = readStore();
  const payload = req.body || {};
  const engagement = {
    id: generateId('eng'),
    staffId: String(payload.staffId || '').trim(),
    date: normalizeDate(payload.date),
    startTime: normalizeTime(payload.startTime),
    endTime: normalizeTime(payload.endTime),
    engagement: Number(payload.engagement ?? 1),
    notes: String(payload.notes || '').trim()
  };
  store.engagements.push(engagement);
  writeStore(store);
  res.status(201).json(engagement);
});

app.put('/api/engagements/:id', (req, res) => {
  const store = readStore();
  const row = store.engagements.find((item) => item.id === req.params.id);
  if (!row) {
    return respondError(res, 'Engagement not found.', 404);
  }
  Object.assign(row, {
    staffId: String(req.body.staffId || row.staffId).trim(),
    date: normalizeDate(req.body.date || row.date),
    startTime: normalizeTime(req.body.startTime || row.startTime),
    endTime: normalizeTime(req.body.endTime || row.endTime),
    engagement: Number(req.body.engagement ?? row.engagement ?? 1),
    notes: String(req.body.notes || '').trim()
  });
  writeStore(store);
  res.json(row);
});

app.delete('/api/engagements/:id', (req, res) => {
  const store = readStore();
  store.engagements = store.engagements.filter((item) => item.id !== req.params.id);
  writeStore(store);
  res.json({ success: true });
});

app.delete('/api/engagements', (_req, res) => {
  const store = readStore();
  store.engagements = [];
  writeStore(store);
  res.json({ success: true });
});

app.get('/api/scheduling', (_req, res) => {
  res.json(buildSchedulingView(readStore()));
});

app.post('/api/scheduling/assign', (req, res) => {
  const store = readStore();
  const { sessionId, invigilatorId } = req.body || {};
  const session = store.sessions.find((item) => item.id === sessionId);
  const person = store.invigilators.find((item) => item.id === invigilatorId);
  if (!session || !person) {
    return respondError(res, 'Session or invigilator not found.', 404);
  }

  const duplicate = store.assignments.find(
    (item) => item.sessionId === sessionId && item.invigilatorId === invigilatorId
  );
  if (duplicate) {
    return respondError(res, 'This invigilator is already assigned to the session.');
  }

  const roleAssignments = store.assignments.filter(
    (item) => item.sessionId === sessionId && item.role === person.role
  );
  const needed = person.role === 'TA' ? Number(session.taNeeded || 0) : Number(session.doctorNeeded || 0);
  if (roleAssignments.length >= needed) {
    return respondError(res, `This session already has all required ${person.role} assignments.`);
  }

  const eligibility = getEligibilityForSession(store, session, person, getAssignedMinutesByInvigilator(store));
  if (!eligibility.eligible) {
    if (eligibility.reason === 'engagement') {
      return respondError(res, 'This invigilator has an engagement during that period.');
    }
    if (eligibility.reason === 'overlap') {
      return respondError(res, 'This invigilator is already assigned to an overlapping session.');
    }
    if (eligibility.reason === 'max_hours') {
      return respondError(res, 'This invigilator would exceed their max hours.');
    }
    if (eligibility.reason === 'already_assigned') {
      return respondError(res, 'This invigilator is already assigned to the session.');
    }
    return respondError(res, 'This invigilator cannot be assigned to the session.');
  }

  const assignment = {
    id: generateId('asg'),
    sessionId,
    invigilatorId,
    role: person.role
  };
  store.assignments.push(assignment);
  writeStore(store);
  res.status(201).json(assignment);
});

app.delete('/api/scheduling/assign/:id', (req, res) => {
  const store = readStore();
  store.assignments = store.assignments.filter((item) => item.id !== req.params.id);
  writeStore(store);
  res.json({ success: true });
});

app.delete('/api/scheduling/assign', (_req, res) => {
  const store = readStore();
  store.assignments = [];
  writeStore(store);
  res.json({ success: true });
});

app.get('/api/super-invigilators', (_req, res) => {
  const store = readStore();
  const { dayWindows } = buildDutyCollections(store);
  const doctorMap = new Map(
    store.invigilators.filter((item) => item.role === 'Doctor').map((item) => [item.id, item])
  );

  res.json({
    dayWindows,
    doctors: Array.from(doctorMap.values()),
    assignments: store.superAssignments.map((item) => ({
      ...item,
      invigilator: doctorMap.get(item.invigilatorId),
      window: dayWindows.find((window) => window.date === item.date) || null
    }))
  });
});

app.post('/api/super-invigilators/assign', (req, res) => {
  const store = readStore();
  const { date, invigilatorId } = req.body || {};
  const person = store.invigilators.find((item) => item.id === invigilatorId);
  if (!date || !person) {
    return respondError(res, 'Date and doctor are required.');
  }
  if (person.role !== 'Doctor') {
    return respondError(res, 'Super invigilators must be doctors only.');
  }

  const duplicate = store.superAssignments.find(
    (item) => item.date === date && item.invigilatorId === invigilatorId
  );
  if (duplicate) {
    return respondError(res, 'This doctor is already assigned as super invigilator for that day.');
  }

  const assignment = { id: generateId('sup'), date, invigilatorId };
  store.superAssignments.push(assignment);
  writeStore(store);
  res.status(201).json(assignment);
});

app.delete('/api/super-invigilators/:id', (req, res) => {
  const store = readStore();
  store.superAssignments = store.superAssignments.filter((item) => item.id !== req.params.id);
  writeStore(store);
  res.json({ success: true });
});

app.delete('/api/super-invigilators', (_req, res) => {
  const store = readStore();
  store.superAssignments = [];
  writeStore(store);
  res.json({ success: true });
});

app.get('/api/control-sessions', (_req, res) => {
  const store = readStore();
  const invigilatorMap = new Map(store.invigilators.map((item) => [item.id, item]));
  const assignmentsByControlSession = new Map();

  for (const assignment of store.controlAssignments) {
    const rows = assignmentsByControlSession.get(assignment.controlSessionId) || [];
    rows.push(assignment);
    assignmentsByControlSession.set(assignment.controlSessionId, rows);
  }

  res.json({
    sessions: store.controlSessions.map((session) => {
      const assignments = assignmentsByControlSession.get(session.id) || [];
      const taAssignments = assignments
        .filter((item) => item.role === 'TA')
        .map((item) => ({ ...item, invigilator: invigilatorMap.get(item.invigilatorId) }));
      const doctorAssignments = assignments
        .filter((item) => item.role === 'Doctor')
        .map((item) => ({ ...item, invigilator: invigilatorMap.get(item.invigilatorId) }));

      return {
        ...session,
        taAssignments,
        doctorAssignments,
        taRemaining: Math.max(0, Number(session.taNeeded || 0) - taAssignments.length),
        doctorRemaining: Math.max(0, Number(session.doctorNeeded || 0) - doctorAssignments.length)
      };
    }),
    invigilators: store.invigilators,
    assignments: store.controlAssignments.map((item) => ({
      ...item,
      invigilator: invigilatorMap.get(item.invigilatorId),
      controlSession: store.controlSessions.find((session) => session.id === item.controlSessionId) || null
    }))
  });
});

app.post('/api/control-sessions', (req, res) => {
  const store = readStore();
  const payload = req.body || {};
  if (!payload.date || !payload.startTime || !payload.endTime) {
    return respondError(res, 'Date, start time, and end time are required.');
  }

  const session = {
    id: generateId('ctlses'),
    courseNames: normalizeCourseNames(readCourseInput(payload, 'Control Session')),
    courseName: formatCourseNames(readCourseInput(payload), 'Control Session'),
    room: String(payload.room || 'Control').trim(),
    date: normalizeDate(payload.date),
    startTime: normalizeTime(payload.startTime),
    endTime: normalizeTime(payload.endTime),
    taNeeded: Number(payload.taNeeded || 0),
    doctorNeeded: Number(payload.doctorNeeded || 0),
    totalNeeded: Number(payload.totalNeeded || (Number(payload.taNeeded || 0) + Number(payload.doctorNeeded || 0))),
    notes: String(payload.notes || '').trim()
  };

  store.controlSessions.push(session);
  writeStore(store);
  res.status(201).json(session);
});

app.put('/api/control-sessions/:id', (req, res) => {
  const store = readStore();
  const session = store.controlSessions.find((item) => item.id === req.params.id);
  if (!session) {
    return respondError(res, 'Control session not found.', 404);
  }

  Object.assign(session, {
    courseNames: normalizeCourseNames(readCourseInput(req.body)),
    courseName: formatCourseNames(readCourseInput(req.body)),
    room: String(req.body.room || '').trim(),
    date: normalizeDate(req.body.date || session.date),
    startTime: normalizeTime(req.body.startTime || session.startTime),
    endTime: normalizeTime(req.body.endTime || session.endTime),
    taNeeded: Number(req.body.taNeeded || 0),
    doctorNeeded: Number(req.body.doctorNeeded || 0),
    totalNeeded: Number(req.body.totalNeeded || (Number(req.body.taNeeded || 0) + Number(req.body.doctorNeeded || 0))),
    notes: String(req.body.notes || '').trim()
  });

  writeStore(store);
  res.json(session);
});

app.post('/api/control-sessions/assign', (req, res) => {
  const store = readStore();
  const { controlSessionId, invigilatorId } = req.body || {};
  const controlSession = store.controlSessions.find((item) => item.id === controlSessionId);
  const person = store.invigilators.find((item) => item.id === invigilatorId);
  if (!controlSession || !person) {
    return respondError(res, 'Control session and invigilator are required.');
  }

  const duplicate = store.controlAssignments.find(
    (item) => item.controlSessionId === controlSessionId && item.invigilatorId === invigilatorId
  );
  if (duplicate) {
    return respondError(res, 'This invigilator is already assigned to the control session.');
  }

  const roleAssignments = store.controlAssignments.filter(
    (item) => item.controlSessionId === controlSessionId && item.role === person.role
  );
  const needed = person.role === 'TA' ? Number(controlSession.taNeeded || 0) : Number(controlSession.doctorNeeded || 0);
  if (roleAssignments.length >= needed) {
    return respondError(res, `This control session already has all required ${person.role} assignments.`);
  }

  const regularizedSession = {
    ...controlSession,
    startTime: controlSession.startTime,
    endTime: controlSession.endTime,
    date: controlSession.date
  };
  const eligibility = getEligibilityForSession(store, regularizedSession, person, getAssignedMinutesByInvigilator(store));
  if (!eligibility.eligible && eligibility.reason !== 'already_assigned') {
    if (eligibility.reason === 'engagement') {
      return respondError(res, 'This invigilator has an engagement during that period.');
    }
    if (eligibility.reason === 'overlap') {
      return respondError(res, 'This invigilator is already assigned to an overlapping session.');
    }
    if (eligibility.reason === 'max_hours') {
      return respondError(res, 'This invigilator would exceed their max hours.');
    }
  }

  const assignment = { id: generateId('ctlasg'), controlSessionId, invigilatorId, role: person.role };
  store.controlAssignments.push(assignment);
  writeStore(store);
  res.status(201).json(assignment);
});

app.delete('/api/control-sessions/assign/:id', (req, res) => {
  const store = readStore();
  store.controlAssignments = store.controlAssignments.filter((item) => item.id !== req.params.id);
  writeStore(store);
  res.json({ success: true });
});

app.delete('/api/control-sessions', (_req, res) => {
  const store = readStore();
  store.controlSessions = [];
  store.controlAssignments = [];
  writeStore(store);
  res.json({ success: true });
});

app.delete('/api/control-sessions/:id', (req, res) => {
  const store = readStore();
  store.controlSessions = store.controlSessions.filter((item) => item.id !== req.params.id);
  store.controlAssignments = store.controlAssignments.filter((item) => item.controlSessionId !== req.params.id);
  writeStore(store);
  res.json({ success: true });
});

app.get('/api/workload', (_req, res) => {
  const store = readStore();
  res.json({
    rows: buildWorkloadView(store),
    dayWindows: getDayWindows(store.sessions)
  });
});

app.post('/api/scheduling/auto-schedule', (req, res) => {
  const store = readStore();
  const payload = {
    sessions: store.sessions.map((item) => ({
      id: item.id,
      exam_date: item.date,
      start_time: item.startTime,
      end_time: item.endTime,
      ta_needed: Number(item.taNeeded || 0),
      doctor_needed: Number(item.doctorNeeded || 0)
    })),
    invigilators: store.invigilators.map((item) => ({
      staff_id: String(item.staffId || item.id),
      role: item.role,
      load_type: item.loadType || 'full',
      max_hours: Number(item.maxHours || 0)
    })),
    engagements: store.engagements.map((item) => ({
      staff_id: String(item.staffId || ''),
      exam_date: item.date,
      start_time: item.startTime,
      end_time: item.endTime,
      engagement: Number(item.engagement ?? 1)
    })),
    options: {
      time_limit_seconds: 20,
      coverage_weight: 1000000,
      max_load_weight: 1000,
      spread_weight: 100,
      imbalance_weight: 1,
      daily_penalty_weight: 5,
      max_sessions_per_day_soft: 2
    }
  };

  const scriptPath = path.join(__dirname, 'scripts', 'auto_schedule.py');
  const child = spawn('python', [scriptPath], { cwd: path.join(__dirname, '..') });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    res.status(500).json({ error: error.message });
  });
  child.on('close', (code) => {
    if (code !== 0) {
      res.status(500).json({ error: stderr || `Auto-scheduler failed with code ${code}` });
      return;
    }
    try {
      const result = JSON.parse(stdout);
      if (result.error) {
        res.status(400).json({ error: result.error, details: result.details || [], status: result.status || 'ERROR' });
        return;
      }
      const staffIdToInvigilatorId = new Map(store.invigilators.map((item) => [String(item.staffId || item.id), item.id]));
      store.assignments = (result.assignments || []).map((item, index) => ({
        id: generateId(`asg${index}`),
        sessionId: item.session_id,
        invigilatorId: staffIdToInvigilatorId.get(String(item.staff_id)),
        role: item.role
      })).filter((item) => item.invigilatorId);
      writeStore(store);
      res.json({
        ...result,
        assignments: store.assignments
      });
    } catch (error) {
      res.status(500).json({ error: stderr || error.message });
    }
  });

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
});

app.post('/api/room-capability/optimize', (req, res) => {
  const payload = req.body || {};
  const scriptPath = path.join(__dirname, 'scripts', 'room_capability.py');
  const child = spawn('python', [scriptPath], { cwd: path.join(__dirname, '..') });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    res.status(500).json({ error: error.message });
  });
  child.on('close', (code) => {
    if (code !== 0) {
      res.status(500).json({ error: stderr || `Room capability optimizer failed with code ${code}` });
      return;
    }
    try {
      const result = JSON.parse(stdout);
      if (result.status === 'ERROR') {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: stderr || error.message });
    }
  });

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
});

app.post('/api/import/sessions', (req, res) => {
  const store = readStore();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  store.sessions = mergeSessionRowsByRoomTime(rows, store.sessions);
  store.assignments = [];
  store.superAssignments = [];
  writeStore(store);
  res.json({ success: true, count: store.sessions.length });
});

app.post('/api/import/session-needs', (req, res) => {
  const store = readStore();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const byId = new Map(store.sessions.map((session) => [String(session.id), session]));
  const byKey = new Map(store.sessions.map((session) => [buildSessionMatchKey(session), session]));
  const byTimeRoom = new Map();

  store.sessions.forEach((session) => {
    const key = buildSessionTimeRoomKey(session);
    if (!byTimeRoom.has(key)) {
      byTimeRoom.set(key, session);
    }
  });

  const unmatched = [];
  let updated = 0;

  rows.forEach((row, index) => {
    const courseNames = normalizeCourseNames(readCourseInput(row));
    const importedSession = {
      date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
      startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
      endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
      room: String(readRoomInput(row)).trim(),
      courseNames,
      courseName: formatCourseNames(courseNames)
    };
    const sessionId = String(row.SessionID ?? row.sessionId ?? row.id ?? '').trim();
    const session = byId.get(sessionId)
      || byTimeRoom.get(buildSessionTimeRoomKey(importedSession))
      || byKey.get(buildSessionMatchKey(importedSession));

    if (!session) {
      unmatched.push({ row: index + 2, room: importedSession.room, date: importedSession.date, start: importedSession.startTime, end: importedSession.endTime });
      return;
    }

    const taNeeded = Number(row.TANeeded ?? row.taNeeded ?? row.ta_needed ?? row.InvigilatorsNeeded ?? session.taNeeded ?? 0);
    const doctorNeeded = Number(row.DoctorNeeded ?? row.doctorNeeded ?? row.doctor_needed ?? session.doctorNeeded ?? 0);
    session.taNeeded = Number.isFinite(taNeeded) ? taNeeded : 0;
    session.doctorNeeded = Number.isFinite(doctorNeeded) ? doctorNeeded : 0;
    session.totalNeeded = Number(row.InvigilatorsNeeded ?? row.totalNeeded ?? row.total_needed ?? (session.taNeeded + session.doctorNeeded));
    updated += 1;
  });

  writeStore(store);
  res.json({ success: true, updated, unmatched });
});

app.post('/api/import/control-sessions', (req, res) => {
  const store = readStore();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  store.controlSessions = rows.map((row, index) => ({
    id: generateId(`ctlses${index}`),
    courseNames: normalizeCourseNames(readCourseInput(row, 'Control Session')),
    courseName: formatCourseNames(readCourseInput(row), 'Control Session'),
    room: String(row.Room ?? row.room ?? 'Control').trim(),
    date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
    startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
    endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
    taNeeded: Number(row.TANeeded ?? row.taNeeded ?? 0),
    doctorNeeded: Number(row.DoctorNeeded ?? row.doctorNeeded ?? 0),
    totalNeeded: Number(row.InvigilatorsNeeded ?? row.totalNeeded ?? 0),
    notes: String(row.Notes ?? row.notes ?? '').trim()
  }));
  store.controlAssignments = [];
  writeStore(store);
  res.json({ success: true, count: store.controlSessions.length });
});

app.post('/api/import/invigilators', (req, res) => {
  const store = readStore();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  store.invigilators = rows.map((row, index) => ({
    id: generateId(`inv${index}`),
    staffId: String(row.StaffID ?? row.staffId ?? row.staff_id ?? index + 1).trim(),
    name: String(row.Name ?? row.name ?? '').trim(),
    email: String(row.Email ?? row.email ?? '').trim(),
    role: String(row.Role ?? row.role ?? 'TA').trim() || 'TA',
    loadType: String(row.LoadType ?? row.loadType ?? 'full').trim() || 'full',
    maxHours: Number(row.MaxHours ?? row.maxHours ?? 0),
    department: String(row.Department ?? row.department ?? '').trim(),
    notes: String(row.Notes ?? row.notes ?? '').trim()
  }));
  store.assignments = [];
  store.superAssignments = [];
  store.controlAssignments = [];
  store.engagements = [];
  writeStore(store);
  res.json({ success: true, count: store.invigilators.length });
});

app.post('/api/import/engagements', (req, res) => {
  const store = readStore();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  store.engagements = rows.map((row, index) => ({
    id: generateId(`eng${index}`),
    staffId: String(row.StaffID ?? row.staffId ?? row.staff_id ?? '').trim(),
    date: normalizeDate(row.Date ?? row.date),
    startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
    endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
    engagement: Number(row.Engagement ?? row.engagement ?? 1),
    notes: String(row.Notes ?? row.notes ?? '').trim()
  }));
  writeStore(store);
  res.json({ success: true, count: store.engagements.length });
});

app.post('/api/data/load-sample', (req, res) => {
  const sampleDir = path.join(__dirname, '..', 'sample');
  const sessionsPath = path.join(sampleDir, 'sessions.xlsx');
  const staffPath = path.join(sampleDir, 'staff.xlsx');
  const engagementPath = path.join(sampleDir, 'engagement.xlsx');

  if (!fs.existsSync(sessionsPath) || !fs.existsSync(staffPath) || !fs.existsSync(engagementPath)) {
    return respondError(res, 'Sample Excel files are missing from the sample folder.', 404);
  }

  const sessionsBook = XLSX.readFile(sessionsPath);
  const staffBook = XLSX.readFile(staffPath);
  const engagementBook = XLSX.readFile(engagementPath);
  const sessionsRows = XLSX.utils.sheet_to_json(sessionsBook.Sheets[sessionsBook.SheetNames[0]]);
  const staffRows = XLSX.utils.sheet_to_json(staffBook.Sheets[staffBook.SheetNames[0]]);
  const engagementRows = XLSX.utils.sheet_to_json(engagementBook.Sheets[engagementBook.SheetNames[0]]);

  const store = readStore();
  store.sessions = mergeSessionRowsByRoomTime(sessionsRows).map((session) => ({
    ...session,
    taNeeded: 0,
    doctorNeeded: 0,
    totalNeeded: 0
  }));
  store.invigilators = staffRows.map((row, index) => ({
    id: generateId(`inv${index}`),
    staffId: String(row.StaffID ?? index + 1).trim(),
    name: String(row.Name ?? '').trim(),
    email: String(row.Email ?? '').trim(),
    role: 'TA',
    loadType: String(row.LoadType ?? 'full').trim() || 'full',
    maxHours: Number(row.MaxHours ?? 0),
    department: '',
    notes: ''
  }));
  store.engagements = engagementRows.map((row, index) => ({
    id: generateId(`eng${index}`),
    staffId: String(row.StaffID ?? '').trim(),
    date: normalizeDate(row.Date),
    startTime: normalizeTime(row.Start),
    endTime: normalizeTime(row.End),
    engagement: Number(row.Engagement ?? 1),
    notes: ''
  }));
  store.assignments = [];
  store.superAssignments = [];
  store.controlSessions = [];
  store.controlAssignments = [];
  writeStore(store);
  res.json({ success: true });
});

app.get('/api/export/workbook', (_req, res) => {
  const store = readStore();
  const file = makeWorkbookFile([
    { name: 'Sessions', rows: makeSessionIdentityRows(store.sessions) },
    { name: 'SessionNeeds', rows: makeSessionNeedRows(store.sessions) },
    { name: 'Invigilators', rows: store.invigilators },
    { name: 'Engagements', rows: store.engagements },
    { name: 'Assignments', rows: store.assignments },
    { name: 'Super', rows: store.superAssignments },
    { name: 'ControlSessions', rows: store.controlSessions },
    { name: 'ControlAssignments', rows: store.controlAssignments }
  ], 'scheduler_export');
  res.json(file);
});

app.get('/api/day-coverage', (_req, res) => {
  const store = readStore();
  const scheduling = buildSchedulingView(store);
  const { dayWindows } = buildDutyCollections(store);

  const rows = dayWindows.map((window) => {
    const sessions = scheduling.sessions.filter((item) => item.date === window.date);
    const superCount = store.superAssignments.filter((item) => item.date === window.date).length;
    const controlCount = store.controlAssignments.filter((item) => {
      const controlSession = store.controlSessions.find((session) => session.id === item.controlSessionId);
      return controlSession?.date === window.date;
    }).length;

    return {
      ...window,
      sessionCount: sessions.length,
      taRemaining: sessions.reduce((sum, item) => sum + item.taRemaining, 0),
      doctorRemaining: sessions.reduce((sum, item) => sum + item.doctorRemaining, 0),
      superCount,
      controlCount
    };
  });

  res.json(rows);
});

app.get('/api/reports/summary', (req, res) => {
  res.json(buildReportsSummary(readStore(), req.query));
});

app.get('/api/reports/workload', (req, res) => {
  res.json(buildWorkloadReport(readStore(), req.query));
});

app.get('/api/reports/fairness', (req, res) => {
  res.json(buildFairnessReport(readStore(), req.query));
});

app.get('/api/reports/daily-coverage', (req, res) => {
  res.json(buildDailyCoverageReport(readStore(), req.query));
});

app.get('/api/reports/conflicts', (req, res) => {
  res.json(buildConflictReport(readStore(), req.query));
});

app.get('/api/reports/staff/:staffId', (req, res) => {
  const report = buildStaffReport(readStore(), req.query, req.params.staffId);
  if (!report.person) {
    return respondError(res, 'Staff member not found.', 404);
  }
  return res.json(report);
});

app.get('/api/reports/session-coverage', (req, res) => {
  res.json(buildSessionCoverageReport(readStore(), req.query));
});

app.get('/api/reports/utilization', (req, res) => {
  res.json(buildUtilizationReport(readStore(), req.query));
});

app.get('/api/reports/quality-score', (req, res) => {
  res.json(buildQualityScoreReport(readStore(), req.query));
});

app.get('/api/data/export', (_req, res) => {
  res.json(readStore());
});

app.post('/api/data/import', (req, res) => {
  const payload = req.body || {};
  const data = payload.data;

  if (!data || typeof data !== 'object') {
    return respondError(res, 'A valid scheduler data object is required.');
  }

  const normalized = {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    invigilators: Array.isArray(data.invigilators) ? data.invigilators : [],
    engagements: Array.isArray(data.engagements) ? data.engagements : [],
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
    superAssignments: Array.isArray(data.superAssignments) ? data.superAssignments : [],
    controlSessions: Array.isArray(data.controlSessions) ? data.controlSessions : [],
    controlAssignments: Array.isArray(data.controlAssignments) ? data.controlAssignments : []
  };

  writeStore(normalized);
  res.json({ success: true, counts: {
    sessions: normalized.sessions.length,
    invigilators: normalized.invigilators.length,
    engagements: normalized.engagements.length,
    assignments: normalized.assignments.length,
    superAssignments: normalized.superAssignments.length,
    controlSessions: normalized.controlSessions.length,
    controlAssignments: normalized.controlAssignments.length
  } });
});

app.delete('/api/data/reset', (_req, res) => {
  writeStore({
    sessions: [],
    invigilators: [],
    engagements: [],
    assignments: [],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: []
  });
  res.json({ success: true });
});

const clientBuild = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuild));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.sendFile(path.join(clientBuild, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`UNI scheduler web app running on http://0.0.0.0:${PORT}`);
});
