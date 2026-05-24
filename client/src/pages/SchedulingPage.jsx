import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api, downloadFile } from '../api';
import { useToast } from '../App';

const SLOT_MINUTES = 60;
const LANE_HEIGHTS = {
  compact: 118,
  comfortable: 136,
  wide: 154
};
const MIN_ROW_HEIGHTS = {
  compact: 132,
  comfortable: 150,
  wide: 168
};
const DATE_COLUMN_WIDTHS = {
  compact: 124,
  comfortable: 136,
  wide: 148
};

function parseTimeToMinutes(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return (hours * 60) + minutes;
}

function formatDateLabel(dateStr) {
  const value = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(value.getTime())) {
    return dateStr;
  }
  return value.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTimeLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function normalizeImportDate(value, dayName = '') {
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

function normalizeImportTime(value) {
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
  if (Number.isNaN(numeric)) return raw;
  const hours = Math.floor(numeric / 100);
  const minutes = numeric % 100;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function getImportCourses(row) {
  return String(row.CourseCodes ?? row.courseCodes ?? row.CourseCode ?? row.courseCode ?? row.Courses ?? row.courses ?? row.CourseNames ?? row.CourseName ?? row.courseNames ?? row.courseName ?? '')
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getImportRoom(row) {
  return String(row.RoomPlacement ?? row.roomPlacement ?? row.Room ?? row.room ?? '').trim();
}

function getImportSessionBlockCourseKey(row) {
  const courses = getImportCourses(row).map((item) => item.toLowerCase()).sort().join(';');
  return [
    normalizeImportDate(row.Date ?? row.date ?? row.exam_date ?? '', row.Day ?? row.day ?? ''),
    normalizeImportTime(row.Start ?? row.startTime ?? row.start_time ?? ''),
    getImportRoom(row).toLowerCase(),
    courses
  ].join('|');
}

function getImportSessionRoomStartKey(row) {
  return [
    normalizeImportDate(row.Date ?? row.date ?? row.exam_date ?? '', row.Day ?? row.day ?? ''),
    normalizeImportTime(row.Start ?? row.startTime ?? row.start_time ?? ''),
    getImportRoom(row).toLowerCase()
  ].join('|');
}

function getImportSessionTimeRoomKey(row) {
  return `${getImportSessionRoomStartKey(row)}|${normalizeImportTime(row.End ?? row.endTime ?? row.end_time ?? '')}`;
}

function mergeImportSessionsByRoomTime(rows) {
  const grouped = new Map();

  rows.forEach((row) => {
    const key = getImportSessionRoomStartKey(row);
    if (!key.replace(/\|/g, '').trim()) return;

    if (!grouped.has(key)) {
      const id = row.SessionID || row.sessionId || row.id || `ses_import_${grouped.size + 1}`;
      grouped.set(key, {
        id,
        courseNames: [],
        courseName: '',
        room: getImportRoom(row),
        date: normalizeImportDate(row.Date ?? row.date ?? row.exam_date ?? '', row.Day ?? row.day ?? ''),
        startTime: normalizeImportTime(row.Start ?? row.startTime ?? row.start_time ?? ''),
        endTime: normalizeImportTime(row.End ?? row.endTime ?? row.end_time ?? ''),
        taNeeded: Number(row.TANeeded ?? row.taNeeded ?? row.ta_needed ?? row.InvigilatorsNeeded ?? 0),
        doctorNeeded: Number(row.DoctorNeeded ?? row.doctorNeeded ?? row.doctor_needed ?? 0),
        totalNeeded: Number(row.InvigilatorsNeeded ?? row.totalNeeded ?? row.total_needed ?? 0),
        notes: String(row.Notes ?? row.notes ?? row.OverRide ?? row.Override ?? row.override ?? '').trim()
      });
    }

    const session = grouped.get(key);
    const candidateEnd = normalizeImportTime(row.End ?? row.endTime ?? row.end_time ?? '');
    if (parseTimeToMinutes(candidateEnd) > parseTimeToMinutes(session.endTime)) {
      session.endTime = candidateEnd;
    }
    const knownCourses = new Set(session.courseNames.map((item) => item.toLowerCase()));
    getImportCourses(row).forEach((course) => {
      const normalized = course.toLowerCase();
      if (!knownCourses.has(normalized)) {
        session.courseNames.push(course);
        knownCourses.add(normalized);
      }
    });
    session.courseName = session.courseNames.join('; ');
    if (!session.notes) {
      session.notes = String(row.Notes ?? row.notes ?? row.OverRide ?? row.Override ?? row.override ?? '').trim();
    }
  });

  return Array.from(grouped.values());
}

function getCalendarBounds(sessions) {
  if (!sessions.length) {
    return { start: 8 * 60, end: 18 * 60 };
  }

  const minStart = Math.min(...sessions.map((session) => parseTimeToMinutes(session.startTime)));
  const maxEnd = Math.max(...sessions.map((session) => parseTimeToMinutes(session.endTime)));
  const start = Math.floor(minStart / SLOT_MINUTES) * SLOT_MINUTES;
  const end = Math.ceil(maxEnd / SLOT_MINUTES) * SLOT_MINUTES;
  return { start, end };
}

function buildTimeMarks(startMinutes, endMinutes) {
  const marks = [];
  for (let value = startMinutes; value <= endMinutes; value += SLOT_MINUTES) {
    marks.push(value);
  }
  return marks;
}

function overlaps(a, b) {
  return parseTimeToMinutes(a.startTime) < parseTimeToMinutes(b.endTime)
    && parseTimeToMinutes(b.startTime) < parseTimeToMinutes(a.endTime);
}

function buildDayLayout(daySessions) {
  const sorted = [...daySessions].sort((a, b) =>
    parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime)
    || parseTimeToMinutes(a.endTime) - parseTimeToMinutes(b.endTime)
  );

  const laidOut = [];
  sorted.forEach((session) => {
    let lane = 0;
    while (laidOut.some((item) => item.lane === lane && overlaps(item, session))) {
      lane += 1;
    }
    laidOut.push({ ...session, lane });
  });

  const laneCount = laidOut.length ? Math.max(...laidOut.map((item) => item.lane)) + 1 : 1;
  return laidOut.map((item) => ({ ...item, laneCount }));
}

function getSheetRows(workbook, names) {
  const sheetName = names.find((name) => workbook.Sheets[name]);
  if (!sheetName) {
    return [];
  }
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
}

function courseLabel(session) {
  if (Array.isArray(session.courseNames) && session.courseNames.length) {
    return session.courseNames.join('; ');
  }
  return session.courseName || session.room || 'Session';
}

function getAutoResultMeta(result) {
  const status = String(result?.status || '').toUpperCase();
  if (!status) {
    return {
      source: 'Unknown',
      summary: 'No solver status',
      detail: '',
      tone: 'neutral'
    };
  }

  if (status.startsWith('FALLBACK_')) {
    return {
      source: 'Fallback Scheduler',
      summary: status === 'FALLBACK_OPTIMAL' ? 'Fallback produced full coverage' : 'Fallback produced partial coverage',
      detail: result?.explanation || 'CP-SAT did not return a feasible schedule inside the time limit, so a greedy fallback was used.',
      tone: status === 'FALLBACK_OPTIMAL' ? 'warning' : 'danger'
    };
  }

  if (status.includes('OPTIMAL')) {
    return {
      source: 'CP-SAT Solver',
      summary: status.includes('PARTIAL') ? 'Solver found a partial schedule' : 'Solver found an optimal schedule',
      detail: result?.explanation || '',
      tone: status.includes('PARTIAL') ? 'warning' : 'success'
    };
  }

  if (status.includes('FEASIBLE')) {
    return {
      source: 'CP-SAT Solver',
      summary: status.includes('PARTIAL') ? 'Solver found a partial feasible schedule' : 'Solver found a feasible schedule',
      detail: result?.explanation || '',
      tone: status.includes('PARTIAL') ? 'warning' : 'success'
    };
  }

  if (status === 'INFEASIBLE') {
    return {
      source: 'CP-SAT Solver',
      summary: 'No feasible schedule found',
      detail: result?.explanation || '',
      tone: 'danger'
    };
  }

  return {
    source: 'Scheduler',
    summary: status,
    detail: result?.explanation || '',
    tone: 'neutral'
  };
}

export default function SchedulingPage() {
  const [data, setData] = useState({ sessions: [], taInvigilators: [], doctorInvigilators: [] });
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState({});
  const [autoResult, setAutoResult] = useState(null);
  const [previewResult, setPreviewResult] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewExportLoading, setPreviewExportLoading] = useState(false);
  const [schedulingExportLoading, setSchedulingExportLoading] = useState(false);
  const [assignmentImportLoading, setAssignmentImportLoading] = useState(false);
  const [assignmentImportSummary, setAssignmentImportSummary] = useState(null);
  const [pendingAssignmentActionRows, setPendingAssignmentActionRows] = useState([]);
  const [assignmentImportConfirmText, setAssignmentImportConfirmText] = useState('');
  const [committeeImportLoading, setCommitteeImportLoading] = useState(false);
  const [committeeImportSummary, setCommitteeImportSummary] = useState(null);
  const [pendingCommitteeRows, setPendingCommitteeRows] = useState([]);
  const [committeeImportConfirmText, setCommitteeImportConfirmText] = useState('');
  const [committeeImportMode, setCommitteeImportMode] = useState('append');
  const [previewMode, setPreviewMode] = useState('preserve_all');
  const [roleScope, setRoleScope] = useState('both');
  const [lockFilters, setLockFilters] = useState({
    date: '',
    role: '',
    room: '',
    courseCode: '',
    staffId: '',
    assignmentSource: '',
    onlyLocked: false,
    onlyUnlocked: false,
  });
  const [lockActionLoading, setLockActionLoading] = useState(false);
  const [lockPlanImportLoading, setLockPlanImportLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [eligibleBySession, setEligibleBySession] = useState({});
  const [eligibleLoadingBySession, setEligibleLoadingBySession] = useState({});
  const [datePageStart, setDatePageStart] = useState(0);
  const [visibleDateCount, setVisibleDateCount] = useState(4);
  const [focusDate, setFocusDate] = useState('');
  const [onlyOpenNeeds, setOnlyOpenNeeds] = useState(false);
  const [density, setDensity] = useState('comfortable');
  const [roomFilter, setRoomFilter] = useState('');
  const showToast = useToast();

  async function load() {
    setLoading(true);
    try {
      const response = await api.getScheduling();
      setData(response);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((error) => showToast(error.message, 'error'));
  }, []);

  useEffect(() => {
    function updateVisibleDateCount() {
      const width = window.innerWidth;
      if (width <= 768) {
        setVisibleDateCount(1);
      } else if (width <= 1180) {
        setVisibleDateCount(2);
      } else if (width <= 1550) {
        setVisibleDateCount(3);
      } else {
        setVisibleDateCount(4);
      }
    }

    updateVisibleDateCount();
    window.addEventListener('resize', updateVisibleDateCount);
    return () => window.removeEventListener('resize', updateVisibleDateCount);
  }, []);

  const dates = [...new Set(data.sessions.map((item) => item.date))].sort();
  const maxPageStart = Math.max(0, dates.length - visibleDateCount);
  const safeDatePageStart = Math.min(datePageStart, maxPageStart);
  const visibleDates = dates.slice(safeDatePageStart, safeDatePageStart + visibleDateCount);
  const displayedDates = focusDate ? [focusDate] : visibleDates;

  const visibleSessions = useMemo(
    () => data.sessions
      .filter((session) => displayedDates.includes(session.date))
      .filter((session) => !roomFilter || String(session.room || '').toLowerCase().includes(roomFilter.toLowerCase()))
      .filter((session) => !onlyOpenNeeds || session.taRemaining > 0 || session.doctorRemaining > 0),
    [data.sessions, displayedDates, onlyOpenNeeds, roomFilter]
  );

  const availableRooms = useMemo(
    () => [...new Set(data.sessions.map((session) => String(session.room || '').trim()).filter(Boolean))].sort(),
    [data.sessions]
  );
  const allCurrentAssignmentIds = useMemo(
    () => [...new Set(data.sessions.flatMap((session) => [...(session.taAssignments || []), ...(session.doctorAssignments || [])].map((assignment) => assignment.id)).filter(Boolean))],
    [data.sessions]
  );
  const autoAssignmentIds = useMemo(
    () => [...new Set(data.sessions.flatMap((session) =>
      [...(session.taAssignments || []), ...(session.doctorAssignments || [])]
        .filter((assignment) => assignment.assignmentSource === 'auto')
        .map((assignment) => assignment.id)
    ).filter(Boolean))],
    [data.sessions]
  );
  const assignmentLockStats = useMemo(() => {
    const assignments = data.sessions.flatMap((session) => [
      ...(session.taAssignments || []),
      ...(session.doctorAssignments || []),
    ]);
    const lockedCount = assignments.filter((assignment) => assignment.locked).length;
    return {
      total: assignments.length,
      locked: lockedCount,
      unlocked: assignments.length - lockedCount,
    };
  }, [data.sessions]);
  const autoResultMeta = autoResult ? getAutoResultMeta(autoResult) : null;
  const lockFilterMatchCount = useMemo(() => {
    const assignments = data.sessions.flatMap((session) => [...(session.taAssignments || []), ...(session.doctorAssignments || [])].map((assignment) => ({
      ...assignment,
      courseCode: courseLabel(session),
      room: session.room || '',
      date: session.date || '',
      staffId: assignment.invigilator?.staffId || '',
    })));
    return assignments.filter((assignment) => {
      if (lockFilters.assignmentSource && assignment.assignmentSource !== lockFilters.assignmentSource) return false;
      if (lockFilters.role && assignment.role !== lockFilters.role) return false;
      if (lockFilters.date && assignment.date !== lockFilters.date) return false;
      if (lockFilters.room && !String(assignment.room || '').toLowerCase().includes(lockFilters.room.toLowerCase())) return false;
      if (lockFilters.courseCode && !String(assignment.courseCode || '').toLowerCase().includes(lockFilters.courseCode.toLowerCase())) return false;
      if (lockFilters.staffId && !String(assignment.invigilator?.staffId || '').toLowerCase().includes(lockFilters.staffId.toLowerCase())) return false;
      if (lockFilters.onlyLocked && !assignment.locked) return false;
      if (lockFilters.onlyUnlocked && assignment.locked) return false;
      return true;
    }).length;
  }, [data.sessions, lockFilters]);

  const openSummary = visibleSessions.reduce((acc, session) => ({
    ta: acc.ta + session.taRemaining,
    doctor: acc.doctor + session.doctorRemaining
  }), { ta: 0, doctor: 0 });

  const selectedSession = visibleSessions.find((session) => session.id === selectedSessionId) || null;
  const selectedEligibility = selectedSession ? eligibleBySession[selectedSession.id] || null : null;
  const selectedEligibilityLoading = selectedSession ? Boolean(eligibleLoadingBySession[selectedSession.id]) : false;
  const taManualOptions = useMemo(() => {
    if (selectedEligibility?.eligibleTAs?.length) {
      return selectedEligibility.eligibleTAs.map((person) => ({
        id: person.id,
        label: `${person.name} (${((Number(person.projectedMinutes || 0)) / 60).toFixed(1)}h after)`,
      }));
    }
    return (data.taInvigilators || []).map((person) => ({
      id: person.id,
      label: `${person.name}${person.staffId ? ` (${person.staffId})` : ''}`,
    }));
  }, [selectedEligibility, data.taInvigilators]);
  const doctorManualOptions = useMemo(() => {
    if (selectedEligibility?.eligibleDoctors?.length) {
      return selectedEligibility.eligibleDoctors.map((person) => ({
        id: person.id,
        label: `${person.name} (${((Number(person.projectedMinutes || 0)) / 60).toFixed(1)}h after)`,
      }));
    }
    return (data.doctorInvigilators || []).map((person) => ({
      id: person.id,
      label: `${person.name}${person.staffId ? ` (${person.staffId})` : ''}`,
    }));
  }, [selectedEligibility, data.doctorInvigilators]);
  const laneHeight = LANE_HEIGHTS[density] || LANE_HEIGHTS.comfortable;
  const minRowHeight = MIN_ROW_HEIGHTS[density] || MIN_ROW_HEIGHTS.comfortable;

  const { start: calendarStart, end: calendarEnd } = getCalendarBounds(visibleSessions);
  const timeMarks = buildTimeMarks(calendarStart, calendarEnd);
  const timeColumnCount = Math.max(1, timeMarks.length - 1);
  const dateColumnWidth = DATE_COLUMN_WIDTHS[density] || DATE_COLUMN_WIDTHS.comfortable;
  const sessionsByDate = useMemo(() => {
    const grouped = new Map(displayedDates.map((date) => [date, []]));
    visibleSessions.forEach((session) => {
      grouped.get(session.date)?.push(session);
    });
    const result = new Map();
    grouped.forEach((rows, date) => {
      result.set(date, buildDayLayout(rows));
    });
    return result;
  }, [displayedDates, visibleSessions]);

  useEffect(() => {
    if (datePageStart !== safeDatePageStart) {
      setDatePageStart(safeDatePageStart);
    }
  }, [datePageStart, safeDatePageStart]);

  useEffect(() => {
    if (focusDate && !dates.includes(focusDate)) {
      setFocusDate('');
    }
  }, [focusDate, dates]);

  useEffect(() => {
    if (selectedSessionId && !visibleSessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId('');
    }
  }, [selectedSessionId, visibleSessions]);

  useEffect(() => {
    if (!selectedSession) return;
    if (selectedEligibility || selectedEligibilityLoading) return;

    let active = true;
    setEligibleLoadingBySession((current) => ({ ...current, [selectedSession.id]: true }));
    api.getSchedulingEligible(selectedSession.id)
      .then((response) => {
        if (!active) return;
        setEligibleBySession((current) => ({ ...current, [selectedSession.id]: response }));
      })
      .catch((error) => {
        if (!active) return;
        showToast(error.message, 'error');
      })
      .finally(() => {
        if (!active) return;
        setEligibleLoadingBySession((current) => ({ ...current, [selectedSession.id]: false }));
      });

    return () => {
      active = false;
    };
  }, [selectedSession, selectedEligibility, selectedEligibilityLoading, showToast]);

  function setSelectValue(sessionId, role, value) {
    setSelection((current) => ({ ...current, [`${sessionId}_${role}`]: value }));
  }

  function toggleSessionSelection(sessionId) {
    setSelectedSessionId((current) => (current === sessionId ? '' : sessionId));
  }

  async function assign(sessionId, role) {
    const invigilatorId = selection[`${sessionId}_${role}`];
    if (!invigilatorId) {
      showToast(`Choose a ${role} first.`, 'error');
      return;
    }
    try {
      await api.assignToSession({ sessionId, invigilatorId });
      showToast(`${role} assigned to session.`, 'success');
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function autoSchedule() {
    try {
      const result = await api.autoSchedule(previewMode, roleScope);
      setAutoResult(result);
      setPreviewResult(null);
      showToast(`Auto-scheduled ${result.placed} duties.`, 'success');
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function previewAutoSchedule() {
    setPreviewLoading(true);
    try {
      const result = await api.autoSchedulePreview(previewMode, roleScope);
      setPreviewResult(result);
      showToast('Auto-schedule preview completed. No data was saved.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function exportPreviewResult() {
    if (!previewResult) {
      showToast('Run preview first.', 'error');
      return;
    }
    setPreviewExportLoading(true);
    try {
      const file = await api.exportAutoSchedulePreview(previewResult.previewMode || previewMode, previewResult.roleScope || roleScope);
      downloadFile(file.url, file.fileName || '');
      showToast('Preview export only. No data was saved.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setPreviewExportLoading(false);
    }
  }

  function updateLockFilter(key, value) {
    setLockFilters((current) => ({ ...current, [key]: value }));
  }

  async function applyLockFilters(locked) {
    setLockActionLoading(true);
    try {
      const response = await api.setSessionAssignmentLockByFilter({
        locked,
        filters: lockFilters,
      });
      showToast(`${response.updatedCount} assignment(s) updated.`, 'success');
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setLockActionLoading(false);
    }
  }

  function resetLockFilters() {
    setLockFilters({
      date: '',
      role: '',
      room: '',
      courseCode: '',
      staffId: '',
      assignmentSource: '',
      onlyLocked: false,
      onlyUnlocked: false,
    });
  }

  async function exportLockPlan() {
    try {
      const file = await api.exportAssignmentLockPlan();
      downloadFile(file.url, file.fileName || '');
      showToast('Lock plan exported.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function importLockPlan(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLockPlanImportLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = getSheetRows(workbook, ['AssignmentLockPlan']);
      const result = await api.importAssignmentLockPlan(rows);
      showToast(`Lock plan imported. Updated ${result.updated}.`, 'success');
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setLockPlanImportLoading(false);
      event.target.value = '';
    }
  }

  async function exportSchedulingFile(loader, exporter, successMessage) {
    loader(true);
    try {
      const file = await exporter();
      downloadFile(file.url, file.fileName || '');
      showToast(successMessage, 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      loader(false);
    }
  }

  async function exportCurrentSchedule() {
    await exportSchedulingFile(setSchedulingExportLoading, () => api.exportSchedulingCurrent(), 'Current schedule exported.');
  }

  async function exportAssignmentTemplate() {
    await exportSchedulingFile(setSchedulingExportLoading, () => api.exportSchedulingAssignmentTemplate(), 'Assignment edit template exported.');
  }

  async function exportCommitteeAssignmentTemplate() {
    await exportSchedulingFile(setSchedulingExportLoading, () => api.exportCommitteeAssignmentTemplate(), 'Committee assignment template exported.');
  }

  async function exportFullSystemWorkbook() {
    await exportSchedulingFile(setSchedulingExportLoading, () => api.exportWorkbook(), 'Full system workbook exported.');
  }

  async function importAssignmentActions(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setAssignmentImportLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = getSheetRows(workbook, ['AssignmentActions']);
      if (!rows.length) {
        throw new Error('AssignmentActions sheet is required.');
      }
      const result = await api.importSchedulingAssignmentActions(rows, true);
      setPendingAssignmentActionRows(rows);
      setAssignmentImportSummary(result);
      setAssignmentImportConfirmText('');
      setPreviewResult(null);
      showToast(`Dry-run complete. Added ${result.added}, updated ${result.updated}, removed ${result.removed}, rejected ${result.rejected}.`, result.rejected ? 'warning' : 'success');
    } catch (error) {
      showToast(error.message, 'error');
      setPendingAssignmentActionRows([]);
      setAssignmentImportSummary(null);
      setAssignmentImportConfirmText('');
    } finally {
      setAssignmentImportLoading(false);
    }
    event.target.value = '';
  }

  async function applyAssignmentImport() {
    if (!pendingAssignmentActionRows.length || !assignmentImportSummary?.dryRun) {
      showToast('Run a dry-run import first.', 'error');
      return;
    }
    if (assignmentImportConfirmText.trim().toUpperCase() !== 'IMPORT') {
      showToast('Type IMPORT before applying assignment changes.', 'error');
      return;
    }
    setAssignmentImportLoading(true);
    try {
      const result = await api.importSchedulingAssignmentActions(pendingAssignmentActionRows, false, assignmentImportConfirmText.trim());
      showToast(`Scheduling import applied. Added ${result.added}, updated ${result.updated}, removed ${result.removed}.`, 'success');
      setAssignmentImportSummary(result);
      setPendingAssignmentActionRows([]);
      setAssignmentImportConfirmText('');
      setSelectedSessionId('');
      setAutoResult(null);
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setAssignmentImportLoading(false);
    }
  }

  function clearAssignmentImport() {
    setPendingAssignmentActionRows([]);
    setAssignmentImportSummary(null);
    setAssignmentImportConfirmText('');
  }

  async function importCommitteeAssignments(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setCommitteeImportLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = getSheetRows(workbook, ['CommitteeAssignments', 'SchedulingAssignments']);
      if (!rows.length) {
        throw new Error('CommitteeAssignments or SchedulingAssignments sheet is required.');
      }
      const result = await api.importCommitteeAssignments(rows, committeeImportMode, true);
      setPendingCommitteeRows(rows);
      setCommitteeImportSummary(result);
      setCommitteeImportConfirmText('');
      setPreviewResult(null);
      showToast(`Committee assignment dry-run complete. Add ${result.assignmentsToAdd}, remove ${result.assignmentsToRemove}, rejected ${result.rejected}.`, result.rejected ? 'warning' : 'success');
    } catch (error) {
      showToast(error.message, 'error');
      setPendingCommitteeRows([]);
      setCommitteeImportSummary(null);
      setCommitteeImportConfirmText('');
    } finally {
      setCommitteeImportLoading(false);
      event.target.value = '';
    }
  }

  async function applyCommitteeImport() {
    if (!pendingCommitteeRows.length || !committeeImportSummary?.dryRun) {
      showToast('Run a committee assignment dry-run first.', 'error');
      return;
    }
    if (committeeImportConfirmText.trim().toUpperCase() !== 'IMPORT') {
      showToast('Type IMPORT before applying committee assignment changes.', 'error');
      return;
    }
    setCommitteeImportLoading(true);
    try {
      const result = await api.importCommitteeAssignments(
        pendingCommitteeRows,
        committeeImportMode,
        false,
        committeeImportConfirmText.trim()
      );
      setCommitteeImportSummary(result);
      setPendingCommitteeRows([]);
      setCommitteeImportConfirmText('');
      setSelectedSessionId('');
      setAutoResult(null);
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
      showToast(`Committee assignments imported. Added ${result.added}, removed ${result.removed}, rejected ${result.rejected}.`, 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setCommitteeImportLoading(false);
    }
  }

  function clearCommitteeImport() {
    setPendingCommitteeRows([]);
    setCommitteeImportSummary(null);
    setCommitteeImportConfirmText('');
  }

  async function remove(assignmentId) {
    try {
      await api.removeSessionAssignment(assignmentId);
      showToast('Assignment removed.', 'success');
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function setAssignmentLock(assignmentId, locked) {
    try {
      await api.setSessionAssignmentLock(assignmentId, locked);
      showToast(locked ? 'Assignment locked.' : 'Assignment unlocked.', 'success');
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function bulkSetAssignmentLock(assignmentIds, locked, emptyMessage) {
    if (!assignmentIds.length) {
      showToast(emptyMessage, 'error');
      return;
    }
    try {
      await api.bulkSetSessionAssignmentLock(assignmentIds, locked);
      showToast(locked ? 'Assignments locked.' : 'Assignments unlocked.', 'success');
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function removeAll() {
    if (!window.confirm('Remove all session assignments?')) return;
    try {
      await api.removeAllSessionAssignments();
      setAutoResult(null);
      setPreviewResult(null);
      showToast('All session assignments removed.', 'success');
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function showPreviousDates() {
    setDatePageStart((current) => Math.max(0, current - visibleDateCount));
  }

  function showNextDates() {
    setDatePageStart((current) => Math.min(maxPageStart, current + visibleDateCount));
  }

  return (
    <div className="schedule-page">
      <div className="panel schedule-toolbar">
        <div className="panel-head">
          <div>
            <h2>Scheduling Calendar</h2>
            <p>Calendar view by actual session time, with manual assignment and OR-Tools auto-scheduling.</p>
          </div>
          <div className="action-row">
            <select value={previewMode} onChange={(event) => { setPreviewMode(event.target.value); setPreviewResult(null); }} className="schedule-filter-select">
              <option value="preserve_all">Preserve current assignments</option>
              <option value="rebalance_all">Rebalance all assignments</option>
              <option value="preserve_manual_only">Preserve manual locks only</option>
            </select>
            <select value={roleScope} onChange={(event) => { setRoleScope(event.target.value); setPreviewResult(null); }} className="schedule-filter-select">
              <option value="both">Both TAs and Doctors</option>
              <option value="ta_only">TAs only</option>
              <option value="doctor_only">Doctors only</option>
            </select>
            <button type="button" className="ghost-btn" onClick={previewAutoSchedule} disabled={previewLoading}>
              {previewLoading ? 'Previewing...' : 'Preview Auto-Schedule'}
            </button>
            <button type="button" className="primary-btn" onClick={autoSchedule}>Auto Schedule</button>
            <button type="button" className="ghost-btn" onClick={() => bulkSetAssignmentLock(allCurrentAssignmentIds, true, 'No assignments to lock.')}>Lock All Current</button>
            <button type="button" className="ghost-btn" onClick={() => bulkSetAssignmentLock(autoAssignmentIds, false, 'No auto assignments to unlock.')}>Unlock Auto Assignments</button>
            <button type="button" className="danger-btn" onClick={removeAll}>Remove All</button>
          </div>
        </div>
        {loading ? <div className="empty-state small">Loading scheduling data...</div> : null}
        {dates.length ? (
          <div className="schedule-date-toolbar">
            <div className="schedule-date-summary">
              <strong>Visible Days</strong>
              <span>
                {focusDate ? `${focusDate} only` : `${safeDatePageStart + 1}-${Math.min(safeDatePageStart + visibleDateCount, dates.length)} of ${dates.length}`}
              </span>
            </div>
            <div className="schedule-smart-tools">
              <select value={focusDate} onChange={(event) => setFocusDate(event.target.value)} className="schedule-filter-select">
                <option value="">Paged view</option>
                {dates.map((date) => (
                  <option key={date} value={date}>{date}</option>
                ))}
              </select>
              <select value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)} className="schedule-filter-select">
                <option value="">All rooms</option>
                {availableRooms.map((room) => (
                  <option key={room} value={room}>{room}</option>
                ))}
              </select>
              <select value={density} onChange={(event) => setDensity(event.target.value)} className="schedule-filter-select">
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
                <option value="wide">Wide</option>
              </select>
              <label className="schedule-toggle">
                <input type="checkbox" checked={onlyOpenNeeds} onChange={(event) => setOnlyOpenNeeds(event.target.checked)} />
                <span>Only uncovered sessions</span>
              </label>
              <button type="button" className="ghost-btn" onClick={showPreviousDates} disabled={!!focusDate || safeDatePageStart === 0}>
                Previous
              </button>
              <button type="button" className="ghost-btn" onClick={showNextDates} disabled={!!focusDate || safeDatePageStart >= maxPageStart}>
                Next
              </button>
            </div>
          </div>
        ) : null}
        <div className="schedule-kpis">
          <div className="info-chip"><strong>Visible sessions</strong><span>{visibleSessions.length}</span></div>
          <div className="info-chip"><strong>TA gaps</strong><span>{openSummary.ta}</span></div>
          <div className="info-chip"><strong>Doctor gaps</strong><span>{openSummary.doctor}</span></div>
          <div className="info-chip"><strong>Locked assignments</strong><span>{assignmentLockStats.locked}</span></div>
          <div className="info-chip"><strong>Unlocked assignments</strong><span>{assignmentLockStats.unlocked}</span></div>
          <div className="info-chip"><strong>Role scope</strong><span>{roleScope}</span></div>
          {selectedSession ? (
            <div className="info-chip"><strong>Selected</strong><span>{courseLabel(selectedSession)}</span></div>
          ) : null}
        </div>
        <div className="empty-state small" style={{ marginTop: 8 }}>
          {roleScope === 'ta_only'
            ? 'TAs only: Doctor assignments stay fixed.'
            : roleScope === 'doctor_only'
              ? 'Doctors only: TA assignments stay fixed.'
              : 'Both: both TAs and Doctors may be scheduled.'}
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="panel-head">
            <div>
              <h3>Scheduling Export</h3>
              <p>Operational schedule workbooks only. This is separate from the full system export.</p>
            </div>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={exportCurrentSchedule} disabled={schedulingExportLoading}>
              {schedulingExportLoading ? 'Exporting...' : 'Export Current Schedule'}
            </button>
            <button type="button" className="ghost-btn" onClick={exportAssignmentTemplate} disabled={schedulingExportLoading}>
              {schedulingExportLoading ? 'Exporting...' : 'Export Assignment Edit Template'}
            </button>
            <button type="button" className="ghost-btn" onClick={exportCommitteeAssignmentTemplate} disabled={schedulingExportLoading}>
              {schedulingExportLoading ? 'Exporting...' : 'Export Committee Assignment Template'}
            </button>
            <button type="button" className="ghost-btn" onClick={exportLockPlan} disabled={schedulingExportLoading}>
              {schedulingExportLoading ? 'Exporting...' : 'Export Lock Plan'}
            </button>
            <button type="button" className="ghost-btn" onClick={exportPreviewResult} disabled={previewExportLoading || !previewResult}>
              {previewExportLoading ? 'Exporting Preview...' : 'Export Preview Result'}
            </button>
          </div>
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="panel-head">
            <div>
              <h3>Scheduling Import</h3>
              <p>This import affects Scheduling assignments only. It does not modify sessions, invigilators, staff policies, on-call settings, or course-room assignment data.</p>
            </div>
          </div>
          <div className="action-row">
            <label className="ghost-btn">
              {assignmentImportLoading ? 'Validating...' : 'Import Assignment Actions'}
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importAssignmentActions} />
            </label>
            <label className="ghost-btn">
              {committeeImportLoading ? 'Validating Committee...' : 'Import Committee Assignments'}
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importCommitteeAssignments} />
            </label>
            <label className="ghost-btn">
              {lockPlanImportLoading ? 'Importing Lock Plan...' : 'Import Lock Plan'}
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importLockPlan} />
            </label>
            <button type="button" className="ghost-btn" onClick={clearAssignmentImport} disabled={assignmentImportLoading || (!assignmentImportSummary && !pendingAssignmentActionRows.length)}>
              Clear Import Review
            </button>
            <button type="button" className="ghost-btn" onClick={clearCommitteeImport} disabled={committeeImportLoading || (!committeeImportSummary && !pendingCommitteeRows.length)}>
              Clear Committee Review
            </button>
          </div>
          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              marginTop: 12,
            }}
          >
            <label className="form-field">
              <span>Committee Import Mode</span>
              <select value={committeeImportMode} onChange={(event) => setCommitteeImportMode(event.target.value)}>
                <option value="append">Append</option>
                <option value="replace_matching_sessions">Replace Matching Sessions</option>
              </select>
            </label>
          </div>
          <div className="schedule-run-status-detail" style={{ marginTop: 8 }}>
            This import affects Scheduling assignments only. It does not create sessions or invigilators.
          </div>
          {assignmentImportSummary ? (
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="chips-wrap">
                <div className="info-chip"><strong>Rows</strong><span>{assignmentImportSummary.rowsRead}</span></div>
                <div className="info-chip"><strong>Would Add</strong><span>{assignmentImportSummary.added}</span></div>
                <div className="info-chip"><strong>Would Update</strong><span>{assignmentImportSummary.updated}</span></div>
                <div className="info-chip"><strong>Would Remove</strong><span>{assignmentImportSummary.removed}</span></div>
                <div className="info-chip"><strong>Would Lock</strong><span>{assignmentImportSummary.locked}</span></div>
                <div className="info-chip"><strong>Would Unlock</strong><span>{assignmentImportSummary.unlocked}</span></div>
                <div className="info-chip"><strong>Rejected</strong><span>{assignmentImportSummary.rejected}</span></div>
                <div className="info-chip"><strong>Unchanged</strong><span>{assignmentImportSummary.unchanged}</span></div>
              </div>
              <div className="schedule-run-status-detail" style={{ marginTop: 12 }}>
                {assignmentImportSummary.note || 'Dry-run only. No data was saved.'}
              </div>
              {assignmentImportSummary.errors?.length ? (
                <div className="table-shell" style={{ marginTop: 12 }}>
                  <table className="data-table compact-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Action</th>
                        <th>Assignment</th>
                        <th>Session</th>
                        <th>Staff</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignmentImportSummary.errors.slice(0, 20).map((item) => (
                        <tr key={`import-error-${item.row}-${item.AssignmentID}-${item.SessionID}-${item.StaffID}`}>
                          <td>{item.row}</td>
                          <td>{item.action || '-'}</td>
                          <td>{item.AssignmentID || '-'}</td>
                          <td>{item.SessionID || '-'}</td>
                          <td>{item.StaffID || '-'}</td>
                          <td>{item.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <div className="action-row" style={{ marginTop: 12 }}>
                <label className="form-field" style={{ minWidth: 220 }}>
                  <span>Type IMPORT to apply</span>
                  <input value={assignmentImportConfirmText} onChange={(event) => setAssignmentImportConfirmText(event.target.value)} placeholder="IMPORT" />
                </label>
                <button type="button" className="primary-btn" onClick={applyAssignmentImport} disabled={assignmentImportLoading || !assignmentImportSummary.dryRun}>
                  {assignmentImportLoading ? 'Applying...' : 'Apply Import'}
                </button>
              </div>
            </div>
          ) : null}
          {committeeImportSummary ? (
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="chips-wrap">
                <div className="info-chip"><strong>Rows</strong><span>{committeeImportSummary.rowsRead}</span></div>
                <div className="info-chip"><strong>Expanded</strong><span>{committeeImportSummary.expandedAssignments}</span></div>
                <div className="info-chip"><strong>Sessions Matched</strong><span>{committeeImportSummary.sessionsMatched}</span></div>
                <div className="info-chip"><strong>Would Add</strong><span>{committeeImportSummary.assignmentsToAdd}</span></div>
                <div className="info-chip"><strong>Would Remove</strong><span>{committeeImportSummary.assignmentsToRemove}</span></div>
                <div className="info-chip"><strong>Duplicates</strong><span>{committeeImportSummary.duplicatesSkipped}</span></div>
                <div className="info-chip"><strong>Rejected</strong><span>{committeeImportSummary.rejected}</span></div>
              </div>
              <div className="schedule-run-status-detail" style={{ marginTop: 12 }}>
                {committeeImportSummary.note || 'Dry-run only. No data was saved.'}
              </div>
              {committeeImportSummary.errors?.length ? (
                <div className="table-shell" style={{ marginTop: 12 }}>
                  <table className="data-table compact-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Session</th>
                        <th>Staff</th>
                        <th>Role</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {committeeImportSummary.errors.slice(0, 20).map((item) => (
                        <tr key={`committee-error-${item.row}-${item.sessionReference?.SessionID || ''}-${item.staffReference?.StaffID || ''}`}>
                          <td>{item.row}</td>
                          <td>{item.sessionReference?.SessionID || `${item.sessionReference?.Date || ''} ${item.sessionReference?.Start || ''} ${item.sessionReference?.Room || ''}`}</td>
                          <td>{item.staffReference?.StaffID || item.staffReference?.StaffName || '-'}</td>
                          <td>{item.role || '-'}</td>
                          <td>{item.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <div className="action-row" style={{ marginTop: 12 }}>
                <label className="form-field" style={{ minWidth: 220 }}>
                  <span>Type IMPORT to apply</span>
                  <input value={committeeImportConfirmText} onChange={(event) => setCommitteeImportConfirmText(event.target.value)} placeholder="IMPORT" />
                </label>
                <button type="button" className="primary-btn" onClick={applyCommitteeImport} disabled={committeeImportLoading || !committeeImportSummary.dryRun}>
                  {committeeImportLoading ? 'Applying...' : 'Apply Committee Import'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="panel-head">
            <div>
              <h3>Full System Workbook</h3>
              <p>Backup and whole-app review only. This remains separate from Scheduling operations.</p>
            </div>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={exportFullSystemWorkbook} disabled={schedulingExportLoading}>
              {schedulingExportLoading ? 'Exporting...' : 'Full System Export'}
            </button>
          </div>
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="panel-head">
            <div>
              <h3>Lock Management</h3>
              <p>This changes only lock metadata. It does not delete assignments and does not run auto-schedule.</p>
            </div>
            <div className="chips-wrap">
              <div className="info-chip"><strong>Matching</strong><span>{lockFilterMatchCount}</span></div>
              <div className="info-chip"><strong>Total</strong><span>{assignmentLockStats.total}</span></div>
              <div className="info-chip"><strong>Locked</strong><span>{assignmentLockStats.locked}</span></div>
              <div className="info-chip"><strong>Unlocked</strong><span>{assignmentLockStats.unlocked}</span></div>
            </div>
          </div>
          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              marginBottom: 12,
            }}
          >
            <label className="form-field">
              <span>Date</span>
              <input type="date" value={lockFilters.date} onChange={(event) => updateLockFilter('date', event.target.value)} />
            </label>
            <label className="form-field">
              <span>Role</span>
              <select value={lockFilters.role} onChange={(event) => updateLockFilter('role', event.target.value)}>
                <option value="">All roles</option>
                <option value="TA">TA</option>
                <option value="Doctor">Doctor</option>
              </select>
            </label>
            <label className="form-field">
              <span>Room</span>
              <input value={lockFilters.room} onChange={(event) => updateLockFilter('room', event.target.value)} placeholder="Room contains..." />
            </label>
            <label className="form-field">
              <span>Course</span>
              <input value={lockFilters.courseCode} onChange={(event) => updateLockFilter('courseCode', event.target.value)} placeholder="Course contains..." />
            </label>
            <label className="form-field">
              <span>Staff</span>
              <input value={lockFilters.staffId} onChange={(event) => updateLockFilter('staffId', event.target.value)} placeholder="Staff ID contains..." />
            </label>
            <label className="form-field">
              <span>Source</span>
              <select value={lockFilters.assignmentSource} onChange={(event) => updateLockFilter('assignmentSource', event.target.value)}>
                <option value="">All sources</option>
                <option value="legacy">Legacy</option>
                <option value="manual">Manual</option>
                <option value="auto">Auto</option>
                <option value="import">Import</option>
              </select>
            </label>
            <label className="schedule-toggle">
              <input
                type="checkbox"
                checked={lockFilters.onlyLocked}
                onChange={(event) => {
                  updateLockFilter('onlyLocked', event.target.checked);
                  if (event.target.checked) updateLockFilter('onlyUnlocked', false);
                }}
              />
              <span>Only locked</span>
            </label>
            <label className="schedule-toggle">
              <input
                type="checkbox"
                checked={lockFilters.onlyUnlocked}
                onChange={(event) => {
                  updateLockFilter('onlyUnlocked', event.target.checked);
                  if (event.target.checked) updateLockFilter('onlyLocked', false);
                }}
              />
              <span>Only unlocked</span>
            </label>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={() => applyLockFilters(true)} disabled={lockActionLoading}>
              {lockActionLoading ? 'Applying...' : 'Lock Matching'}
            </button>
            <button type="button" className="ghost-btn" onClick={() => applyLockFilters(false)} disabled={lockActionLoading}>
              {lockActionLoading ? 'Applying...' : 'Unlock Matching'}
            </button>
            <button type="button" className="ghost-btn" onClick={resetLockFilters}>Reset Filters</button>
            <button type="button" className="ghost-btn" onClick={exportLockPlan}>Export Lock Plan</button>
            <label className="ghost-btn">
              {lockPlanImportLoading ? 'Importing Lock Plan...' : 'Import Lock Plan'}
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importLockPlan} />
            </label>
          </div>
        </div>
        {autoResult ? (
          <div className={`schedule-run-status tone-${autoResultMeta.tone}`}>
            <div className="schedule-run-status-main">
              <span className={`schedule-status-pill tone-${autoResultMeta.tone}`}>{autoResultMeta.source}</span>
              <strong>{autoResultMeta.summary}</strong>
              <span>{autoResult.status} | placed {autoResult.placed}</span>
            </div>
            {autoResultMeta.detail ? (
              <div className="schedule-run-status-detail">{autoResultMeta.detail}</div>
            ) : null}
            {autoResult.averageHoursByRole ? (
              <div className="chips-wrap" style={{ marginTop: 12 }}>
                <div className="info-chip"><strong>TA Avg H</strong><span>{Number(autoResult.averageHoursByRole.TA || 0).toFixed(2)}</span></div>
                <div className="info-chip"><strong>Doctor Avg H</strong><span>{Number(autoResult.averageHoursByRole.Doctor || 0).toFixed(2)}</span></div>
                <div className="info-chip"><strong>Over Policy</strong><span>{Array.isArray(autoResult.overLimitStaff) ? autoResult.overLimitStaff.length : 0}</span></div>
                <div className="info-chip"><strong>Excluded Skipped</strong><span>{Array.isArray(autoResult.excludedStaffSkipped) ? autoResult.excludedStaffSkipped.length : 0}</span></div>
                <div className="info-chip"><strong>Shortage</strong><span>{Number(autoResult.shortageRemaining || 0)}</span></div>
              </div>
            ) : null}
          </div>
        ) : null}
        {previewResult ? (
          <div className="schedule-run-status tone-warning" style={{ marginTop: 12 }}>
            <div className="schedule-run-status-main">
              <span className="schedule-status-pill tone-warning">PREVIEW ONLY</span>
              <strong>{previewResult.selectionReason || 'Auto-schedule preview complete'}</strong>
              <span>{previewResult.previewMode || previewMode} | {previewResult.roleScope || roleScope} | {previewResult.selectedSolver || 'unknown'} | placed {previewResult.placedDuties} | shortage {previewResult.totalShortage}</span>
            </div>
            <div className="schedule-run-status-detail">{previewResult.note || 'Preview only. No data was saved.'}</div>
            {previewResult.roleScopedNote ? (
              <div className="schedule-run-status-detail">{previewResult.roleScopedNote}</div>
            ) : null}
            <div className="schedule-run-status-detail">Preview export only. No data is saved.</div>
            <div className="action-row" style={{ marginTop: 8 }}>
              <button type="button" className="ghost-btn" onClick={exportPreviewResult} disabled={previewExportLoading}>
                {previewExportLoading ? 'Exporting Preview...' : 'Export Preview Result'}
              </button>
            </div>
            {previewResult.assignmentModeSupport && !previewResult.assignmentModeSupport.supportsPreserveManualOnly ? (
              <div className="schedule-run-status-detail">{previewResult.assignmentModeSupport.reason}</div>
            ) : null}
            <div className="chips-wrap" style={{ marginTop: 12 }}>
              <div className="info-chip"><strong>Selected Solver</strong><span>{previewResult.selectedSolver || '-'}</span></div>
              <div className="info-chip"><strong>Role Scope</strong><span>{previewResult.roleScope || 'both'}</span></div>
              <div className="info-chip"><strong>CP-SAT</strong><span>{previewResult.cpSatStatus || '-'}</span></div>
              <div className="info-chip"><strong>Fallback</strong><span>{previewResult.fallbackStatus || '-'}</span></div>
              <div className="info-chip"><strong>Current Assignments</strong><span>{previewResult.currentAssignmentsCount}</span></div>
              <div className="info-chip"><strong>Preview Assignments</strong><span>{previewResult.previewAssignmentsCount}</span></div>
              <div className="info-chip"><strong>Would Keep</strong><span>{previewResult.assignmentsWouldKeep}</span></div>
              <div className="info-chip"><strong>Would Create</strong><span>{previewResult.assignmentsWouldCreate}</span></div>
              <div className="info-chip"><strong>Would Remove</strong><span>{previewResult.assignmentsWouldRemove}</span></div>
              <div className="info-chip"><strong>TA Create</strong><span>{previewResult.taAssignmentsWouldCreate ?? 0}</span></div>
              <div className="info-chip"><strong>TA Remove</strong><span>{previewResult.taAssignmentsWouldRemove ?? 0}</span></div>
              <div className="info-chip"><strong>Doctor Create</strong><span>{previewResult.doctorAssignmentsWouldCreate ?? 0}</span></div>
              <div className="info-chip"><strong>Doctor Remove</strong><span>{previewResult.doctorAssignmentsWouldRemove ?? 0}</span></div>
              <div className="info-chip"><strong>Locked Used</strong><span>{previewResult.lockedAssignmentsUsed}</span></div>
              <div className="info-chip"><strong>Locked Preserved</strong><span>{previewResult.lockedAssignmentsPreserved ? 'Yes' : 'No'}</span></div>
              <div className="info-chip"><strong>Role Scope Preserved</strong><span>{previewResult.preservedByRoleScopeCount ?? 0}</span></div>
              <div className="info-chip"><strong>Doctors Preserved</strong><span>{previewResult.preservedDoctorAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>TAs Preserved</strong><span>{previewResult.preservedTAAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>Manual Locked</strong><span>{previewResult.preservedManualLockedAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>Legacy Locked</strong><span>{previewResult.preservedLegacyLockedAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>Import Locked</strong><span>{previewResult.preservedImportLockedAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>Legacy Unlocked</strong><span>{previewResult.replaceableLegacyUnlockedAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>Manual Unlocked</strong><span>{previewResult.replaceableManualUnlockedAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>Import Unlocked</strong><span>{previewResult.replaceableImportUnlockedAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>Auto Unlocked</strong><span>{previewResult.replaceableAutoUnlockedAssignments ?? 0}</span></div>
              <div className="info-chip"><strong>Over Hard Limit</strong><span>{Array.isArray(previewResult.overHardLimitStaff) ? previewResult.overHardLimitStaff.length : 0}</span></div>
              <div className="info-chip"><strong>Over Target</strong><span>{Array.isArray(previewResult.overTargetStaff) ? previewResult.overTargetStaff.length : 0}</span></div>
              <div className="info-chip"><strong>Excluded Skipped</strong><span>{Array.isArray(previewResult.excludedStaffSkipped) ? previewResult.excludedStaffSkipped.length : 0}</span></div>
              <div className="info-chip"><strong>TA Avg H</strong><span>{Number(previewResult.averageHoursByRole?.TA || 0).toFixed(2)}</span></div>
              <div className="info-chip"><strong>Doctor Avg H</strong><span>{Number(previewResult.averageHoursByRole?.Doctor || 0).toFixed(2)}</span></div>
            </div>
            <div className="chips-wrap" style={{ marginTop: 12 }}>
              <div className="info-chip"><strong>Current Shortage</strong><span>{Number(previewResult.currentTotalShortage || 0)}</span></div>
              <div className="info-chip"><strong>Preview Shortage</strong><span>{Number(previewResult.previewTotalShortage || 0)}</span></div>
              <div className="info-chip"><strong>Current TA Shortage</strong><span>{Number(previewResult.currentTaShortage || 0)}</span></div>
              <div className="info-chip"><strong>Preview TA Shortage</strong><span>{Number(previewResult.previewTaShortage || 0)}</span></div>
              <div className="info-chip"><strong>Current Doctor Shortage</strong><span>{Number(previewResult.currentDoctorShortage || 0)}</span></div>
              <div className="info-chip"><strong>Preview Doctor Shortage</strong><span>{Number(previewResult.previewDoctorShortage || 0)}</span></div>
              <div className="info-chip"><strong>Current Over Target</strong><span>{Number(previewResult.currentOverTargetCount || 0)}</span></div>
              <div className="info-chip"><strong>Preview Over Target</strong><span>{Number(previewResult.previewOverTargetCount || 0)}</span></div>
              <div className="info-chip"><strong>Current TA Spread</strong><span>{Number(previewResult.currentRoleHourSpread?.TA || 0).toFixed(2)}</span></div>
              <div className="info-chip"><strong>Preview TA Spread</strong><span>{Number(previewResult.previewRoleHourSpread?.TA || 0).toFixed(2)}</span></div>
              <div className="info-chip"><strong>Current Doctor Spread</strong><span>{Number(previewResult.currentRoleHourSpread?.Doctor || 0).toFixed(2)}</span></div>
              <div className="info-chip"><strong>Preview Doctor Spread</strong><span>{Number(previewResult.previewRoleHourSpread?.Doctor || 0).toFixed(2)}</span></div>
            </div>
            <div className="schedule-preview-grid" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginTop: 12 }}>
              <div className="panel" style={{ margin: 0 }}>
                <h4 style={{ marginTop: 0 }}>Top Staff Over Target</h4>
                {(previewResult.topOverTargetStaff || []).length ? (
                  <div className="table-shell">
                    <table className="data-table compact-table">
                      <thead>
                        <tr>
                          <th>Staff</th>
                          <th>Role</th>
                          <th>Assigned H</th>
                          <th>Allowed H</th>
                          <th>Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewResult.topOverTargetStaff.map((item) => (
                          <tr key={`over-${item.staffId}`}>
                            <td>{item.name || item.staffId}</td>
                            <td>{item.role}</td>
                            <td>{Number(item.assignedHours || 0).toFixed(2)}</td>
                            <td>{Number(item.allowedHours || 0).toFixed(2)}</td>
                            <td>{Number(item.differenceHours || 0).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty-state small">No over-target staff in preview.</div>}
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h4 style={{ marginTop: 0 }}>Top Staff Under Target</h4>
                {(previewResult.topUnderTargetStaff || []).length ? (
                  <div className="table-shell">
                    <table className="data-table compact-table">
                      <thead>
                        <tr>
                          <th>Staff</th>
                          <th>Role</th>
                          <th>Assigned H</th>
                          <th>Allowed H</th>
                          <th>Gap</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewResult.topUnderTargetStaff.map((item) => (
                          <tr key={`under-${item.staffId}`}>
                            <td>{item.name || item.staffId}</td>
                            <td>{item.role}</td>
                            <td>{Number(item.assignedHours || 0).toFixed(2)}</td>
                            <td>{Number(item.allowedHours || 0).toFixed(2)}</td>
                            <td>{Number((item.allowedHours || 0) - (item.assignedHours || 0)).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty-state small">No underloaded staff in preview.</div>}
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h4 style={{ marginTop: 0 }}>Hours That Would Decrease</h4>
                {(previewResult.staffWithReducedHours || []).length ? (
                  <div className="table-shell">
                    <table className="data-table compact-table">
                      <thead>
                        <tr>
                          <th>Staff</th>
                          <th>Role</th>
                          <th>Current H</th>
                          <th>Preview H</th>
                          <th>Delta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewResult.staffWithReducedHours.map((item) => (
                          <tr key={`dec-${item.staffId}`}>
                            <td>{item.name || item.staffId}</td>
                            <td>{item.role}</td>
                            <td>{Number(item.currentHours || 0).toFixed(2)}</td>
                            <td>{Number(item.previewHours || 0).toFixed(2)}</td>
                            <td>{Number(item.differenceHours || 0).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty-state small">No staff would lose hours.</div>}
              </div>
              <div className="panel" style={{ margin: 0 }}>
                <h4 style={{ marginTop: 0 }}>Hours That Would Increase</h4>
                {(previewResult.staffWithIncreasedHours || []).length ? (
                  <div className="table-shell">
                    <table className="data-table compact-table">
                      <thead>
                        <tr>
                          <th>Staff</th>
                          <th>Role</th>
                          <th>Current H</th>
                          <th>Preview H</th>
                          <th>Delta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewResult.staffWithIncreasedHours.map((item) => (
                          <tr key={`inc-${item.staffId}`}>
                            <td>{item.name || item.staffId}</td>
                            <td>{item.role}</td>
                            <td>{Number(item.currentHours || 0).toFixed(2)}</td>
                            <td>{Number(item.previewHours || 0).toFixed(2)}</td>
                            <td>{Number(item.differenceHours || 0).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty-state small">No staff would gain hours.</div>}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {!dates.length ? (
        <div className="panel empty-state">No sessions available yet. Import or create sessions first.</div>
      ) : (
        <div
          className={`schedule-workspace density-${density}${selectedSession ? '' : ' no-selection'}`}
          style={{
            '--schedule-date-width': `${dateColumnWidth}px`,
            '--schedule-column-count': `${timeColumnCount}`
          }}
        >
          <div className="schedule-calendar-shell">
            <div className="schedule-calendar-header">
              <div className="schedule-date-header-cell">Date</div>
              {timeMarks.slice(0, -1).map((mark) => (
                <div key={mark} className="schedule-time-header-cell">
                  <div>{formatTimeLabel(mark)}</div>
                </div>
              ))}
            </div>

            <div className="schedule-calendar-body schedule-calendar-body-rows">
              {displayedDates.map((date) => {
                const daySessions = sessionsByDate.get(date) || [];
                const taGap = daySessions.reduce((sum, session) => sum + session.taRemaining, 0);
                const doctorGap = daySessions.reduce((sum, session) => sum + session.doctorRemaining, 0);
                const rowHeight = Math.max(minRowHeight, (Math.max(...daySessions.map((item) => item.lane), 0) + 1) * laneHeight);

                return (
                  <div key={date} className="schedule-date-row">
                    <div className="schedule-date-side">
                      <div className="schedule-date-cell">
                        <div>{formatDateLabel(date)}</div>
                        <div className="schedule-date-subtitle">{date}</div>
                        <div className="schedule-date-gaps">TA {taGap} | Doctor {doctorGap}</div>
                      </div>
                    </div>
                    <div className="schedule-time-cells">
                      {timeMarks.slice(0, -1).map((mark) => (
                        <div key={mark} className="schedule-time-slot-cell" />
                      ))}
                      {!daySessions.length ? <div className="calendar-day-empty calendar-day-empty-row">No session</div> : null}
                      {daySessions.map((session) => {
                        const startMinutes = parseTimeToMinutes(session.startTime);
                        const endMinutes = parseTimeToMinutes(session.endTime);
                        const leftPercent = ((startMinutes - calendarStart) / (calendarEnd - calendarStart || SLOT_MINUTES)) * 100;
                        const widthPercent = Math.max(
                          (density === 'compact' ? 8 : 10),
                          ((endMinutes - startMinutes) / (calendarEnd - calendarStart || SLOT_MINUTES)) * 100
                        );
                        const top = (session.lane * laneHeight) + 10;
                        const coverageState = session.taRemaining + session.doctorRemaining > 0 ? 'needs-attention' : 'covered';
                        const sessionShortName = courseLabel(session);
                        const displayTitle = density === 'compact' && sessionShortName.length > 28
                          ? `${sessionShortName.slice(0, 28)}...`
                          : sessionShortName;

                        return (
                          <article
                            key={session.id}
                            className={`calendar-session-card calendar-session-card-horizontal ${coverageState}${session.id === selectedSessionId ? ' is-selected' : ''}`}
                            style={{ left: `${leftPercent}%`, width: `${widthPercent}%`, top: `${top}px` }}
                            onClick={() => toggleSessionSelection(session.id)}
                          >
                            <div className="calendar-session-topline">
                              <span className={`calendar-session-status${session.id === selectedSessionId ? ' active' : ''}`}>
                                {session.taRemaining + session.doctorRemaining > 0 ? 'Gap' : 'Covered'}
                              </span>
                            </div>
                            <div className="calendar-session-title">{displayTitle}</div>
                            <div className="calendar-session-time">{session.startTime} - {session.endTime}</div>
                            <div className="calendar-session-room">{session.room || 'No room'}</div>
                            <div className="calendar-session-needs">
                              <span>TA {session.taAssignments.length}/{session.taNeeded}</span>
                              <span>Doctor {session.doctorAssignments.length}/{session.doctorNeeded}</span>
                            </div>
                          </article>
                        );
                      })}
                      <div className="schedule-time-cells-spacer" style={{ height: `${rowHeight}px` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {selectedSession ? (
            <aside className="panel schedule-detail-panel schedule-detail-sidebar">
              <>
                <div className="panel-head">
                  <div>
                    <h2>{courseLabel(selectedSession)}</h2>
                    <p>{selectedSession.date} | {selectedSession.startTime} - {selectedSession.endTime} | Room: {selectedSession.room || '-'}</p>
                  </div>
                  <div className="need-badges">
                    <span>TA {selectedSession.taAssignments.length}/{selectedSession.taNeeded}</span>
                    <span>Doctor {selectedSession.doctorAssignments.length}/{selectedSession.doctorNeeded}</span>
                  </div>
                </div>

                <div className="schedule-detail-summary">
                  <div className="info-chip"><strong>TA left</strong><span>{selectedSession.taRemaining}</span></div>
                  <div className="info-chip"><strong>Doctor left</strong><span>{selectedSession.doctorRemaining}</span></div>
                  <div className="info-chip"><strong>Duration</strong><span>{(Number(selectedSession.durationMinutes || 0) / 60).toFixed(1)}h</span></div>
                  <div className="info-chip"><strong>Eligible TA</strong><span>{selectedSession.eligibleTACount ?? (selectedEligibility?.eligibleTAs.length || 0)}</span></div>
                  <div className="info-chip"><strong>Eligible Doctor</strong><span>{selectedSession.eligibleDoctorCount ?? (selectedEligibility?.eligibleDoctors.length || 0)}</span></div>
                </div>
                {selectedEligibilityLoading ? <p className="muted">Loading eligible candidates. You can still choose from the current TA/Doctor lists while backend validation runs on assign.</p> : null}
                {!selectedEligibilityLoading && !selectedEligibility ? (
                  <p className="muted">Eligible candidates could not be loaded yet. You can still choose from the full role list and the backend will validate conflicts and policy rules.</p>
                ) : null}
                {!selectedEligibilityLoading && selectedEligibility && !selectedEligibility.eligibleTAs?.length && !selectedEligibility.eligibleDoctors?.length ? (
                  <p className="muted">No eligible candidates were returned for this session. You can still try the full role list if you need backend validation against current data.</p>
                ) : null}

                <div className="schedule-detail-sections">
                  <div className="duty-column">
                    <h4>TA Assignment</h4>
                    <div className="calendar-session-block">
                      <select value={selection[`${selectedSession.id}_TA`] || ''} onChange={(event) => setSelectValue(selectedSession.id, 'TA', event.target.value)}>
                        <option value="">Select TA</option>
                        {taManualOptions.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.label}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn btn-primary" onClick={() => assign(selectedSession.id, 'TA')}>Assign TA</button>
                    </div>
                    <div className="calendar-assignment-list">
                      {selectedSession.taAssignments.map((assignment) => (
                        <div key={assignment.id} className="calendar-assignment-row">
                          <span>
                            {assignment.invigilator?.name || 'Unknown'} (TA)
                            <small className="muted"> [{assignment.assignmentSource || 'legacy'} / {assignment.locked ? 'locked' : 'unlocked'}]</small>
                          </span>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAssignmentLock(assignment.id, !assignment.locked)}>
                            {assignment.locked ? 'Unlock' : 'Lock'}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(assignment.id)}>Remove</button>
                        </div>
                      ))}
                      {!selectedSession.taAssignments.length ? <div className="exam-cell-empty">No TA assigned</div> : null}
                    </div>
                  </div>

                  <div className="duty-column">
                    <h4>Doctor Assignment</h4>
                    <div className="calendar-session-block">
                      <select value={selection[`${selectedSession.id}_Doctor`] || ''} onChange={(event) => setSelectValue(selectedSession.id, 'Doctor', event.target.value)}>
                        <option value="">Select Doctor</option>
                        {doctorManualOptions.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.label}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn btn-primary" onClick={() => assign(selectedSession.id, 'Doctor')}>Assign Doctor</button>
                    </div>
                    <div className="calendar-assignment-list">
                      {selectedSession.doctorAssignments.map((assignment) => (
                        <div key={assignment.id} className="calendar-assignment-row">
                          <span>
                            {assignment.invigilator?.name || 'Unknown'} (Doctor)
                            <small className="muted"> [{assignment.assignmentSource || 'legacy'} / {assignment.locked ? 'locked' : 'unlocked'}]</small>
                          </span>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAssignmentLock(assignment.id, !assignment.locked)}>
                            {assignment.locked ? 'Unlock' : 'Lock'}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(assignment.id)}>Remove</button>
                        </div>
                      ))}
                      {!selectedSession.doctorAssignments.length ? <div className="exam-cell-empty">No doctor assigned</div> : null}
                    </div>
                  </div>
                </div>
              </>
            </aside>
          ) : null}
        </div>
      )}
    </div>
  );
}
