import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { api, downloadFile } from '../api';
import { useToast } from '../App';
import { priorityLabels } from '../components/SchedulingPriorities';

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
  if (result.combined) return { source: 'Combined planner', summary: result.shortageRemaining ? 'Plan saved with remaining gaps' : 'Session and on-call plan saved', detail: 'Saved exactly as reviewed.', tone: result.shortageRemaining ? 'warning' : 'success' };
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
  const [workspace, setWorkspace] = useState('calendar');
  const [buildScope, setBuildScope] = useState('combined');
  const [policyMode, setPolicyMode] = useState('strict');
  const [shortageExcludedInvigilatorIds, setShortageExcludedInvigilatorIds] = useState([]);
  const [dutyFilter, setDutyFilter] = useState('all');
  const [scheduleView, setScheduleView] = useState('list');
  const [autoLoading, setAutoLoading] = useState(false);
  const operationRunning = useRef(false);
  const previewSequence = useRef(0);
  const loadSequence = useRef(0);
  const loadedVersion = useRef(null);
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [importFormat, setImportFormat] = useState('actions');
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
  const busy = previewLoading || autoLoading || assignmentSaving || assignmentImportLoading || committeeImportLoading || lockActionLoading || lockPlanImportLoading;
  const shortageChoicesChanged = previewResult?.policyMode === 'cover_shortage' && JSON.stringify([...shortageExcludedInvigilatorIds].sort()) !== JSON.stringify([...(previewResult.shortageExcludedInvigilatorIds || [])].sort());

  async function load() {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const response = await api.getCombinedScheduling();
      if (sequence !== loadSequence.current) return;
      if (loadedVersion.current !== null && response.storeVersion !== undefined && loadedVersion.current !== response.storeVersion) {
        previewSequence.current += 1;
        setPreviewResult(null);
      }
      loadedVersion.current = response.storeVersion ?? null;
      const onCallPeriods = (response.onCall?.periods || []).map((period) => ({
        ...period, id: `__on_call__|${period.periodKey}`, dutyType: 'on_call',
        courseName: 'On-call reserve', room: 'On-call reserve',
        taNeeded: period.onCallTANeeded, doctorNeeded: period.onCallDoctorNeeded,
        taRemaining: period.onCallTARemaining, doctorRemaining: period.onCallDoctorRemaining,
      }));
      if (sequence === loadSequence.current) setData({ ...response, sessions: [...response.sessions, ...onCallPeriods] });
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((error) => showToast(error.message, 'error'));
    const refresh = (event) => {
      if (event.type === 'scheduler:data-changed') {
        previewSequence.current += 1;
        setPreviewResult(null);
      }
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      load().catch((error) => showToast(error.message, 'error'));
    };
    window.addEventListener('scheduler:data-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      loadSequence.current += 1;
      previewSequence.current += 1;
      window.removeEventListener('scheduler:data-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
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
      .filter((session) => dutyFilter === 'all' || (session.dutyType === 'on_call' ? dutyFilter === 'on_call' : dutyFilter === 'sessions'))
      .filter((session) => displayedDates.includes(session.date))
      .filter((session) => !roomFilter || String(session.room || '').toLowerCase().includes(roomFilter.toLowerCase()))
      .filter((session) => !onlyOpenNeeds || session.taRemaining > 0 || session.doctorRemaining > 0),
    [data.sessions, displayedDates, onlyOpenNeeds, roomFilter, dutyFilter]
  );

  const availableRooms = useMemo(
    () => [...new Set(data.sessions.map((session) => String(session.room || '').trim()).filter(Boolean))].sort(),
    [data.sessions]
  );
  const allCurrentAssignmentIds = useMemo(
    () => [...new Set(data.sessions.filter((session) => session.dutyType !== 'on_call').flatMap((session) => [...(session.taAssignments || []), ...(session.doctorAssignments || [])].map((assignment) => assignment.id)).filter(Boolean))],
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
    const assignments = data.sessions.filter((session) => session.dutyType !== 'on_call').flatMap((session) => [
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
    const assignments = data.sessions.filter((session) => session.dutyType !== 'on_call').flatMap((session) => [...(session.taAssignments || []), ...(session.doctorAssignments || [])].map((assignment) => ({
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
  const overall = data.sessions.reduce((acc, session) => ({
    needed: acc.needed + Number(session.taNeeded || 0) + Number(session.doctorNeeded || 0),
    gaps: acc.gaps + Number(session.taRemaining || 0) + Number(session.doctorRemaining || 0),
    open: acc.open + (session.taRemaining > 0 || session.doctorRemaining > 0 ? 1 : 0),
  }), { needed: 0, gaps: 0, open: 0 });

  const selectedSession = visibleSessions.find((session) => session.id === selectedSessionId) || null;
  const selectedEligibility = selectedSession ? eligibleBySession[selectedSession.id] || null : null;
  const selectedEligibilityLoading = selectedSession ? Boolean(eligibleLoadingBySession[selectedSession.id]) : false;
  const taManualOptions = useMemo(() => {
    if (selectedEligibility) {
      return (selectedEligibility.eligibleTAs || []).map((person) => ({
        id: person.id,
        label: `${person.name} (${((Number(person.projectedMinutes || 0)) / 60).toFixed(1)}h after)`,
      }));
    }
    return [];
  }, [selectedEligibility, data.taInvigilators]);
  const doctorManualOptions = useMemo(() => {
    if (selectedEligibility) {
      return (selectedEligibility.eligibleDoctors || []).map((person) => ({
        id: person.id,
        label: `${person.name} (${((Number(person.projectedMinutes || 0)) / 60).toFixed(1)}h after)`,
      }));
    }
    return [];
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

    let active = true;
    setEligibleLoadingBySession((current) => ({ ...current, [selectedSession.id]: true }));
    const request = selectedSession.dutyType === 'on_call'
      ? api.getOnCallEligible(selectedSession.date, selectedSession.startTime, selectedSession.endTime)
      : api.getSchedulingEligible(selectedSession.id);
    request
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
  }, [selectedSession, showToast]);

  function setSelectValue(sessionId, role, value) {
    setSelection((current) => ({ ...current, [`${sessionId}_${role}`]: value }));
  }

  function toggleSessionSelection(sessionId) {
    setSelectedSessionId((current) => (current === sessionId ? '' : sessionId));
  }

  async function assign(sessionId, role) {
    if (operationRunning.current) return;
    const invigilatorId = selection[`${sessionId}_${role}`];
    if (!invigilatorId) {
      showToast(`Choose a ${role} first.`, 'error');
      return;
    }
    operationRunning.current = true;
    setAssignmentSaving(true);
    try {
      let result;
      if (selectedSession?.dutyType === 'on_call') {
        result = await api.assignOnCall({ date: selectedSession.date, startTime: selectedSession.startTime, endTime: selectedSession.endTime, invigilatorId });
      } else result = await api.assignToSession({ sessionId, invigilatorId });
      showToast(`${role} assigned to session.${result.continuityWarning ? ` ${result.continuityWarning}` : ''}`, 'success');
      setSelection((current) => ({ ...current, [`${sessionId}_${role}`]: '' }));
      setPreviewResult(null);
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      operationRunning.current = false;
      setAssignmentSaving(false);
    }
  }

  async function autoSchedule() {
    if (operationRunning.current || !previewResult || shortageChoicesChanged || previewResult.previewMode !== previewMode || previewResult.roleScope !== roleScope) return;
    operationRunning.current = true;
    setAutoLoading(true);
    try {
      const result = previewResult.combined
        ? await api.applyCombinedScheduling(previewResult.planToken)
        : await api.autoSchedule(previewResult.planToken);
      setAutoResult(result);
      setPreviewResult(null);
      showToast(`Auto-scheduled ${result.placed} duties.`, 'success');
      setEligibleBySession({});
      setEligibleLoadingBySession({});
      await load();
      setWorkspace('calendar');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      operationRunning.current = false;
      setAutoLoading(false);
    }
  }

  async function previewAutoSchedule() {
    if (operationRunning.current) return;
    operationRunning.current = true;
    const sequence = ++previewSequence.current;
    setPreviewResult(null);
    setPreviewLoading(true);
    try {
      const result = buildScope !== 'sessions'
        ? await api.previewCombinedScheduling(previewMode, roleScope, buildScope, policyMode, policyMode === 'cover_shortage' ? shortageExcludedInvigilatorIds : [])
        : await api.autoSchedulePreview(previewMode, roleScope);
      if (sequence !== previewSequence.current) return;
      setPreviewResult(result);
      showToast('Auto-schedule preview completed. No data was saved.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      operationRunning.current = false;
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
      if (previewResult.combined) {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(previewResult.duties || []), 'CombinedAssignments');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(previewResult.staffLoads || []), 'StaffHours');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(previewResult.continuity || []), 'StaffContinuity');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(previewResult.defaultStaffBalance || []), 'DefaultStaffBalance');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(previewResult.optimizationStages || []), 'OptimizationStages');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet((previewResult.preferenceOrder || []).map((priority, index) => ({ rank: index + 1, priority, mode: previewResult.scoringMode, weight: previewResult.preferenceWeights?.[priority] ?? '' }))), 'PreferenceOrder');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(previewResult.engagementOverrides || []), 'EngagementOverrides');
        if (previewResult.policyMode === 'cover_shortage') XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(previewResult.policyOverrides || []), 'PolicyOverrides');
        if (previewResult.policyMode === 'cover_shortage') XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(previewResult.shortageExcludedStaff || []), 'ShortageExclusions');
        XLSX.writeFile(workbook, 'combined_schedule_preview.xlsx');
        showToast('Reviewed combined plan exported. No assignments were saved.', 'success');
        return;
      }
      const file = await api.exportAutoSchedulePreview(previewResult.planToken);
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
      if (selectedSession?.dutyType === 'on_call') await api.removeOnCallAssignment(assignmentId);
      else await api.removeSessionAssignment(assignmentId);
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
      <header className="panel schedule-overview">
        <div className="panel-head">
          <div><span className="schedule-eyebrow">EXAM OPERATIONS</span><h2>Schedule</h2><p>Find gaps, assign staff, and review changes before saving.</p></div>
          <div className="action-row">
            <Link className="ghost-btn" to="/staff-schedule">Staff schedule</Link>
            <button className="ghost-btn" type="button" onClick={exportCurrentSchedule} disabled={schedulingExportLoading || loading}>Export sessions</button>
            <button className="primary-btn" type="button" onClick={() => setWorkspace('build')} disabled={busy}>Build schedule</button>
          </div>
        </div>
        <div className="schedule-overview-stats" aria-live="polite">
          <div><span>Session & reserve periods</span><strong>{loading ? '…' : data.sessions.length}</strong><small>{dates.length} exam days</small></div>
          <div><span>Assigned duties</span><strong>{loading ? '…' : data.sessions.reduce((sum, session) => sum + session.taAssignments.length + session.doctorAssignments.length, 0)}</strong><small>{assignmentLockStats.locked} session locks</small></div>
          <div className={overall.gaps ? 'has-gaps' : ''}><span>Unfilled duties</span><strong>{loading ? '…' : overall.gaps}</strong><small>Across {overall.open} sessions</small></div>
          <div><span>Coverage</span><strong>{loading ? '…' : `${overall.needed ? Math.round(100 * Math.max(0, overall.needed - overall.gaps) / overall.needed) : 0}%`}</strong><small>Of required staffing</small></div>
        </div>
        <nav className="schedule-workflow-nav" aria-label="Scheduling views">
          {[['calendar', 'Schedule', 'Browse & assign'], ['build', 'Build schedule', 'Preview & save'], ['files', 'Excel', 'Import & export'], ['advanced', 'Advanced', 'Locks & backup']].map(([key, label, hint]) => (
            <button type="button" key={key} aria-current={workspace === key ? 'page' : undefined} onClick={() => setWorkspace(key)} disabled={busy}>
              <strong>{label}</strong><span>{hint}</span>
            </button>
          ))}
        </nav>
      </header>
      <div className="panel schedule-toolbar">
        {workspace === 'build' ? <>
        <div className="panel-head">
          <div>
            <span className="schedule-eyebrow">1 · CHOOSE SETTINGS</span>
            <h2>Build your schedule</h2>
            <p>Start with session needs, staff availability, and hour policies. Preview the changes before generating a saved schedule.</p>
          </div>
        </div>
        <div className="schedule-build-settings">
          <label className="form-field"><span>Which duties should be planned?</span><select value={buildScope} disabled={busy} onChange={(event) => { setBuildScope(event.target.value); setPreviewResult(null); }}><option value="combined">Sessions + on-call · balanced combined hours</option><option value="sessions">Sessions only · keep on-call fixed</option><option value="on_call">On-call only · keep sessions fixed</option></select></label>
          <label className="form-field"><span>What should happen to existing assignments?</span>
            <select value={previewMode} disabled={busy} onChange={(event) => { setPreviewMode(event.target.value); setPreviewResult(null); }}>
              <option value="preserve_all">Fill gaps · keep every current assignment</option>
              <option value="preserve_manual_only">Rebuild unlocked assignments · keep locks</option>
              <option value="rebalance_all">Rebuild everything · replace even locked assignments</option>
            </select>
          </label>
          <label className="form-field"><span>Who should be scheduled?</span>
            <select value={roleScope} disabled={busy} onChange={(event) => { setRoleScope(event.target.value); setPreviewResult(null); }}>
              <option value="both">Both TAs and Doctors</option>
              <option value="ta_only">TAs only</option>
              <option value="doctor_only">Doctors only</option>
            </select>
          </label>
        </div>
        {buildScope !== 'sessions' ? <label className="form-field"><span>Policy rules</span><select aria-label="Policy rules" value={policyMode} disabled={busy} onChange={(event) => { setPolicyMode(event.target.value); setPreviewResult(null); }}><option value="strict">Strict policies (default)</option><option value="cover_shortage">Cover shortages · allow policy overrides</option></select></label> : null}
        {buildScope !== 'sessions' && policyMode === 'cover_shortage' ? <p className="schedule-guidance is-warning">Optional shortage mode: staff without engagement-override permission or consecutive preferences may override exclusions and custom hour limits to improve coverage. Engagements can be overridden only when the staff checkbox allows it. Exam and other duty conflicts, roles, and explicit maximum hours remain strict. Sessions take priority. Review all exceptions before saving; saved availability and policies stay unchanged.</p> : null}
        {buildScope === 'combined' ? <p className="schedule-guidance">Priority: fill exam sessions first, then on-call. Balance total workloads, then share exam-session and on-call hours separately among default-policy staff within each role. Custom policies, exclusions and hour limits still apply. Engagements are flexible only when the staff policy allows overrides. “Rebuild unlocked” preserves session locks and every existing on-call choice.</p> : null}
        {buildScope === 'on_call' ? <p className="schedule-guidance">Session assignments stay fixed. Only on-call duties are planned, using each person’s total workload. Existing on-call choices stay fixed unless you choose Rebuild everything.</p> : null}
        <p className={`schedule-guidance${previewMode === 'rebalance_all' ? ' is-warning' : ''}`}>
          {previewMode === 'preserve_all' ? 'Current assignments stay fixed. Choose this to fill remaining gaps. To redistribute hours after changing a policy, choose a rebuild option.' : previewMode === 'preserve_manual_only' ? 'Locked assignments stay fixed. All unlocked assignments can be replaced to balance staffing.' : 'All assignments in the selected role scope can be replaced, including locked assignments.'}
          {roleScope !== 'both' ? ` ${roleScope === 'ta_only' ? 'Doctor' : 'TA'} assignments stay fixed.` : ''}
        </p>
        <p className="muted">Scheduling covers all exam dates and rooms. The date and room filters in Browse sessions only change what you see.</p>
        <p><a href="/scheduling-rules">Edit scheduling priorities and on-call rules</a>. New previews use the saved settings.</p>
        <div className="schedule-preparation"><span>Check your inputs:</span><Link to="/sessions">Sessions & needs</Link><Link to="/invigilators">Staff</Link><Link to="/engagements">Availability</Link><Link to="/staff-hour-policy">Hour policies</Link></div>
        <div className="schedule-preview-action"><div><span className="schedule-eyebrow">2 · REVIEW A PREVIEW</span><p>See expected coverage and staffing changes. Preview does not save assignments.</p></div>
          <button type="button" className="primary-btn" onClick={previewAutoSchedule} disabled={busy || loading || !overall.needed || !(data.taInvigilators.length + data.doctorInvigilators.length)}>{previewLoading ? 'Calculating preview…' : previewResult ? 'Run preview again' : 'Preview schedule'}</button>
        </div>
        {!loading && !overall.needed ? <p className="schedule-guidance is-warning">Add staffing needs in Sessions before building a schedule.</p> : null}
        </> : null}
        {workspace === 'calendar' ? <div className="panel-head"><div><h2>Browse sessions</h2><p>Manage session and on-call assignments here. Reserve duties share staff hours and conflict checks with sessions.</p></div><div className="schedule-view-switch" aria-label="Schedule display">{['list', 'calendar'].map((view) => <button type="button" key={view} aria-pressed={scheduleView === view} onClick={() => setScheduleView(view)}>{view === 'list' ? 'Session list' : 'Timeline'}</button>)}</div></div> : null}
        {loading ? <div className="empty-state small">Loading scheduling data...</div> : null}
        {workspace === 'calendar' && dates.length ? (
          <div className="schedule-date-toolbar">
            <div className="schedule-date-summary">
              <strong>Visible Days</strong>
              <span>
                {focusDate ? `${focusDate} only` : `${safeDatePageStart + 1}-${Math.min(safeDatePageStart + visibleDateCount, dates.length)} of ${dates.length}`}
              </span>
            </div>
            <div className="schedule-smart-tools">
              <select aria-label="Duty type" value={dutyFilter} onChange={(event) => { setDutyFilter(event.target.value); setRoomFilter(''); }} className="schedule-filter-select"><option value="all">Sessions + on-call</option><option value="sessions">Sessions only</option><option value="on_call">On-call only</option></select>
              <select aria-label="Exam date" value={focusDate} onChange={(event) => setFocusDate(event.target.value)} className="schedule-filter-select">
                <option value="">Paged view</option>
                {dates.map((date) => (
                  <option key={date} value={date}>{date}</option>
                ))}
              </select>
              <select aria-label="Room" value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)} className="schedule-filter-select">
                <option value="">All rooms</option>
                {availableRooms.map((room) => (
                  <option key={room} value={room}>{room}</option>
                ))}
              </select>
              {scheduleView === 'calendar' ? <select aria-label="Timeline density" value={density} onChange={(event) => setDensity(event.target.value)} className="schedule-filter-select">
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
                <option value="wide">Wide</option>
              </select> : null}
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
        {workspace === 'calendar' ? <div className="schedule-kpis">
          <div className="info-chip"><strong>Visible sessions</strong><span>{visibleSessions.length}</span></div>
          <div className="info-chip"><strong>TA gaps</strong><span>{openSummary.ta}</span></div>
          <div className="info-chip"><strong>Doctor gaps</strong><span>{openSummary.doctor}</span></div>
          {selectedSession ? (
            <div className="info-chip"><strong>Selected</strong><span>{courseLabel(selectedSession)}</span></div>
          ) : null}
        </div> : null}
        {workspace === 'files' ? <>
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
          </div>
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="panel-head">
            <div>
              <h3>Scheduling Import</h3>
              <p>1. Download a template above. 2. Edit it in Excel. 3. Upload, review, then apply. Only session assignments are changed.</p>
            </div>
          </div>
          <div className="action-row">
            <label className="form-field"><span>Workbook format</span><select value={importFormat} disabled={busy} onChange={(event) => setImportFormat(event.target.value)}><option value="actions">Assignment actions · add, remove, lock or unlock</option><option value="committee">Committee assignments · staff by session</option></select></label>
            {importFormat === 'actions' ? <><label className="ghost-btn">
              {assignmentImportLoading ? 'Validating...' : 'Import Assignment Actions'}
              <input type="file" accept=".xlsx,.xls" disabled={busy} style={{ display: 'none' }} onChange={importAssignmentActions} />
            </label>
            <button type="button" className="ghost-btn" onClick={clearAssignmentImport} disabled={assignmentImportLoading || (!assignmentImportSummary && !pendingAssignmentActionRows.length)}>Clear review</button>
            </> : <>
            <label className="ghost-btn">
              {committeeImportLoading ? 'Validating Committee...' : 'Import Committee Assignments'}
              <input type="file" accept=".xlsx,.xls" disabled={busy} style={{ display: 'none' }} onChange={importCommitteeAssignments} />
            </label>
            <button type="button" className="ghost-btn" onClick={clearCommitteeImport} disabled={committeeImportLoading || (!committeeImportSummary && !pendingCommitteeRows.length)}>
              Clear review
            </button>
            </>}
          </div>
          {importFormat === 'committee' ? <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              marginTop: 12,
            }}
          >
            <label className="form-field">
              <span>Committee Import Mode</span>
              <select value={committeeImportMode} disabled={busy} onChange={(event) => { setCommitteeImportMode(event.target.value); clearCommitteeImport(); }}>
                <option value="append">Append</option>
                <option value="replace_matching_sessions">Replace Matching Sessions</option>
              </select>
            </label>
          </div> : null}
          <div className="schedule-run-status-detail" style={{ marginTop: 8 }}>
            This import affects Scheduling assignments only. It does not create sessions or invigilators.
          </div>
          {importFormat === 'actions' && assignmentImportSummary ? (
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
                <button type="button" className="primary-btn" onClick={applyAssignmentImport} disabled={assignmentImportLoading || !assignmentImportSummary.dryRun || assignmentImportConfirmText.trim().toUpperCase() !== 'IMPORT'}>
                  {assignmentImportLoading ? 'Applying...' : 'Apply Import'}
                </button>
              </div>
            </div>
          ) : null}
          {importFormat === 'committee' && committeeImportSummary ? (
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
                <button type="button" className="primary-btn" onClick={applyCommitteeImport} disabled={committeeImportLoading || !committeeImportSummary.dryRun || committeeImportConfirmText.trim().toUpperCase() !== 'IMPORT'}>
                  {committeeImportLoading ? 'Applying...' : 'Apply Committee Import'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        </> : null}
        {workspace === 'advanced' ? <>
        <div className="panel-head"><div><h2>Locks & maintenance</h2><p>Lock assignments you want to keep when rebuilding unlocked duties.</p></div></div>
        <div className="action-row">
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => bulkSetAssignmentLock(allCurrentAssignmentIds, true, 'No assignments to lock.')}>Lock all current assignments</button>
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => bulkSetAssignmentLock(autoAssignmentIds, false, 'No auto assignments to unlock.')}>Unlock automatically assigned duties</button>
        </div>
        <details className="schedule-disclosure">
          <summary>Full system backup</summary>
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
        </details>
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
        <details className="schedule-disclosure schedule-danger-zone"><summary>Remove assignments</summary><p>Remove all saved session assignments. Sessions and staffing needs remain.</p><button type="button" className="danger-btn" disabled={busy} onClick={removeAll}>Remove all session assignments</button></details>
        </> : null}
        {(workspace === 'build' || workspace === 'calendar') && autoResult ? (
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
        {workspace === 'build' && previewResult ? (
          <div className="schedule-run-status tone-warning" style={{ marginTop: 12 }}>
            <div className="schedule-run-status-main">
              <span className="schedule-status-pill tone-warning">PREVIEW ONLY</span>
              <strong>Review the expected changes</strong>
            </div>
            <div className="schedule-run-status-detail">{previewResult.note || 'Preview only. No data was saved.'}</div>
            {previewResult.preferenceOrder?.length ? <details className="schedule-disclosure" open>
              <summary>Applied scheduling preferences</summary>
              <p>{previewResult.scoringMode === 'weighted' ? `Weighted points: ${Number(previewResult.preferenceScore || 0).toFixed(2)} penalty points. The order below breaks score ties.` : 'Priority order: higher preferences win conflicts.'}</p>
              <ol>{previewResult.preferenceOrder.map((key) => <li key={key}>{priorityLabels[key]}{previewResult.scoringMode === 'weighted' ? ` (${previewResult.preferenceWeights?.[key] ?? 0} points)` : ''}</li>)}</ol>
              {previewResult.preferenceRepair ? <p>{previewResult.preferenceRepair.exchanges} duty exchanges made while preserving every staff member's total, session and on-call hours. Consecutive-day gaps: {previewResult.preferenceRepair.before.consecutive_days} to {previewResult.preferenceRepair.after.consecutive_days}; idle minutes: {previewResult.preferenceRepair.before.consecutive_duties} to {previewResult.preferenceRepair.after.consecutive_duties}.</p> : null}
            </details> : null}
            {previewResult.optimizationStages?.length ? <details className="schedule-disclosure">
              <summary>Scheduling steps ({Number(previewResult.optimizationSeconds || 0).toFixed(1)} seconds)</summary>
              <p className="muted">Each step keeps the best feasible plan from earlier steps. A time-limited step may retain that plan without improving it.</p>
              <div className="table-wrap"><table><thead><tr><th>Step</th><th>Status</th><th>Elapsed seconds</th></tr></thead><tbody>{previewResult.optimizationStages.map((row) => <tr key={row.stage}><td>{row.stage.replaceAll('_', ' ')}</td><td>{row.status}</td><td>{row.elapsedSeconds}</td></tr>)}</tbody></table></div>
            </details> : null}
            {previewResult.engagementOverrides?.length ? <details className="schedule-disclosure" open>
              <summary>Engagement overrides ({previewResult.engagementOverrides.length})</summary>
              <p className="muted">Allowed by the staff policy to fill shortages or balance workload. Engagement records are retained; other policies and duty conflicts still apply.</p>
              <div className="table-wrap"><table><thead><tr><th>Staff ID</th><th>Duty</th><th>Date</th><th>Time</th><th>Engagement overlap (minutes)</th><th>Reason</th></tr></thead><tbody>{previewResult.engagementOverrides.map((row, index) => <tr key={index}><td>{row.staffId}</td><td>{row.dutyType === 'on_call' ? 'On-call' : 'Session'}</td><td>{row.date}</td><td>{row.startTime} - {row.endTime}</td><td>{row.overlapMinutes}</td><td>{row.reason}</td></tr>)}</tbody></table></div>
            </details> : null}
            {previewResult.defaultStaffBalance?.length ? <details className="schedule-disclosure" open>
              <summary>Default staff: session and on-call balance</summary>
              <p className="muted">Compared within each role. Existing locks, availability and hour limits can leave differences. Exam coverage takes priority over on-call coverage.</p>
              <div className="table-wrap"><table><thead><tr><th>Role</th><th>Duty</th><th>Default staff</th><th>Average H</th><th>Minimum H</th><th>Maximum H</th><th>Spread H</th></tr></thead><tbody>{previewResult.defaultStaffBalance.map((row) => <tr key={`${row.role}-${row.dutyType}`}><td>{row.role}</td><td>{row.dutyType === 'on_call' ? 'On-call' : 'Sessions'}</td><td>{row.staffCount}</td><td>{Number(row.averageHours).toFixed(2)}</td><td>{Number(row.minimumHours).toFixed(2)}</td><td>{Number(row.maximumHours).toFixed(2)}</td><td>{Number(row.spreadHours).toFixed(2)}</td></tr>)}</tbody></table></div>
            </details> : null}
            {previewResult.continuity?.length ? <details className="schedule-disclosure" open>
              <summary>Consecutive duties and working days</summary>
              {previewResult.continuity.some((row) => (row.preferConsecutiveDays && row.workingDayGaps > 0) || (row.preferConsecutiveDuties && row.idleMinutes > 0)) ? <div className="schedule-guidance is-warning" role="status">
                <strong>Some consecutive preferences remain unmet.</strong>{' '}
                {previewResult.scoringMode === 'weighted' ? 'The saved points weights determine which preferences win.' : 'Preferences higher in the saved order can take priority over closing these gaps.'}{' '}
                Coverage, workload balance, and hard staff policies remain protected.{' '}
                <Link to="/scheduling-rules">Review scheduling priorities</Link> before generating another preview.
              </div> : null}
              {previewResult.preferenceRepair?.timeLimited ? <p className="schedule-guidance is-warning">The duty-exchange search reached its time limit. Further improvements may exist; the gaps shown are not proven unavoidable.</p> : null}
              <p className="muted">Preferences respect other staff policies and duty conflicts. Engagements are flexible only when the staff policy allows overrides. Coverage and balanced total and on-call workloads take priority; extra reserve duties are not assigned just to close gaps. Days off counts calendar days between the first and last working date; idle minutes counts gaps within working days across all duty types.</p>
              <div className="table-wrap"><table><thead><tr><th>Staff ID</th><th>Consecutive duties</th><th>Consecutive days</th><th>Days off between dates</th><th>Idle minutes</th></tr></thead><tbody>{previewResult.continuity.map((row) => <tr key={row.staffId}><td>{row.staffId}</td><td>{row.preferConsecutiveDuties ? 'Preferred' : 'Off'}</td><td>{row.preferConsecutiveDays ? 'Preferred' : 'Off'}</td><td>{row.workingDayGaps}</td><td>{row.idleMinutes}</td></tr>)}</tbody></table></div>
            </details> : null}
            {previewResult.policyMode === 'cover_shortage' ? <details className="schedule-disclosure" open><summary>Review shortage staff · keep or exclude</summary><p className="muted">Review the proposed staff below. Keep accepts their proposed assignments; Exclude prevents new assignments for that person when you recalculate. Existing assignments stay fixed according to your rebuild setting. These choices apply only to this plan.</p><div className="table-wrap schedule-combined-loads"><table><thead><tr><th>Staff</th><th>Role</th><th>New duties</th><th>Exceptions</th><th>Your choice</th></tr></thead><tbody>{(previewResult.shortageStaff || []).map((person) => <tr key={person.id}><td>{person.name} <small>{person.staffId}</small></td><td>{person.role}</td><td>{person.newDuties}</td><td>{person.overrides}</td><td><select aria-label={`Shortage choice for ${person.name}`} disabled={busy} value={shortageExcludedInvigilatorIds.includes(person.id) ? 'exclude' : 'keep'} onChange={(event) => { const exclude = event.target.value === 'exclude'; setShortageExcludedInvigilatorIds((ids) => exclude ? [...new Set([...ids, person.id])] : ids.filter((id) => id !== person.id)); }}><option value="keep">Keep</option><option value="exclude">Exclude</option></select></td></tr>)}</tbody></table></div>{!(previewResult.shortageStaff || []).length ? <p>No new shortage assignments were proposed.</p> : null}{shortageChoicesChanged ? <p className="schedule-guidance is-warning">Staff choices changed. Recalculate shortage filling to review replacements and remaining gaps before saving.</p> : null}<button type="button" className="primary-btn" disabled={busy || !shortageChoicesChanged} onClick={previewAutoSchedule}>Recalculate shortage filling</button></details> : null}
            {previewResult.roleScopedNote ? (
              <div className="schedule-run-status-detail">{previewResult.roleScopedNote}</div>
            ) : null}
            {previewResult.policyMode === 'cover_shortage' ? <details className="schedule-disclosure" open><summary>Policy overrides ({previewResult.policyOverrides?.length || 0})</summary><p className="muted">These exceptions are included in this reviewed plan. Existing assignments may also appear. Policies and availability records are not edited.</p>{previewResult.policyOverrides?.length ? <div className="table-wrap schedule-combined-loads"><table><thead><tr><th>Staff</th><th>Duty</th><th>Date / time</th><th>Rule overridden</th><th>Details</th></tr></thead><tbody>{previewResult.policyOverrides.map((item, index) => <tr key={index}><td>{item.Name} <small>{item.StaffID}</small></td><td>{item.DutyType || 'Total hours'}</td><td>{item.Date ? `${item.Date} ${item.Start}–${item.End}` : 'All dates'}</td><td>{item.Rule}</td><td>{item.Detail}</td></tr>)}</tbody></table></div> : <p>No policy overrides are needed for this plan.</p>}</details> : null}
            {previewResult.shortageExcludedStaff?.length ? <p className="schedule-guidance">Excluded from new shortage assignments: {previewResult.shortageExcludedStaff.map((person) => `${person.Name} (${person.StaffID})`).join(', ')}.</p> : null}
            <div className="schedule-preview-summary">
              <div><span>Unfilled duties</span><strong>{previewResult.currentTotalShortage ?? overall.gaps} → {previewResult.previewTotalShortage ?? previewResult.totalShortage ?? 0}</strong></div>
              <div><span>Assignments to add</span><strong>{previewResult.assignmentsWouldCreate ?? 0}</strong></div>
              <div><span>Assignments to remove</span><strong>{previewResult.assignmentsWouldRemove ?? 0}</strong></div>
              <div><span>Assignments to keep</span><strong>{previewResult.assignmentsWouldKeep ?? 0}</strong></div>
            </div>
            {previewResult.combined ? <>
              <div className="chips-wrap"><div className="info-chip"><strong>Session gaps</strong><span>{previewResult.sessionShortage}</span></div><div className="info-chip"><strong>On-call gaps</strong><span>{previewResult.onCallShortage}</span></div></div>
              <details className="schedule-disclosure" open><summary>Combined hours by staff</summary><p className="muted">Session and on-call hours are balanced together. Other duties also consume each person’s hour limit.</p><div className="table-wrap schedule-combined-loads"><table><thead><tr><th>Staff</th><th>Role</th><th>Current H</th><th>Session H</th><th>On-call H</th><th>Other H</th><th>Planned total H</th><th>Target H</th></tr></thead><tbody>{(previewResult.staffLoads || []).map((person) => <tr key={person.staffId}><td>{person.name} <small>{person.staffId}</small></td><td>{person.role}</td><td>{Number(person.currentHours).toFixed(2)}</td><td>{Number(person.sessionHours).toFixed(2)}</td><td>{Number(person.onCallHours).toFixed(2)}</td><td>{Number(person.otherHours).toFixed(2)}</td><td>{Number(person.totalHours).toFixed(2)}</td><td>{Number(person.targetHours).toFixed(2)}</td></tr>)}</tbody></table></div></details>
            </> : null}
            <div className="action-row" style={{ marginTop: 8 }}>
              <button type="button" className="ghost-btn" onClick={exportPreviewResult} disabled={previewExportLoading || shortageChoicesChanged}>
                {previewExportLoading ? 'Exporting Preview...' : previewResult.combined ? 'Export reviewed plan' : 'Export fresh preview'}
              </button>
            </div>
            {previewResult.assignmentModeSupport && !previewResult.assignmentModeSupport.supportsPreserveManualOnly ? (
              <div className="schedule-run-status-detail">{previewResult.assignmentModeSupport.reason}</div>
            ) : null}
            {!previewResult.combined ? <details className="schedule-disclosure"><summary>Staff-hour comparison & scheduling details</summary>
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
            </details> : null}
            <div className="schedule-preview-action"><div><span className="schedule-eyebrow">{previewResult.combined ? '3. SAVE REVIEWED PLAN' : '3. GENERATE & SAVE'}</span><p>{previewResult.combined ? 'Save the exact session and on-call plan shown above. If data changes or the preview expires, run preview again.' : 'This runs scheduling again using these settings and saves the result. Placements can differ from the preview. Exporting a fresh preview also runs the calculation again.'}</p></div>
              <button type="button" className="primary-btn" onClick={autoSchedule} disabled={busy || !previewResult || shortageChoicesChanged || previewResult.previewMode !== previewMode || previewResult.roleScope !== roleScope}>{autoLoading ? 'Saving…' : 'Save reviewed plan'}</button>
            </div>
          </div>
        ) : null}
      </div>

      {workspace === 'calendar' ? (!dates.length ? (
        <div className="panel empty-state">No sessions available yet. Import or create sessions first.</div>
      ) : (
        <div
          className={`schedule-workspace density-${density}${selectedSession ? '' : ' no-selection'}`}
          style={{
            '--schedule-date-width': `${dateColumnWidth}px`,
            '--schedule-column-count': `${timeColumnCount}`
          }}
        >
          {scheduleView === 'list' ? (
            <div className="panel schedule-session-list">
              <div className="table-wrap"><table>
                <thead><tr><th>Date & time</th><th>Room</th><th>Courses</th><th>TA</th><th>Doctor</th><th>Status</th><th /></tr></thead>
                <tbody>{[...visibleSessions].sort((a, b) => `${a.date} ${a.startTime} ${a.room}`.localeCompare(`${b.date} ${b.startTime} ${b.room}`)).map((session) => (
                  <tr key={session.id} className={selectedSessionId === session.id ? 'is-selected' : ''}>
                    <td><strong>{formatDateLabel(session.date)}</strong><small>{session.startTime}–{session.endTime}</small></td><td>{session.room || '—'}</td><td>{courseLabel(session)}</td>
                    <td>{session.taAssignments.length}/{session.taNeeded}</td><td>{session.doctorAssignments.length}/{session.doctorNeeded}</td>
                    <td><span className={`schedule-status-pill tone-${session.taRemaining + session.doctorRemaining > 0 ? 'warning' : 'success'}`}>{session.taRemaining + session.doctorRemaining > 0 ? `${session.taRemaining + session.doctorRemaining} unfilled` : 'Covered'}</span></td>
                    <td><button type="button" className="ghost-btn" aria-label={`Manage ${session.room} on ${session.date} at ${session.startTime}`} aria-expanded={selectedSessionId === session.id} onClick={() => toggleSessionSelection(session.id)}>{selectedSessionId === session.id ? 'Close' : 'Manage'}</button></td>
                  </tr>
                ))}</tbody>
              </table></div>
              {!visibleSessions.length ? <div className="empty-state">No sessions match these filters. Try another date or room, or turn off the uncovered filter.</div> : null}
            </div>
          ) : <div className="schedule-calendar-shell">
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
                            role="button"
                            tabIndex={0}
                            aria-label={`Manage ${session.room} on ${session.date} at ${session.startTime}`}
                            aria-expanded={session.id === selectedSessionId}
                            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleSessionSelection(session.id); } }}
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
          </div>}

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
                <div className="info-chip"><strong>Eligible TA</strong><span>{selectedSession.eligibleTACount ?? (selectedEligibility?.eligibleTAs?.length || 0)}</span></div>
                  <div className="info-chip"><strong>Eligible Doctor</strong><span>{selectedSession.eligibleDoctorCount ?? (selectedEligibility?.eligibleDoctors?.length || 0)}</span></div>
                </div>
                <button type="button" className="ghost-btn" onClick={() => setSelectedSessionId('')}>Close session</button>
                {selectedEligibilityLoading ? <p className="muted" role="status">Checking staff availability and hour policies…</p> : null}
                {!selectedEligibilityLoading && !selectedEligibility ? (
                  <p className="muted">Candidates could not be loaded. <button type="button" className="ghost-btn" onClick={() => load().catch((error) => showToast(error.message, 'error'))}>Retry</button></p>
                ) : null}
                {!selectedEligibilityLoading && selectedEligibility && !selectedEligibility.eligibleTAs?.length && !selectedEligibility.eligibleDoctors?.length ? (
                  <p className="muted">No eligible staff are available. Check availability, hour policies, and conflicting assignments.</p>
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
                      <button type="button" className="btn btn-primary" disabled={assignmentSaving || selectedEligibilityLoading || !taManualOptions.some((person) => person.id === selection[`${selectedSession.id}_TA`]) || selectedSession.taRemaining <= 0} onClick={() => assign(selectedSession.id, 'TA')}>Assign TA</button>
                    </div>
                    <div className="calendar-assignment-list">
                      {selectedSession.taAssignments.map((assignment) => (
                        <div key={assignment.id} className="calendar-assignment-row">
                          <span>
                            {assignment.invigilator?.name || 'Unknown'} (TA)
                            <small className="muted"> [{assignment.assignmentSource || 'legacy'} / {assignment.locked ? 'locked' : 'unlocked'}]</small>
                          </span>
                          {selectedSession.dutyType !== 'on_call' ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAssignmentLock(assignment.id, !assignment.locked)}>
                            {assignment.locked ? 'Unlock' : 'Lock'}
                          </button> : null}
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
                      <button type="button" className="btn btn-primary" disabled={assignmentSaving || selectedEligibilityLoading || !doctorManualOptions.some((person) => person.id === selection[`${selectedSession.id}_Doctor`]) || selectedSession.doctorRemaining <= 0} onClick={() => assign(selectedSession.id, 'Doctor')}>Assign Doctor</button>
                    </div>
                    <div className="calendar-assignment-list">
                      {selectedSession.doctorAssignments.map((assignment) => (
                        <div key={assignment.id} className="calendar-assignment-row">
                          <span>
                            {assignment.invigilator?.name || 'Unknown'} (Doctor)
                            <small className="muted"> [{assignment.assignmentSource || 'legacy'} / {assignment.locked ? 'locked' : 'unlocked'}]</small>
                          </span>
                          {selectedSession.dutyType !== 'on_call' ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAssignmentLock(assignment.id, !assignment.locked)}>
                            {assignment.locked ? 'Unlock' : 'Lock'}
                          </button> : null}
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
      )) : null}
    </div>
  );
}
