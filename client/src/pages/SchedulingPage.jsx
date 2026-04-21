import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api';
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

function getImportSessionKey(row) {
  const courses = getImportCourses(row).map((item) => item.toLowerCase()).join(';');
  return [
    normalizeImportDate(row.Date ?? row.date ?? row.exam_date ?? '', row.Day ?? row.day ?? ''),
    normalizeImportTime(row.Start ?? row.startTime ?? row.start_time ?? ''),
    normalizeImportTime(row.End ?? row.endTime ?? row.end_time ?? ''),
    getImportRoom(row).toLowerCase(),
    courses
  ].join('|');
}

function getImportSessionTimeRoomKey(row) {
  return [
    normalizeImportDate(row.Date ?? row.date ?? row.exam_date ?? '', row.Day ?? row.day ?? ''),
    normalizeImportTime(row.Start ?? row.startTime ?? row.start_time ?? ''),
    normalizeImportTime(row.End ?? row.endTime ?? row.end_time ?? ''),
    getImportRoom(row).toLowerCase()
  ].join('|');
}

function mergeImportSessionsByRoomTime(rows) {
  const grouped = new Map();

  rows.forEach((row) => {
    const key = getImportSessionTimeRoomKey(row);
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

export default function SchedulingPage() {
  const [data, setData] = useState({ sessions: [], taInvigilators: [], doctorInvigilators: [] });
  const [selection, setSelection] = useState({});
  const [autoResult, setAutoResult] = useState(null);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [datePageStart, setDatePageStart] = useState(0);
  const [visibleDateCount, setVisibleDateCount] = useState(4);
  const [focusDate, setFocusDate] = useState('');
  const [onlyOpenNeeds, setOnlyOpenNeeds] = useState(false);
  const [density, setDensity] = useState('comfortable');
  const [roomFilter, setRoomFilter] = useState('');
  const showToast = useToast();

  async function load() {
    const response = await api.getScheduling();
    setData(response);
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

  const openSummary = visibleSessions.reduce((acc, session) => ({
    ta: acc.ta + session.taRemaining,
    doctor: acc.doctor + session.doctorRemaining
  }), { ta: 0, doctor: 0 });

  const selectedSession = visibleSessions.find((session) => session.id === selectedSessionId) || null;
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
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function autoSchedule() {
    try {
      const result = await api.autoSchedule();
      setAutoResult(result);
      showToast(`Auto-scheduled ${result.placed} duties.`, 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function exportWorkbook() {
    try {
      const file = await api.exportWorkbook();
      window.open(file.url, '_blank');
      showToast('Scheduling workbook exported.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function importWorkbook(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sessions = getSheetRows(workbook, ['Sessions']);
      const sessionNeeds = getSheetRows(workbook, ['SessionNeeds', 'Needs', 'Session Needs']);
      const invigilators = getSheetRows(workbook, ['Invigilators', 'Staff']);
      const engagements = getSheetRows(workbook, ['Engagements']);
      const assignments = getSheetRows(workbook, ['Assignments']);
      const superAssignments = getSheetRows(workbook, ['Super', 'SuperAssignments']);
      const controlSessions = getSheetRows(workbook, ['ControlSessions', 'Control']);
      const controlAssignments = getSheetRows(workbook, ['ControlAssignments']);

      const importedSessions = mergeImportSessionsByRoomTime(sessions);

      const sessionsById = new Map(importedSessions.map((session) => [String(session.id), session]));
      const sessionsByKey = new Map(importedSessions.map((session) => [getImportSessionKey({
        CourseCodes: session.courseName,
        Room: session.room,
        Date: session.date,
        Start: session.startTime,
        End: session.endTime
      }), session]));
      const needsRows = sessionNeeds.length ? sessionNeeds : sessions;
      needsRows.forEach((row) => {
        const sessionId = String(row.SessionID ?? row.sessionId ?? row.id ?? '').trim();
        const session = sessionsById.get(sessionId)
          || importedSessions.find((item) => getImportSessionTimeRoomKey({
            Room: item.room,
            Date: item.date,
            Start: item.startTime,
            End: item.endTime
          }) === getImportSessionTimeRoomKey(row))
          || sessionsByKey.get(getImportSessionKey(row));
        if (!session) return;
        session.taNeeded = Number(row.TANeeded ?? row.taNeeded ?? row.ta_needed ?? row.InvigilatorsNeeded ?? session.taNeeded ?? 0);
        session.doctorNeeded = Number(row.DoctorNeeded ?? row.doctorNeeded ?? row.doctor_needed ?? session.doctorNeeded ?? 0);
        session.totalNeeded = Number(row.InvigilatorsNeeded ?? row.totalNeeded ?? row.total_needed ?? (session.taNeeded + session.doctorNeeded));
      });

      await api.importData({
        sessions: importedSessions,
        invigilators: invigilators.map((row, index) => ({
          id: row.id || `inv_import_${index + 1}`,
          staffId: String(row.StaffID ?? row.staffId ?? row.staff_id ?? '').trim(),
          name: String(row.Name ?? row.name ?? '').trim(),
          email: String(row.Email ?? row.email ?? '').trim(),
          role: String(row.Role ?? row.role ?? 'TA').trim() || 'TA',
          loadType: String(row.LoadType ?? row.loadType ?? row.load_type ?? 'full').trim() || 'full',
          maxHours: Number(row.MaxHours ?? row.maxHours ?? row.max_hours ?? 0),
          department: String(row.Department ?? row.department ?? '').trim(),
          notes: String(row.Notes ?? row.notes ?? '').trim()
        })),
        engagements: engagements.map((row, index) => ({
          id: row.id || `eng_import_${index + 1}`,
          staffId: String(row.StaffID ?? row.staffId ?? row.staff_id ?? '').trim(),
          date: normalizeImportDate(row.Date ?? row.date ?? row.exam_date ?? '', row.Day ?? row.day ?? ''),
          startTime: normalizeImportTime(row.Start ?? row.startTime ?? row.start_time ?? ''),
          endTime: normalizeImportTime(row.End ?? row.endTime ?? row.end_time ?? ''),
          engagement: Number(row.Engagement ?? row.engagement ?? 1),
          notes: String(row.Notes ?? row.notes ?? '').trim()
        })),
        assignments: assignments.map((row, index) => ({
          id: row.id || `asg_import_${index + 1}`,
          sessionId: String(row.sessionId ?? row.session_id ?? row.SessionID ?? '').trim(),
          invigilatorId: String(row.invigilatorId ?? row.staff_id ?? row.staffId ?? row.StaffID ?? '').trim(),
          role: String(row.role ?? row.Role ?? '').trim()
        })).filter((row) => row.sessionId && row.invigilatorId),
        superAssignments: superAssignments.map((row, index) => ({
          id: row.id || `sup_import_${index + 1}`,
          date: normalizeImportDate(row.date ?? row.exam_date ?? row.Date ?? '', row.Day ?? row.day ?? ''),
          invigilatorId: String(row.invigilatorId ?? row.staff_id ?? row.staffId ?? row.StaffID ?? '').trim()
        })).filter((row) => row.date && row.invigilatorId),
        controlSessions: controlSessions.map((row, index) => ({
          id: row.id || `ctlses_import_${index + 1}`,
          courseNames: String(row.CourseCodes ?? row.courseCodes ?? row.CourseCode ?? row.courseCode ?? row.Courses ?? row.courses ?? row.CourseNames ?? row.CourseName ?? row.courseNames ?? row.courseName ?? '').split(/[\n;,]+/).map((item) => item.trim()).filter(Boolean),
          courseName: String(row.CourseCodes ?? row.courseCodes ?? row.CourseCode ?? row.courseCode ?? row.Courses ?? row.courses ?? row.CourseNames ?? row.CourseName ?? row.courseNames ?? row.courseName ?? '').split(/[\n;,]+/).map((item) => item.trim()).filter(Boolean).join('; '),
          room: String(row.RoomPlacement ?? row.roomPlacement ?? row.Room ?? row.room ?? '').trim(),
          date: normalizeImportDate(row.Date ?? row.date ?? row.exam_date ?? '', row.Day ?? row.day ?? ''),
          startTime: normalizeImportTime(row.Start ?? row.startTime ?? row.start_time ?? ''),
          endTime: normalizeImportTime(row.End ?? row.endTime ?? row.end_time ?? ''),
          taNeeded: Number(row.TANeeded ?? row.taNeeded ?? row.ta_needed ?? 0),
          doctorNeeded: Number(row.DoctorNeeded ?? row.doctorNeeded ?? row.doctor_needed ?? 0),
          totalNeeded: Number(row.InvigilatorsNeeded ?? row.totalNeeded ?? row.total_needed ?? 0),
          notes: String(row.Notes ?? row.notes ?? '').trim()
        })),
        controlAssignments: controlAssignments.map((row, index) => ({
          id: row.id || `ctlasg_import_${index + 1}`,
          controlSessionId: String(row.controlSessionId ?? row.control_session_id ?? row.ControlSessionID ?? '').trim(),
          invigilatorId: String(row.invigilatorId ?? row.staff_id ?? row.staffId ?? row.StaffID ?? '').trim(),
          role: String(row.role ?? row.Role ?? '').trim()
        })).filter((row) => row.controlSessionId && row.invigilatorId)
      });

      showToast('Workbook imported.', 'success');
      setSelectedSessionId('');
      setAutoResult(null);
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }

    event.target.value = '';
  }

  function downloadTemplate() {
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      {
        Room: '324 R PH',
        CourseCode: 'BME407',
        Date: '6/1/2026',
        Start: '09:30',
        End: '11:30'
      }
    ]), 'Sessions');

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      {
        SessionID: 'ses_import_1',
        Room: '324 R PH',
        Date: '6/1/2026',
        Start: '09:30',
        End: '11:30',
        TANeeded: 1,
        DoctorNeeded: 1,
        InvigilatorsNeeded: 2
      }
    ]), 'SessionNeeds');

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      {
        StaffID: '1001',
        Name: 'Dr. Ahmed Ali',
        Email: 'ahmed.ali@university.edu',
        Role: 'Doctor',
        LoadType: 'full',
        MaxHours: 12,
        Department: 'Civil Engineering',
        Notes: 'Example staff'
      },
      {
        StaffID: '2001',
        Name: 'Mona Hassan',
        Email: 'mona.hassan@university.edu',
        Role: 'TA',
        LoadType: 'full',
        MaxHours: 8,
        Department: 'Civil Engineering',
        Notes: 'Example staff'
      }
    ]), 'Invigilators');

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      {
        StaffID: '1001',
        Date: '2026-06-15',
        Start: '12:00',
        End: '13:00',
        Engagement: 1,
        Notes: 'Example engagement'
      }
    ]), 'Engagements');

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { sessionId: '', invigilatorId: '', role: '' }
    ]), 'Assignments');

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { date: '', invigilatorId: '' }
    ]), 'Super');

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      {
        CourseName: 'Control Session',
        Room: 'Control',
        Date: '2026-06-15',
        Start: '09:00',
        End: '17:00',
        TANeeded: 2,
        DoctorNeeded: 1,
        InvigilatorsNeeded: 3,
        Notes: 'Example control session'
      }
    ]), 'ControlSessions');

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { controlSessionId: '', invigilatorId: '', role: '' }
    ]), 'ControlAssignments');

    XLSX.writeFile(workbook, 'scheduler_workbook_template.xlsx');
    showToast('Workbook template downloaded.', 'success');
  }

  async function remove(assignmentId) {
    try {
      await api.removeSessionAssignment(assignmentId);
      showToast('Assignment removed.', 'success');
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
      showToast('All session assignments removed.', 'success');
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
            <button type="button" className="primary-btn" onClick={autoSchedule}>Auto Schedule</button>
            <button type="button" className="ghost-btn" onClick={downloadTemplate}>Template</button>
            <label className="ghost-btn">
              Import Excel
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importWorkbook} />
            </label>
            <button type="button" className="ghost-btn" onClick={exportWorkbook}>Export Excel</button>
            <button type="button" className="danger-btn" onClick={removeAll}>Remove All</button>
          </div>
        </div>
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
          {selectedSession ? (
            <div className="info-chip"><strong>Selected</strong><span>{courseLabel(selectedSession)}</span></div>
          ) : null}
        </div>
        {autoResult ? (
          <div className="info-chip">
            <strong>Status</strong>
            <span>{autoResult.status} | placed {autoResult.placed}</span>
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
                  <div className="info-chip"><strong>Eligible TA</strong><span>{selectedSession.eligibleTAs.length}</span></div>
                  <div className="info-chip"><strong>Eligible Doctor</strong><span>{selectedSession.eligibleDoctors.length}</span></div>
                </div>

                <div className="schedule-detail-sections">
                  <div className="duty-column">
                    <h4>TA Assignment</h4>
                    <div className="calendar-session-block">
                      <select value={selection[`${selectedSession.id}_TA`] || ''} onChange={(event) => setSelectValue(selectedSession.id, 'TA', event.target.value)}>
                        <option value="">Select TA</option>
                        {selectedSession.eligibleTAs.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name} ({((Number(person.projectedMinutes || 0)) / 60).toFixed(1)}h after)
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn btn-primary" onClick={() => assign(selectedSession.id, 'TA')}>Assign TA</button>
                    </div>
                    <div className="calendar-assignment-list">
                      {selectedSession.taAssignments.map((assignment) => (
                        <div key={assignment.id} className="calendar-assignment-row">
                          <span>{assignment.invigilator?.name || 'Unknown'} (TA)</span>
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
                        {selectedSession.eligibleDoctors.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name} ({((Number(person.projectedMinutes || 0)) / 60).toFixed(1)}h after)
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn btn-primary" onClick={() => assign(selectedSession.id, 'Doctor')}>Assign Doctor</button>
                    </div>
                    <div className="calendar-assignment-list">
                      {selectedSession.doctorAssignments.map((assignment) => (
                        <div key={assignment.id} className="calendar-assignment-row">
                          <span>{assignment.invigilator?.name || 'Unknown'} (Doctor)</span>
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
