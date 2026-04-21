import { Fragment, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';

function normalizeDate(value) {
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }

  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parts = raw.split(/[./-]/).map((item) => item.trim()).filter(Boolean);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
    }
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    const year = Number(parts[2]);
    if (raw.includes('/') && first <= 12) {
      return `${year}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`;
    }
    return `${year}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`;
  }
  return raw;
}

function normalizeTime(value) {
  if (typeof value === 'number' && value > 0 && value < 1) {
    const totalMinutes = Math.round(value * 24 * 60);
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  }
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.includes(':')) {
    const [hours, minutes] = raw.split(':');
    return `${String(hours).padStart(2, '0')}:${String(minutes || 0).padStart(2, '0')}`;
  }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) return raw;
  return `${String(Math.floor(numeric / 100)).padStart(2, '0')}:${String(numeric % 100).padStart(2, '0')}`;
}

function minutes(value) {
  const [hours, mins] = String(value || '00:00').split(':').map(Number);
  return (hours * 60) + mins;
}

function periodStartMinutes(period) {
  return minutes(String(period || '').split(' - ')[0]);
}

function rangesOverlap(a, b) {
  return a.date === b.date && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}

function splitCourses(value) {
  return String(value || '')
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function courseKey(value) {
  return String(value || '').trim().toUpperCase();
}

async function readRows(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
}

function parseSessions(rows) {
  const grouped = new Map();
  rows.forEach((row, index) => {
    const room = String(row.Room ?? row.RoomPlacement ?? row.room ?? '').trim();
    const date = normalizeDate(row.Date ?? row.date ?? '');
    const start = normalizeTime(row.Start ?? row.startTime ?? row.start_time ?? '');
    const end = normalizeTime(row.End ?? row.endTime ?? row.end_time ?? '');
    const key = `${room.toLowerCase()}|${date}|${start}|${end}`;
    if (!room || !date || !start || !end) return;

    if (!grouped.has(key)) {
      grouped.set(key, {
        id: `session_${grouped.size + 1}`,
        sourceRows: [],
        room,
        date,
        start,
        end,
        courses: []
      });
    }

    const session = grouped.get(key);
    session.sourceRows.push(index + 2);
    const known = new Set(session.courses.map(courseKey));
    splitCourses(row.CourseCodes ?? row.CourseCode ?? row.CourseName ?? row.Courses ?? '').forEach((course) => {
      if (!known.has(courseKey(course))) {
        session.courses.push(course);
        known.add(courseKey(course));
      }
    });
  });

  return Array.from(grouped.values()).sort((a, b) =>
    a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.room.localeCompare(b.room)
  );
}

function parseCourseSchedule(rows) {
  return rows.map((row, index) => ({
    row: index + 2,
    courseCode: String(row.CourseCode ?? row.CourseCodes ?? row.Course ?? row.courseCode ?? '').trim(),
    students: Number(row.Students ?? row.StudentCount ?? row.Enrollment ?? row.Count ?? row.students ?? 0),
    date: normalizeDate(row.Date ?? row.date ?? ''),
    start: normalizeTime(row.Start ?? row.startTime ?? row.start_time ?? ''),
    end: normalizeTime(row.End ?? row.endTime ?? row.end_time ?? ''),
    department: String(row.Department ?? row.department ?? '').trim()
  })).filter((row) => row.courseCode);
}

function parseCapacities(rows) {
  return rows.map((row, index) => {
    const minorSubjectCap = Number(row.MinorSubjectCap ?? row.MainorSubjectCap ?? row.MinorCap ?? row.MainorCap ?? row.LargestSubjectCap ?? row.minorSubjectCap ?? 0);
    const majorCap = Number(row.MajorCap ?? row.OtherSubjectCap ?? row.OtherCap ?? row.majorCap ?? 0);
    return {
      row: index + 2,
      room: String(row.Room ?? row.RoomPlacement ?? row.room ?? '').trim(),
      capacity: minorSubjectCap + majorCap,
      minorSubjectCap,
      majorCap
    };
  }).filter((row) => row.room);
}

function exportWorkbook(name, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sheet.rows), sheet.name);
  });
  XLSX.writeFile(workbook, name);
}

function statusClass(status) {
  if (status === 'OK') return 'success';
  if (status === 'Missing Data') return 'warning';
  return 'danger';
}

function capacityLabel(row) {
  if (!row.minorSubjectCap && !row.majorCap) return 'Missing Caps';
  if (row.minorOverBy > 0 || row.majorOverBy > 0) return 'Over Limit';
  if (row.totalStudents > row.allowedCapacity) return 'Over Limit';
  if (row.totalStudents > row.capacity) return 'Over Cap';
  if (row.totalStudents < row.capacity) return 'Under Cap';
  return 'Suitable Cap';
}

function capacityLabelClass(label) {
  if (label === 'Suitable Cap') return 'success';
  if (label === 'Under Cap' || label === 'Over Cap') return 'warning';
  return 'danger';
}

function subjectSplitLabel(row) {
  if (!row.minorSubjectCap && !row.majorCap) return 'No Split Cap';
  if (row.minorOverBy > 0 || row.majorOverBy > 0) return 'Split Over';
  return 'Split OK';
}

function subjectSplitLabelClass(label) {
  if (label === 'Split OK') return 'success';
  if (label === 'No Split Cap') return 'warning';
  return 'danger';
}

function allocateByCapacity(totalStudents, locations) {
  const totalCapacity = locations.reduce((sum, item) => sum + Math.max(0, item.remainingCapacity), 0);
  const allocations = new Map(locations.map((item) => [item.sessionId, 0]));
  if (!totalStudents || !locations.length || totalCapacity <= 0) {
    return { allocations, unallocated: totalStudents };
  }

  let remaining = totalStudents;
  locations.forEach((location) => {
    const proportional = Math.floor((totalStudents * location.remainingCapacity) / totalCapacity);
    const assigned = Math.min(location.remainingCapacity, proportional, remaining);
    allocations.set(location.sessionId, assigned);
    remaining -= assigned;
  });

  const sortedLocations = [...locations].sort((a, b) => b.remainingCapacity - a.remainingCapacity);
  let guard = 0;
  while (remaining > 0 && guard < totalStudents + locations.length) {
    const target = sortedLocations.find((location) => (allocations.get(location.sessionId) || 0) < location.remainingCapacity);
    if (!target) break;
    allocations.set(target.sessionId, (allocations.get(target.sessionId) || 0) + 1);
    remaining -= 1;
    guard += 1;
  }

  return { allocations, unallocated: remaining };
}

export default function RoomCapabilityPage() {
  const [sessions, setSessions] = useState([]);
  const [courseSchedule, setCourseSchedule] = useState([]);
  const [capacities, setCapacities] = useState([]);
  const [optimization, setOptimization] = useState(null);
  const [reportView, setReportView] = useState('table');
  const [uploads, setUploads] = useState({
    sessions: null,
    courses: null,
    capacities: null
  });
  const showToast = useToast();

  async function importFile(event, parser, setter, label, key) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const rows = await readRows(file);
      const parsed = parser(rows);
      setter(parsed);
      setUploads((current) => ({
        ...current,
        [key]: {
          fileName: file.name,
          count: parsed.length,
          uploadedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      }));
      setOptimization(null);
      showToast(`${label} imported: ${parsed.length} rows.`, 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
  }

  async function runOrToolsCheck() {
    try {
      const result = await api.optimizeRoomCapability({
        sessions,
        courses: courseSchedule,
        capacities,
        options: { time_limit_seconds: 10, overflow_percent: 0.10 }
      });
      setOptimization(result);
      setUploads((current) => ({
        ...current,
        optimizer: {
          fileName: 'OR-Tools result',
          count: (result.allocations || []).length,
          uploadedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      }));
      showToast(`OR-Tools capability check completed: ${result.status}.`, 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  const analysis = useMemo(() => {
    const capacityMap = new Map(capacities.map((item) => [item.room.toLowerCase(), item]));
    const scheduleMap = new Map();
    courseSchedule.forEach((item) => {
      const key = courseKey(item.courseCode);
      const list = scheduleMap.get(key) || [];
      list.push(item);
      scheduleMap.set(key, list);
    });

    const rows = sessions.map((session) => {
      const capacity = capacityMap.get(session.room.toLowerCase());
      const courseDetails = session.courses.map((course) => {
        const matches = scheduleMap.get(courseKey(course)) || [];
        const exact = matches.find((item) => item.date === session.date && item.start === session.start && item.end === session.end);
        return { course, schedule: exact || matches[0], hasExactSchedule: Boolean(exact), hasAnySchedule: matches.length > 0 };
      });
      const missingCourses = courseDetails.filter((item) => !item.hasAnySchedule).map((item) => item.course);
      const mismatchedCourses = courseDetails.filter((item) => item.hasAnySchedule && !item.hasExactSchedule).map((item) => item.course);
      const capacityValue = Number(capacity?.capacity || 0);
      return {
        ...session,
        capacity: capacityValue,
        minorSubjectCap: Number(capacity?.minorSubjectCap || 0),
        majorCap: Number(capacity?.majorCap || 0),
        allowedCapacity: Math.ceil(capacityValue * 1.1),
        totalStudents: 0,
        overBy: 0,
        minorUsed: 0,
        majorUsed: 0,
        minorOverBy: 0,
        majorOverBy: 0,
        subjectSplitLabel: 'No Split Cap',
        missingCourses,
        mismatchedCourses,
        allocations: [],
        allocationShortages: [],
        status: 'OK'
      };
    });

    const rowMap = new Map(rows.map((row) => [row.id, row]));

    if (optimization?.allocations) {
      optimization.allocations.forEach((allocation) => {
        const row = rowMap.get(allocation.sessionId);
        if (!row) return;
        row.totalStudents += Number(allocation.students || 0);
        row.allocations.push({ course: allocation.course, students: Number(allocation.students || 0) });
      });
      (optimization.shortages || []).forEach((shortage) => {
        rows
          .filter((row) => row.date === shortage.date && row.start === shortage.start && row.end === shortage.end && row.courses.map(courseKey).includes(courseKey(shortage.course)))
          .forEach((row) => row.allocationShortages.push({ course: shortage.course, students: Number(shortage.students || 0) }));
      });
    } else {
      const remainingCapacity = new Map(rows.map((row) => [row.id, row.allowedCapacity]));
      const courseTimeGroups = new Map();

      rows.forEach((row) => {
        row.courses.forEach((course) => {
          const matches = scheduleMap.get(courseKey(course)) || [];
          const exact = matches.find((item) => item.date === row.date && item.start === row.start && item.end === row.end);
          if (!exact) return;
          const key = `${courseKey(course)}|${row.date}|${row.start}|${row.end}`;
          if (!courseTimeGroups.has(key)) {
            courseTimeGroups.set(key, {
              course,
              date: row.date,
              start: row.start,
              end: row.end,
              students: Number(exact.students || 0),
              sessions: []
            });
          }
          courseTimeGroups.get(key).sessions.push(row);
        });
      });

      Array.from(courseTimeGroups.values())
        .sort((a, b) => a.sessions.length - b.sessions.length || b.students - a.students)
        .forEach((group) => {
          const locations = group.sessions.map((row) => ({
            sessionId: row.id,
            remainingCapacity: Math.max(0, remainingCapacity.get(row.id) || 0)
          }));
          const { allocations, unallocated } = allocateByCapacity(group.students, locations);
          allocations.forEach((count, sessionId) => {
            const row = rowMap.get(sessionId);
            if (!row || count <= 0) return;
            row.totalStudents += count;
            row.allocations.push({ course: group.course, students: count });
            remainingCapacity.set(sessionId, Math.max(0, (remainingCapacity.get(sessionId) || 0) - count));
          });
          if (unallocated > 0) {
            group.sessions.forEach((row) => {
              row.allocationShortages.push({ course: group.course, students: unallocated });
            });
          }
        });
    }

    rows.forEach((row) => {
      const sortedAllocations = [...row.allocations].sort((a, b) => Number(b.students || 0) - Number(a.students || 0));
      const largestAllocation = sortedAllocations[0];
      row.minorUsed = row.majorCap > 0
        ? Number(largestAllocation?.students || 0)
        : row.totalStudents;
      row.majorUsed = row.majorCap > 0
        ? sortedAllocations.slice(1).reduce((sum, item) => sum + Number(item.students || 0), 0)
        : 0;
      row.minorOverBy = row.minorSubjectCap > 0 ? Math.max(0, row.minorUsed - row.minorSubjectCap) : 0;
      row.majorOverBy = row.majorCap > 0 ? Math.max(0, row.majorUsed - row.majorCap) : 0;
      row.subjectSplitLabel = subjectSplitLabel(row);
      row.overBy = row.capacity > 0 ? Math.max(0, row.totalStudents - row.capacity) : 0;
      row.overLimitBy = row.allowedCapacity > 0 ? Math.max(0, row.totalStudents - row.allowedCapacity) : 0;
      row.capacityLabel = capacityLabel(row);
      row.status = !row.capacity || row.missingCourses.length
        ? 'Missing Data'
        : row.overLimitBy > 0 || row.minorOverBy > 0 || row.majorOverBy > 0 || row.mismatchedCourses.length || row.allocationShortages.length
          ? 'Issue'
          : 'OK';
    });

    const conflicts = [];
    rows.forEach((session) => {
      if (!session.minorSubjectCap && !session.majorCap) {
        conflicts.push({ type: 'Missing Room Caps', room: session.room, date: session.date, time: `${session.start} - ${session.end}`, detail: 'No MinorSubjectCap or MajorCap row found for this room.' });
      }
      if (session.missingCourses.length) {
        conflicts.push({ type: 'Missing Course Size', room: session.room, date: session.date, time: `${session.start} - ${session.end}`, detail: session.missingCourses.join('; ') });
      }
      if (session.mismatchedCourses.length) {
        conflicts.push({ type: 'Course Schedule Mismatch', room: session.room, date: session.date, time: `${session.start} - ${session.end}`, detail: session.mismatchedCourses.join('; ') });
      }
      if (session.overLimitBy > 0) {
        conflicts.push({ type: 'Over 10% Limit', room: session.room, date: session.date, time: `${session.start} - ${session.end}`, detail: `${session.totalStudents} students / ${session.allowedCapacity} allowed seats. Over by ${session.overLimitBy}.` });
      }
      if (session.minorOverBy > 0 || session.majorOverBy > 0) {
        conflicts.push({
          type: 'Subject Split Over',
          room: session.room,
          date: session.date,
          time: `${session.start} - ${session.end}`,
          detail: `Minor used ${session.minorUsed}/${session.minorSubjectCap || 0}, major used ${session.majorUsed}/${session.majorCap || 0}.`
        });
      }
      if (session.allocationShortages.length) {
        const detail = session.allocationShortages
          .map((item) => `${item.course}: ${item.students} students cannot fit across available rooms`)
          .join('; ');
        conflicts.push({ type: 'Course Capacity Shortage', room: session.room, date: session.date, time: `${session.start} - ${session.end}`, detail });
      }
    });

    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const first = rows[i];
        const second = rows[j];
        if (first.room.toLowerCase() === second.room.toLowerCase() && rangesOverlap(first, second)) {
          conflicts.push({ type: 'Room Time Conflict', room: first.room, date: first.date, time: `${first.start} - ${first.end}`, detail: `Overlaps ${second.start} - ${second.end}.` });
        }
        const sharedCourses = first.courses.filter((course) => second.courses.map(courseKey).includes(courseKey(course)));
        const samePeriod = first.date === second.date && first.start === second.start && first.end === second.end;
        if (sharedCourses.length && rangesOverlap(first, second) && !samePeriod) {
          conflicts.push({ type: 'Course Time Conflict', room: `${first.room} / ${second.room}`, date: first.date, time: `${first.start} - ${first.end}`, detail: sharedCourses.join('; ') });
        }
      }
    }

    return {
      rows,
      conflicts,
      okCount: rows.filter((row) => row.status === 'OK').length,
      issueCount: rows.filter((row) => row.status === 'Issue').length,
      missingCount: rows.filter((row) => row.status === 'Missing Data').length,
      overCapacityCount: rows.filter((row) => row.overBy > 0).length
    };
  }, [sessions, courseSchedule, capacities, optimization]);

  const reportGrid = useMemo(() => {
    const dates = [...new Set(analysis.rows.map((row) => row.date))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const periods = [...new Set(analysis.rows.map((row) => `${row.start} - ${row.end}`))]
      .filter(Boolean)
      .sort((a, b) => periodStartMinutes(a) - periodStartMinutes(b) || a.localeCompare(b));
    const cells = new Map();
    const groupedIds = new Set();

    analysis.rows.forEach((row) => {
      const key = `${row.date}|${row.start} - ${row.end}`;
      const list = cells.get(key) || [];
      list.push(row);
      cells.set(key, list);
      if (row.date && row.start && row.end) {
        groupedIds.add(row.id);
      }
    });

    const ungrouped = analysis.rows.filter((row) => !groupedIds.has(row.id));
    return { dates, periods, cells, ungrouped, groupedCount: groupedIds.size };
  }, [analysis.rows]);

  function downloadTemplate(type) {
    const templates = {
      sessions: {
        name: 'room_capability_sessions_template.xlsx',
        sheets: [{ name: 'Sessions', rows: [
          { Room: '324 R PH', CourseCode: 'BME407', Date: '6/1/2026', Start: '09:30', End: '11:30' },
          { Room: '325 R PH', CourseCode: 'BME407', Date: '6/1/2026', Start: '09:30', End: '11:30' }
        ] }]
      },
      courses: {
        name: 'course_schedule_template.xlsx',
        sheets: [{ name: 'CourseSchedule', rows: [{ CourseCode: 'BME407', Students: 160, Date: '6/1/2026', Start: '09:30', End: '11:30', Department: 'Biomedical Engineering' }] }]
      },
      capacities: {
        name: 'room_capacity_template.xlsx',
        sheets: [{ name: 'RoomCapacity', rows: [
          { Room: '324 R PH', MinorSubjectCap: 70, MajorCap: 30 },
          { Room: '325 R PH', MinorSubjectCap: 80, MajorCap: 0 }
        ] }]
      }
    };
    exportWorkbook(templates[type].name, templates[type].sheets);
  }

  function formatGridCell(rows) {
    return rows.map((row) => [
      `${row.room} [${row.capacityLabel}]`,
      `Date: ${row.date}`,
      `Period: ${row.start} - ${row.end}`,
      `Courses: ${row.courses.join('; ') || '-'}`,
      `Allocated Students: ${row.totalStudents}`,
      `Derived Capacity: ${row.capacity || 0}`,
      `Allowed +10%: ${row.allowedCapacity || 0}`,
      `Minor Subject: ${row.minorUsed || 0}/${row.minorSubjectCap || 0}`,
      `Major/Other Subjects: ${row.majorUsed || 0}/${row.majorCap || 0}`,
      `Subject Split: ${row.subjectSplitLabel}`,
      `Over Capacity By: ${row.overBy || 0}`,
      `Over 10% Limit By: ${row.overLimitBy || 0}`,
      `Status: ${row.status}`,
      `Allocations: ${row.allocations.map((item) => `${item.course}: ${item.students}`).join(' | ') || '-'}`,
      `Missing Courses: ${row.missingCourses.join('; ') || '-'}`,
      `Schedule Mismatches: ${row.mismatchedCourses.join('; ') || '-'}`,
      `Shortages: ${row.allocationShortages.map((item) => `${item.course}: ${item.students}`).join(' | ') || '-'}`
    ].join('\n')).join('\n\n');
  }

  function buildGridExportRows() {
    return reportGrid.dates.map((date) => {
      const row = { Date: date };
      reportGrid.periods.forEach((period) => {
        row[period] = formatGridCell(reportGrid.cells.get(`${date}|${period}`) || []);
      });
      return row;
    });
  }

  function buildGridDetailRows() {
    return analysis.rows.map((row) => ({
      Date: row.date,
      Period: `${row.start} - ${row.end}`,
      Room: row.room,
      Courses: row.courses.join('; '),
      AllocatedStudents: row.totalStudents,
      Allocations: row.allocations.map((item) => `${item.course}: ${item.students}`).join('; '),
      DerivedCapacity: row.capacity,
      AllowedWith10Percent: row.allowedCapacity,
      MinorSubjectCap: row.minorSubjectCap,
      MinorSubjectUsed: row.minorUsed,
      MajorCap: row.majorCap,
      MajorUsed: row.majorUsed,
      MinorOverBy: row.minorOverBy,
      MajorOverBy: row.majorOverBy,
      SubjectSplitLabel: row.subjectSplitLabel,
      CapacityLabel: row.capacityLabel,
      OverBy: row.overBy,
      OverLimitBy: row.overLimitBy,
      Status: row.status,
      MissingCourses: row.missingCourses.join('; '),
      ScheduleMismatches: row.mismatchedCourses.join('; '),
      Shortages: row.allocationShortages.map((item) => `${item.course}: ${item.students}`).join('; ')
    }));
  }

  function exportReport() {
    exportWorkbook('room_capability_report.xlsx', [
      { name: 'Capability', rows: analysis.rows.map((row) => ({
        Room: row.room,
        Date: row.date,
        Start: row.start,
        End: row.end,
        Courses: row.courses.join('; '),
        AllocatedStudents: row.totalStudents,
        Allocations: row.allocations.map((item) => `${item.course}: ${item.students}`).join('; '),
        DerivedCapacity: row.capacity,
        AllowedWith10Percent: row.allowedCapacity,
        MinorSubjectCap: row.minorSubjectCap,
        MinorSubjectUsed: row.minorUsed,
        MajorCap: row.majorCap,
        MajorUsed: row.majorUsed,
        MinorOverBy: row.minorOverBy,
        MajorOverBy: row.majorOverBy,
        SubjectSplitLabel: row.subjectSplitLabel,
        CapacityLabel: row.capacityLabel,
        OverBy: row.overBy,
        OverLimitBy: row.overLimitBy,
        Status: row.status,
        MissingCourses: row.missingCourses.join('; '),
        ScheduleMismatches: row.mismatchedCourses.join('; ')
      })) },
      { name: 'DatePeriodGrid', rows: buildGridExportRows() },
      { name: 'Conflicts', rows: analysis.conflicts }
    ]);
    showToast('Room capability report exported.', 'success');
  }

  function exportGridReport() {
    exportWorkbook('room_capability_grid_report.xlsx', [
      { name: 'DatePeriodGrid', rows: buildGridExportRows() },
      { name: 'GridDetails', rows: buildGridDetailRows() }
    ]);
    showToast('Date / Period grid exported.', 'success');
  }

  function uploadMarker(label, item, readyText = 'Uploaded') {
    return (
      <div className={`upload-marker ${item ? 'ready' : 'waiting'}`}>
        <span className="upload-marker-dot" />
        <div>
          <strong>{label}</strong>
          <span>{item ? `${readyText}: ${item.count} rows | ${item.fileName} | ${item.uploadedAt}` : 'Waiting for upload'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="page-grid">
      <section className="summary-grid">
        <div className="summary-card blue">
          <div className="summary-card-value">{sessions.length}</div>
          <div className="summary-card-label">Room sessions</div>
        </div>
        <div className="summary-card success">
          <div className="summary-card-value">{analysis.okCount}</div>
          <div className="summary-card-label">Capable sessions</div>
        </div>
        <div className="summary-card warning">
          <div className="summary-card-value">{analysis.missingCount}</div>
          <div className="summary-card-label">Missing data</div>
        </div>
        <div className="summary-card danger">
          <div className="summary-card-value">{analysis.conflicts.length}</div>
          <div className="summary-card-label">Conflicts and issues</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Import Data</h2>
            <p>Check room capacity against merged room sessions. OR-Tools may use up to 10% extra room capacity to fit all students.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={() => downloadTemplate('sessions')}>Sessions Template</button>
            <button type="button" className="ghost-btn" onClick={() => downloadTemplate('courses')}>Course Schedule Template</button>
            <button type="button" className="ghost-btn" onClick={() => downloadTemplate('capacities')}>Capacity Template</button>
            <button type="button" className="primary-btn" onClick={runOrToolsCheck} disabled={!sessions.length || !courseSchedule.length || !capacities.length}>
              Run OR-Tools Check
            </button>
            <button type="button" className="primary-btn" onClick={exportReport}>Export Report</button>
          </div>
        </div>
        <div className="upload-marker-grid">
          {uploadMarker('Sessions', uploads.sessions)}
          {uploadMarker('Course Schedule', uploads.courses)}
          {uploadMarker('Room Capacity', uploads.capacities)}
          {uploadMarker('OR-Tools', uploads.optimizer, optimization?.status || 'Solved')}
        </div>
        {optimization ? (
          <div className="optimizer-banner ready">
            <strong>OR-Tools allocation active</strong>
            <span>Status: {optimization.status}. Allocations: {(optimization.allocations || []).length}. Shortages: {(optimization.shortages || []).length}.</span>
          </div>
        ) : (
          <div className="optimizer-banner waiting">
            <strong>Local preview mode</strong>
            <span>Import all three files, then run OR-Tools for the final capacity allocation.</span>
          </div>
        )}
        <div className="duo-grid capability-import-grid">
          <label className="capability-import-card">
            <div className="capability-card-head">
              <strong>Sessions</strong>
              <span className={`report-badge ${uploads.sessions ? 'success' : 'warning'}`}>{uploads.sessions ? 'Uploaded' : 'Needed'}</span>
            </div>
            <span>Format: Room, CourseCode, Date, Start, End. Same room/date/time rows are merged.</span>
            {uploads.sessions ? <small>{uploads.sessions.fileName} | {uploads.sessions.count} sessions</small> : null}
            <input type="file" accept=".xlsx,.xls" onChange={(event) => importFile(event, parseSessions, setSessions, 'Sessions', 'sessions')} />
          </label>
          <label className="capability-import-card">
            <div className="capability-card-head">
              <strong>Course Schedule</strong>
              <span className={`report-badge ${uploads.courses ? 'success' : 'warning'}`}>{uploads.courses ? 'Uploaded' : 'Needed'}</span>
            </div>
            <span>Format: CourseCode, Students, Date, Start, End. Student totals are spread across all matching rooms for the course.</span>
            {uploads.courses ? <small>{uploads.courses.fileName} | {uploads.courses.count} courses</small> : null}
            <input type="file" accept=".xlsx,.xls" onChange={(event) => importFile(event, parseCourseSchedule, setCourseSchedule, 'Course schedule', 'courses')} />
          </label>
          <label className="capability-import-card">
            <div className="capability-card-head">
              <strong>Room Capacity</strong>
              <span className={`report-badge ${uploads.capacities ? 'success' : 'warning'}`}>{uploads.capacities ? 'Uploaded' : 'Needed'}</span>
            </div>
            <span>Format: Room, MinorSubjectCap, MajorCap. Total capacity is derived from these two values.</span>
            {uploads.capacities ? <small>{uploads.capacities.fileName} | {uploads.capacities.count} rooms</small> : null}
            <input type="file" accept=".xlsx,.xls" onChange={(event) => importFile(event, parseCapacities, setCapacities, 'Room capacity', 'capacities')} />
          </label>
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <h2>Capability Check</h2>
            <p>Each row is one room/date/time session. Labels show under, suitable, or over normal room capacity.</p>
          </div>
          <div className="action-row">
            <button type="button" className={reportView === 'table' ? 'primary-btn' : 'ghost-btn'} onClick={() => setReportView('table')}>Table</button>
            <button type="button" className={reportView === 'grid' ? 'primary-btn' : 'ghost-btn'} onClick={() => setReportView('grid')}>Date / Period Grid</button>
            <button type="button" className="ghost-btn" onClick={exportGridReport}>Export Grid</button>
          </div>
        </div>
        {reportView === 'table' ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Courses</th>
                  <th>Allocated Students</th>
                  <th>Allocation</th>
                <th>Derived Cap</th>
                <th>Allowed +10%</th>
                <th>Subject Split</th>
                <th>Over By</th>
                  <th>Capacity Label</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.room}</td>
                    <td>{row.date}</td>
                    <td>{row.start} - {row.end}</td>
                    <td>{row.courses.join('; ') || '-'}</td>
                    <td>{row.totalStudents}</td>
                    <td>{row.allocations.map((item) => `${item.course}: ${item.students}`).join('; ') || '-'}</td>
                  <td>{row.capacity || '-'}</td>
                  <td>{row.allowedCapacity || '-'}</td>
                  <td>
                    <span className={`report-badge ${subjectSplitLabelClass(row.subjectSplitLabel)}`}>{row.subjectSplitLabel}</span>
                    <small className="cell-subtext">Minor {row.minorUsed || 0}/{row.minorSubjectCap || 0} | Major {row.majorUsed || 0}/{row.majorCap || 0}</small>
                  </td>
                  <td>{row.overBy || '-'}</td>
                    <td><span className={`report-badge ${capacityLabelClass(row.capacityLabel)}`}>{row.capacityLabel}</span></td>
                    <td><span className={`report-badge ${statusClass(row.status)}`}>{row.status}</span></td>
                  </tr>
                ))}
                {!analysis.rows.length ? (
                  <tr>
                  <td colSpan="12" className="empty-cell">Import sessions to start the capability check.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="capability-grid-view">
            <div className="capability-grid-summary">
              Showing {reportGrid.groupedCount} of {analysis.rows.length} sessions in the date/period grid.
              {reportGrid.ungrouped.length ? ` ${reportGrid.ungrouped.length} sessions are listed below as ungrouped.` : ''}
            </div>
            <div className="capability-grid-shell">
              <div
                className="capability-report-grid"
                style={{ gridTemplateColumns: `150px repeat(${Math.max(reportGrid.periods.length, 1)}, minmax(190px, 1fr))` }}
              >
                <div className="capability-grid-head">Date / Period</div>
                {reportGrid.periods.map((period) => (
                  <div className="capability-grid-head" key={period}>{period}</div>
                ))}
                {reportGrid.dates.map((date) => (
                  <Fragment key={date}>
                    <div className="capability-grid-date" key={`${date}_label`}>{date}</div>
                    {reportGrid.periods.map((period) => {
                      const cellRows = reportGrid.cells.get(`${date}|${period}`) || [];
                      return (
                        <div className="capability-grid-cell" key={`${date}_${period}`}>
                          {cellRows.length ? <div className="capability-grid-cell-count">{cellRows.length} sessions</div> : null}
                          {cellRows.map((row) => (
                            <article className={`capability-grid-card ${statusClass(row.status)}`} key={row.id}>
                              <div className="capability-grid-card-top">
                                <strong>{row.room}</strong>
                                <span className={`report-badge ${capacityLabelClass(row.capacityLabel)}`}>{row.capacityLabel}</span>
                              </div>
                              <p>{row.courses.join('; ') || '-'}</p>
                              <div className="capability-grid-metrics">
                                <span>{row.totalStudents}/{row.capacity || 0} derived</span>
                                <span>+10% {row.allowedCapacity || 0}</span>
                              </div>
                              <small>Split: {row.subjectSplitLabel} | Minor {row.minorUsed || 0}/{row.minorSubjectCap || 0} | Major {row.majorUsed || 0}/{row.majorCap || 0}</small>
                              <small>{row.allocations.map((item) => `${item.course}: ${item.students}`).join(' | ') || 'No allocation yet'}</small>
                            </article>
                          ))}
                          {!cellRows.length ? <div className="capability-grid-empty">No session</div> : null}
                        </div>
                      );
                    })}
                  </Fragment>
                ))}
                {!reportGrid.dates.length ? (
                  <div className="capability-grid-empty wide">Import sessions to view the date/period grid.</div>
                ) : null}
              </div>
            </div>
            {reportGrid.ungrouped.length ? (
              <div className="capability-ungrouped">
                <h3>Ungrouped Sessions</h3>
                <div className="capability-ungrouped-list">
                  {reportGrid.ungrouped.map((row) => (
                    <article className={`capability-grid-card ${statusClass(row.status)}`} key={row.id}>
                      <div className="capability-grid-card-top">
                        <strong>{row.room || 'No room'}</strong>
                        <span className={`report-badge ${capacityLabelClass(row.capacityLabel)}`}>{row.capacityLabel}</span>
                      </div>
                      <p>{row.date || 'No date'} | {row.start || '--'} - {row.end || '--'}</p>
                      <p>{row.courses.join('; ') || '-'}</p>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <h2>Conflicts</h2>
            <p>Capacity failures, missing data, room overlaps, and course time conflicts.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Room</th>
                <th>Date</th>
                <th>Time</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {analysis.conflicts.map((item, index) => (
                <tr key={`${item.type}_${index}`}>
                  <td><span className="report-badge danger">{item.type}</span></td>
                  <td>{item.room}</td>
                  <td>{item.date}</td>
                  <td>{item.time}</td>
                  <td>{item.detail}</td>
                </tr>
              ))}
              {!analysis.conflicts.length ? (
                <tr>
                  <td colSpan="5" className="empty-cell">No conflicts found for the imported data.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
