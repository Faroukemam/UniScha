const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const { all, get, write } = require('./db');

function defaultQuality() {
  return {
    autoAvailableUsage: {
      totalAutoAvailableRoomBlocksUsed: 0,
      totalGroupsUsingAutoAvailable: 0,
      autoAvailableRoomsUsed: [],
      usagePerAutoAvailableRoom: [],
      usageByDateStart: [],
      totalStudentsAssignedThroughAutoAvailable: 0,
    },
    backupNecessity: [],
    stageSummaries: {
      normalOnly: null,
      backupEnabled: null,
      finalChosen: null,
      strategy: '',
      reason: '',
      improvedField: '',
    },
    finalAutoAvailableOnly: {
      groups: [],
      students: 0,
    },
    shortages: [],
    shortageDiagnostics: [],
    largerRoomBehavior: [],
  };
}

function cloneResult(result) {
  return JSON.parse(JSON.stringify(result || {}));
}

function readInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function readBool(value) {
  return String(value || '').trim().toLowerCase() === 'yes'
    || String(value || '').trim().toLowerCase() === 'true'
    || String(value || '').trim() === '1';
}

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
    if (!Number.isNaN(first) && !Number.isNaN(second) && !Number.isNaN(year)) {
      return `${year}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`;
    }
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
    return `${String(hours).padStart(2, '0')}:${String((minutes || '0').slice(0, 2)).padStart(2, '0')}`;
  }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) return raw;
  return `${String(Math.floor(numeric / 100)).padStart(2, '0')}:${String(numeric % 100).padStart(2, '0')}`;
}

function normalizeType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ['TH', 'DH', 'LAB'].includes(normalized) ? normalized : normalized;
}

async function setMeta(key, value) {
  await write((db) => {
    db.run(
      'INSERT OR REPLACE INTO course_room_meta (meta_key, meta_value) VALUES (?, ?)',
      [key, JSON.stringify(value)]
    );
  });
}

async function getMeta(key) {
  const row = await get('SELECT meta_value FROM course_room_meta WHERE meta_key = ?', [key]);
  if (!row) return null;
  try {
    return JSON.parse(row.meta_value);
  } catch (_error) {
    return null;
  }
}

async function clearMeta() {
  await write((db) => {
    db.run('DELETE FROM course_room_meta');
  });
}

async function loadInputs() {
  const [courses, availability, capacities] = await Promise.all([
    all(`
      SELECT row_number AS rowNumber, course_code AS courseCode, students, exam_date AS date,
             start_time AS start, end_time AS end, room_placement_type AS roomPlacementType,
             linked_group AS linkedGroup, linked_courses AS linkedCourses
      FROM course_room_courses
      ORDER BY row_number, id
    `),
    all(`
      SELECT row_number AS rowNumber, room, exam_date AS date, start_time AS start, end_time AS end
      FROM course_room_availability
      ORDER BY row_number, id
    `),
    all(`
      SELECT row_number AS rowNumber, room, minor_cap AS minorCap, major_cap AS majorCap,
             room_type AS roomType, auto_available AS autoAvailable
      FROM course_room_capacity
      ORDER BY row_number, id
    `),
  ]);

  return {
    courses: courses.map((row) => ({
      ...row,
      students: readInt(row.students),
      date: normalizeDate(row.date),
      start: normalizeTime(row.start),
      end: normalizeTime(row.end),
      roomPlacementType: normalizeType(row.roomPlacementType),
      linkedGroup: String(row.linkedGroup || '').trim().toUpperCase(),
      linkedCourses: String(row.linkedCourses || '').trim(),
      courseCode: String(row.courseCode || '').trim().toUpperCase(),
    })),
    availability: availability.map((row) => ({
      ...row,
      date: normalizeDate(row.date),
      start: normalizeTime(row.start),
      end: normalizeTime(row.end),
      room: String(row.room || '').trim(),
    })),
    capacities: capacities.map((row) => ({
      ...row,
      minorCap: readInt(row.minorCap),
      majorCap: readInt(row.majorCap),
      roomType: normalizeType(row.roomType),
      room: String(row.room || '').trim(),
      autoAvailable: Boolean(readInt(row.autoAvailable)),
    })),
  };
}

async function loadResults() {
  const [results, roomRows, validationErrors] = await Promise.all([
    all(`
      SELECT placement_group_id AS placementGroupId, course_codes AS courseCodes,
             linked_group AS linkedGroup, total_students AS totalStudents,
             exam_date AS date, start_time AS start, end_time AS end,
             room_placement_type AS roomPlacementType, capacity_mode AS capacityMode,
             assigned_rooms AS assignedRooms, assigned_capacity AS assignedCapacity,
             waste_capacity AS wasteCapacity, shortage, auto_available_used AS autoAvailableUsed,
             status, notes
      FROM course_room_results
      ORDER BY exam_date, start_time, placement_group_id
    `),
    all(`
      SELECT placement_group_id AS placementGroupId, course_codes AS courseCodes,
             linked_group AS linkedGroup, room, exam_date AS date, start_time AS start, end_time AS end,
             capacity_mode AS capacityMode, room_capacity AS roomCapacity,
             students_assigned_to_this_room AS studentsAssignedToThisRoom,
             students_assigned_to_this_block AS studentsAssignedToThisBlock,
             block_total_assigned_students AS blockTotalAssignedStudentsAtThisTime,
             block_remaining_capacity AS blockRemainingCapacityAtThisTime,
             physical_room_total_assigned_students AS physicalRoomTotalAssignedStudentsAtThisTime,
             room_type AS roomType, auto_available AS autoAvailable, status
      FROM course_room_result_rooms
      ORDER BY exam_date, start_time, room, placement_group_id
    `),
    all(`
      SELECT source, row_number AS row, field, error_message AS errorMessage
      FROM course_room_validation_errors
      ORDER BY id
    `),
  ]);

  return {
    results: results.map((row) => ({
      ...row,
      totalStudents: readInt(row.totalStudents),
      assignedCapacity: readInt(row.assignedCapacity),
      wasteCapacity: readInt(row.wasteCapacity),
      shortage: readInt(row.shortage),
      autoAvailableUsed: Boolean(readInt(row.autoAvailableUsed)),
    })),
    roomRows: roomRows.map((row) => ({
      ...row,
      roomCapacity: readInt(row.roomCapacity),
      studentsAssignedToThisRoom: readInt(row.studentsAssignedToThisRoom),
      studentsAssignedToThisBlock: readInt(row.studentsAssignedToThisBlock),
      blockTotalAssignedStudentsAtThisTime: readInt(row.blockTotalAssignedStudentsAtThisTime),
      roomTotalAssignedStudentsAtThisTime: readInt(row.blockTotalAssignedStudentsAtThisTime),
      blockRemainingCapacityAtThisTime: readInt(row.blockRemainingCapacityAtThisTime),
      roomRemainingCapacityAtThisTime: readInt(row.blockRemainingCapacityAtThisTime),
      physicalRoomTotalAssignedStudentsAtThisTime: readInt(row.physicalRoomTotalAssignedStudentsAtThisTime),
      autoAvailable: Boolean(readInt(row.autoAvailable)),
    })),
    validationErrors,
  };
}

function buildSummary(courses, results) {
  return {
    totalCourses: courses.length,
    totalPlacementGroups: results.length,
    assignedGroups: results.filter((row) => row.status === 'Assigned').length,
    assignedWithBackup: results.filter((row) => row.status === 'AssignedWithBackup').length,
    unassignedGroups: results.filter((row) => row.status === 'Unassigned').length,
    capacityShortage: results.filter((row) => row.status === 'CapacityShortage').length,
    totalWasteCapacity: results.reduce((sum, row) => sum + readInt(row.wasteCapacity), 0),
    backupRoomsUsed: results.filter((row) => row.autoAvailableUsed).length,
  };
}

function countUsedPhysicalRooms(roomRows = []) {
  return new Set(
    roomRows.map((row) => `${row.room}|${row.date}|${row.start}`)
  ).size;
}

function countUsedBlocks(roomRows = []) {
  return new Set(
    roomRows.map((row) => `${row.room}|${row.date}|${row.start}|${row.end}|${row.capacityMode}`)
  ).size;
}

function summarizeSolveResult(result) {
  const results = Array.isArray(result?.results) ? result.results : [];
  const roomRows = Array.isArray(result?.roomRows) ? result.roomRows : [];
  return {
    assigned: results.filter((row) => row.status === 'Assigned').length,
    assignedWithBackup: results.filter((row) => row.status === 'AssignedWithBackup').length,
    capacityShortage: results.filter((row) => row.status === 'CapacityShortage').length,
    unassigned: results.filter((row) => row.status === 'Unassigned').length,
    totalShortageStudents: results.reduce((sum, row) => sum + readInt(row.shortage), 0),
    totalWaste: results.reduce((sum, row) => sum + readInt(row.wasteCapacity), 0),
    usedPhysicalRooms: countUsedPhysicalRooms(roomRows),
    usedBlocks: countUsedBlocks(roomRows),
    backupGroups: results.filter((row) => row.autoAvailableUsed).length,
  };
}

function compareSolveResults(a, b) {
  const summaryA = summarizeSolveResult(a);
  const summaryB = summarizeSolveResult(b);
  const comparisons = [
    ['totalShortageStudents', 'lower shortage students'],
    ['unassigned', 'fewer unassigned groups'],
    ['capacityShortage', 'fewer capacity shortage groups'],
    ['totalWaste', 'lower waste'],
    ['usedPhysicalRooms', 'fewer used physical rooms'],
    ['usedBlocks', 'fewer used blocks'],
  ];

  for (const [field, reason] of comparisons) {
    if (summaryA[field] < summaryB[field]) {
      return { better: 'a', reason, field, summaryA, summaryB };
    }
    if (summaryB[field] < summaryA[field]) {
      return { better: 'b', reason, field, summaryA, summaryB };
    }
  }
  return { better: 'a', reason: 'equal metrics, keep normal-only result', field: 'tie', summaryA, summaryB };
}

function buildLockedAssignments(roomRows = []) {
  return roomRows.map((row) => ({
    placementGroupId: row.placementGroupId,
    room: row.room,
    capacityMode: row.capacityMode,
    students: row.studentsAssignedToThisRoom,
  }));
}

async function getCourseRoomAssignmentState() {
  const inputs = await loadInputs();
  const loaded = await loadResults();
  return {
    courses: inputs.courses,
    availability: inputs.availability,
    capacities: inputs.capacities,
    results: loaded.results,
    roomRows: loaded.roomRows,
    validationErrors: loaded.validationErrors,
    summary: buildSummary(inputs.courses, loaded.results),
  };
}

async function clearStoredResults() {
  await write((db) => {
    db.run('DELETE FROM course_room_results');
    db.run('DELETE FROM course_room_result_rooms');
    db.run('DELETE FROM course_room_validation_errors');
  });
  await clearMeta();
}

async function replaceTable(tableName, columns, rows) {
  await write((db) => {
    db.run(`DELETE FROM ${tableName}`);
    if (!rows.length) return;
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
    const stmt = db.prepare(sql);
    rows.forEach((row) => {
      stmt.run(columns.map((column) => row[column]));
    });
    stmt.free();
  });
}

async function importScheduleRows(rows) {
  await replaceTable(
    'course_room_courses',
    ['row_number', 'course_code', 'students', 'exam_date', 'start_time', 'end_time', 'room_placement_type', 'linked_group', 'linked_courses'],
    rows.map((row, index) => ({
      row_number: index + 2,
      course_code: String(row.CourseCode || '').trim(),
      students: readInt(row.Students),
      exam_date: normalizeDate(row.Date),
      start_time: normalizeTime(row.Start),
      end_time: normalizeTime(row.End),
      room_placement_type: normalizeType(row.RoomPlacementType),
      linked_group: String(row.LinkedGroup || '').trim().toUpperCase(),
      linked_courses: String(row.LinkedCourses || '').trim(),
    }))
  );
  await clearStoredResults();
  return { imported: rows.length, errors: [], state: await getCourseRoomAssignmentState() };
}

async function importRoomSessionRows(rows) {
  await replaceTable(
    'course_room_availability',
    ['row_number', 'room', 'exam_date', 'start_time', 'end_time'],
    rows.map((row, index) => ({
      row_number: index + 2,
      room: String(row.Room || '').trim(),
      exam_date: normalizeDate(row.Date),
      start_time: normalizeTime(row.Start),
      end_time: normalizeTime(row.End),
    }))
  );
  await clearStoredResults();
  return { imported: rows.length, errors: [], state: await getCourseRoomAssignmentState() };
}

async function importRoomCapacityRows(rows) {
  await replaceTable(
    'course_room_capacity',
    ['row_number', 'room', 'minor_cap', 'major_cap', 'room_type', 'auto_available'],
    rows.map((row, index) => ({
      row_number: index + 2,
      room: String(row.Room || '').trim(),
      minor_cap: readInt(row.MinorCap),
      major_cap: readInt(row.MajorCap),
      room_type: normalizeType(row.RoomType),
      auto_available: readBool(row.AutoAvailable) ? 1 : 0,
    }))
  );
  await clearStoredResults();
  return { imported: rows.length, errors: [], state: await getCourseRoomAssignmentState() };
}

function runPython(payload) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scripts', 'course_room_assignment.py');
    const child = spawn('python', [scriptPath], { cwd: path.join(__dirname, '..') });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Course room assignment failed with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (error) {
        reject(new Error(stderr || error.message));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function buildQualityReport(state, comparison = null) {
  const report = defaultQuality();
  const backupRows = state.roomRows.filter((row) => row.autoAvailable);
  const roomUsage = new Map();
  const usageByDateStart = new Map();
  const backupGroups = new Set();
  const shortageDiagnostics = [];

  backupRows.forEach((row) => {
    backupGroups.add(row.placementGroupId);
    roomUsage.set(row.room, (roomUsage.get(row.room) || 0) + 1);
    const dateStartKey = `${row.date}|${row.start}`;
    usageByDateStart.set(dateStartKey, (usageByDateStart.get(dateStartKey) || 0) + row.studentsAssignedToThisRoom);
  });

  report.autoAvailableUsage = {
    totalAutoAvailableRoomBlocksUsed: backupRows.length,
    totalGroupsUsingAutoAvailable: backupGroups.size,
    autoAvailableRoomsUsed: Array.from(new Set(backupRows.map((row) => row.room))).sort(),
    usagePerAutoAvailableRoom: Array.from(roomUsage.entries()).map(([room, count]) => ({ room, count })).sort((a, b) => b.count - a.count),
    usageByDateStart: Array.from(usageByDateStart.entries()).map(([key, students]) => {
      const [date, start] = key.split('|');
      return { date, start, students };
    }).sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`)),
    totalStudentsAssignedThroughAutoAvailable: backupRows.reduce((sum, row) => sum + readInt(row.studentsAssignedToThisRoom), 0),
  };

  report.stageSummaries = comparison ? {
    normalOnly: comparison.normalOnly,
    backupEnabled: comparison.backupEnabled,
    finalChosen: comparison.finalChosen,
    strategy: comparison.strategy,
    reason: comparison.reason,
    improvedField: comparison.improvedField,
  } : {
    normalOnly: null,
    backupEnabled: null,
    finalChosen: state.summary,
    strategy: state.summary.assignedWithBackup > 0 ? 'BackupEnhanced' : 'NormalOnly',
    reason: state.summary.assignedWithBackup > 0 ? 'Backup rooms were used in the final saved solve.' : 'No backup rooms were needed in the final saved solve.',
    improvedField: state.summary.assignedWithBackup > 0 ? 'coverage' : 'normal-capacity fit',
  };

  report.finalAutoAvailableOnly = {
    groups: Array.from(backupGroups),
    students: report.autoAvailableUsage.totalStudentsAssignedThroughAutoAvailable,
  };

  report.shortages = state.results.filter((row) => row.shortage > 0 || row.status === 'Unassigned');
  report.shortageDiagnostics = report.shortages.map((row) => ({
    placementGroupId: row.placementGroupId,
    periodInstance: `${row.date}|${row.start}|${row.end}`,
    courseCodes: row.courseCodes,
    roomPlacementType: row.roomPlacementType,
    totalStudents: row.totalStudents,
    assignedStudents: Math.max(0, readInt(row.totalStudents) - readInt(row.shortage)),
    shortage: readInt(row.shortage),
    date: row.date,
    start: row.start,
    end: row.end,
    candidateRooms: state.capacities.filter((room) => room.roomType === row.roomPlacementType || (row.roomPlacementType === 'TH' && ['TH', 'DH', 'LAB'].includes(room.roomType))).length,
    totalCompatibleNormalCapacity: 0,
    compatibleAutoAvailableCapacity: 0,
    theoreticallyPlaceable: false,
    shortageReason: row.status === 'Unassigned' ? 'Unassigned' : 'CapacityShortage',
  }));

  const roomBlocks = new Map();
  state.roomRows.forEach((row) => {
    const key = `${row.room}|${row.date}|${row.start}|${row.end}`;
    if (!roomBlocks.has(key)) {
      roomBlocks.set(key, {
        room: row.room,
        date: row.date,
        start: row.start,
        end: row.end,
        majorCap: row.capacityMode === 'Major' ? row.roomCapacity : 0,
        majorUsed: 0,
        minorCap: row.capacityMode === 'Minor' ? row.roomCapacity : 0,
        minorUsed: 0,
        autoAvailable: row.autoAvailable,
        courseCodes: new Set(),
      });
    }
    const target = roomBlocks.get(key);
    if (row.capacityMode === 'Major') {
      target.majorCap = Math.max(target.majorCap, row.roomCapacity);
      target.majorUsed = row.blockTotalAssignedStudentsAtThisTime;
    } else if (row.capacityMode === 'Minor') {
      target.minorCap = Math.max(target.minorCap, row.roomCapacity);
      target.minorUsed = row.blockTotalAssignedStudentsAtThisTime;
    }
    row.courseCodes.split(';').map((item) => item.trim()).filter(Boolean).forEach((code) => target.courseCodes.add(code));
  });

  report.largerRoomBehavior = Array.from(roomBlocks.values())
    .map((row) => ({
      room: row.room,
      date: row.date,
      start: row.start,
      majorCap: row.majorCap,
      majorUsed: row.majorUsed,
      majorRemaining: Math.max(0, row.majorCap - row.majorUsed),
      minorCap: row.minorCap,
      minorUsed: row.minorUsed,
      minorRemaining: Math.max(0, row.minorCap - row.minorUsed),
      autoAvailable: row.autoAvailable,
      courseCodes: Array.from(row.courseCodes).join('; '),
    }))
    .sort((a, b) => ((b.majorCap + b.minorCap) - (a.majorCap + a.minorCap)) || `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));

  return report;
}

async function persistSolveResult(result) {
  const validationErrors = Array.isArray(result.validationErrors) ? result.validationErrors : [];
  const results = Array.isArray(result.results) ? result.results : [];
  const roomRows = Array.isArray(result.roomRows) ? result.roomRows : [];

  await write((db) => {
    db.run('DELETE FROM course_room_results');
    db.run('DELETE FROM course_room_result_rooms');
    db.run('DELETE FROM course_room_validation_errors');

    if (results.length) {
      const resultStmt = db.prepare(`
        INSERT INTO course_room_results (
          placement_group_id, course_codes, linked_group, total_students, exam_date, start_time, end_time,
          room_placement_type, capacity_mode, assigned_rooms, assigned_capacity, waste_capacity, shortage,
          auto_available_used, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      results.forEach((row) => {
        resultStmt.run([
          row.placementGroupId,
          row.courseCodes,
          row.linkedGroup || '',
          readInt(row.totalStudents),
          row.date,
          row.start,
          row.end,
          row.roomPlacementType,
          row.capacityMode || '',
          row.assignedRooms || '',
          readInt(row.assignedCapacity),
          readInt(row.wasteCapacity),
          readInt(row.shortage),
          row.autoAvailableUsed ? 1 : 0,
          row.status,
          row.notes || '',
        ]);
      });
      resultStmt.free();
    }

    if (roomRows.length) {
      const roomStmt = db.prepare(`
        INSERT INTO course_room_result_rooms (
          placement_group_id, course_codes, linked_group, room, exam_date, start_time, end_time, capacity_mode,
          room_capacity, students_assigned_to_this_room, students_assigned_to_this_block, block_total_assigned_students,
          block_remaining_capacity, physical_room_total_assigned_students, room_type, auto_available, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      roomRows.forEach((row) => {
        roomStmt.run([
          row.placementGroupId,
          row.courseCodes,
          row.linkedGroup || '',
          row.room,
          row.date,
          row.start,
          row.end,
          row.capacityMode || '',
          readInt(row.roomCapacity),
          readInt(row.studentsAssignedToThisRoom),
          readInt(row.studentsAssignedToThisBlock),
          readInt(row.blockTotalAssignedStudentsAtThisTime || row.roomTotalAssignedStudentsAtThisTime),
          readInt(row.blockRemainingCapacityAtThisTime || row.roomRemainingCapacityAtThisTime),
          readInt(row.physicalRoomTotalAssignedStudentsAtThisTime),
          row.roomType || '',
          row.autoAvailable ? 1 : 0,
          row.status,
        ]);
      });
      roomStmt.free();
    }

    if (validationErrors.length) {
      const validationStmt = db.prepare(`
        INSERT INTO course_room_validation_errors (source, row_number, field, error_message)
        VALUES (?, ?, ?, ?)
      `);
      validationErrors.forEach((row) => {
        validationStmt.run([
          row.source || 'Solver',
          readInt(row.row),
          row.field || '',
          row.errorMessage || '',
        ]);
      });
      validationStmt.free();
    }
  });
}

async function runCourseRoomAssignment(options = {}) {
  const inputs = await loadInputs();
  const basePayload = {
    courses: inputs.courses,
    sessions: inputs.availability,
    capacities: inputs.capacities,
    options: {
      group_linked_courses: options.groupLinkedCourses ?? true,
      allow_th_fallback: options.allowThFallback ?? true,
      capacity_strategy: options.capacityStrategy || 'best',
      time_limit_seconds: options.timeLimitSeconds || 60,
    },
  };

  const stage1Payload = {
    ...basePayload,
    options: {
      ...basePayload.options,
      use_auto_available_backup: false,
    },
  };
  const stage1Result = await runPython(stage1Payload);
  let finalResult = cloneResult(stage1Result);
  let comparison = {
    normalOnly: summarizeSolveResult(stage1Result),
    backupEnabled: null,
    finalChosen: summarizeSolveResult(stage1Result),
    strategy: 'NormalOnly',
    reason: 'Normal room sessions were sufficient or backup did not improve the result.',
    improvedField: 'normal-capacity fit',
  };

  const needsRescue = comparison.normalOnly.totalShortageStudents > 0
    || comparison.normalOnly.unassigned > 0
    || comparison.normalOnly.capacityShortage > 0;

  if ((options.useAutoAvailableBackup ?? true) && needsRescue) {
    const stage2Payload = {
      ...basePayload,
      options: {
        ...basePayload.options,
        use_auto_available_backup: true,
      },
      lockedAssignments: buildLockedAssignments(stage1Result.roomRows || []),
    };
    const stage2Result = await runPython(stage2Payload);
    const resultComparison = compareSolveResults(stage1Result, stage2Result);
    const chooseBackup = resultComparison.better === 'b';
    finalResult = cloneResult(chooseBackup ? stage2Result : stage1Result);
    comparison = {
      normalOnly: resultComparison.summaryA,
      backupEnabled: resultComparison.summaryB,
      finalChosen: chooseBackup ? resultComparison.summaryB : resultComparison.summaryA,
      strategy: chooseBackup ? 'BackupEnhanced' : 'NormalOnly',
      reason: chooseBackup ? resultComparison.reason : `backup not accepted because it did not improve ${resultComparison.field === 'tie' ? 'the result' : resultComparison.field}`,
      improvedField: resultComparison.field,
    };
  }

  await persistSolveResult(finalResult);
  const state = await getCourseRoomAssignmentState();
  const quality = buildQualityReport(state, comparison);
  await setMeta('course_room_quality', quality);
  return state;
}

async function clearCourseRoomResults() {
  await clearStoredResults();
  return getCourseRoomAssignmentState();
}

async function manualAssignCourseRoom(_payload) {
  throw new Error('Manual room assignment is not available in the current backend build.');
}

function buildRoomSlotRows(state) {
  const map = new Map();
  const capacityByRoom = new Map(
    state.capacities.map((row) => [String(row.room || '').trim().toLowerCase(), row])
  );
  const usedKeys = new Set();

  state.availability.forEach((row) => {
    const key = `${row.room}|${row.date}|${row.start}|${row.end}`;
    const roomCapacity = capacityByRoom.get(String(row.room || '').trim().toLowerCase());
    map.set(key, {
      Room: row.room,
      RoomType: roomCapacity?.roomType || '',
      Date: row.date,
      Start: row.start,
      End: row.end,
      MajorCap: readInt(roomCapacity?.majorCap),
      MinorCap: readInt(roomCapacity?.minorCap),
      MajorUsed: 0,
      MinorUsed: 0,
      PhysicalRoomTotalAssignedStudentsAtThisTime: 0,
      PlacementGroups: new Set(),
      CourseCodes: new Set(),
      CourseStudentDetails: new Map(),
      AutoAvailable: roomCapacity?.autoAvailable ? 'Yes' : 'No',
      Status: 'UnusedImportedRoom',
    });
  });

  state.roomRows.forEach((row) => {
    const key = `${row.room}|${row.date}|${row.start}|${row.end}`;
    usedKeys.add(key);
    if (!map.has(key)) {
      const roomCapacity = capacityByRoom.get(String(row.room || '').trim().toLowerCase());
      map.set(key, {
        Room: row.room,
        RoomType: row.roomType,
        Date: row.date,
        Start: row.start,
        End: row.end,
        MajorCap: readInt(roomCapacity?.majorCap),
        MinorCap: readInt(roomCapacity?.minorCap),
        MajorUsed: 0,
        MinorUsed: 0,
        PhysicalRoomTotalAssignedStudentsAtThisTime: row.physicalRoomTotalAssignedStudentsAtThisTime,
        PlacementGroups: new Set(),
        CourseCodes: new Set(),
        CourseStudentDetails: new Map(),
        AutoAvailable: row.autoAvailable ? 'Yes' : 'No',
        Status: row.status,
      });
    }
    const target = map.get(key);
    target.Status = row.autoAvailable ? 'UsedBackupRoom' : 'UsedAvailableRoom';
    target.AutoAvailable = row.autoAvailable ? 'Yes' : target.AutoAvailable;
    target.RoomType = row.roomType || target.RoomType;
    if (row.capacityMode === 'Major') {
      target.MajorUsed = Math.max(target.MajorUsed, readInt(row.blockTotalAssignedStudentsAtThisTime));
    } else if (row.capacityMode === 'Minor') {
      target.MinorUsed = Math.max(target.MinorUsed, readInt(row.blockTotalAssignedStudentsAtThisTime));
    }
    target.PhysicalRoomTotalAssignedStudentsAtThisTime = Math.max(
      target.PhysicalRoomTotalAssignedStudentsAtThisTime,
      readInt(row.physicalRoomTotalAssignedStudentsAtThisTime)
    );
    target.PlacementGroups.add(row.placementGroupId);
    row.courseCodes.split(';').map((item) => item.trim()).filter(Boolean).forEach((code) => target.CourseCodes.add(code));
    target.CourseStudentDetails.set(
      `${row.placementGroupId}|${row.capacityMode}|${row.room}`,
      `${row.placementGroupId} [${row.capacityMode}]: ${row.courseCodes.split(';').map((code) => code.trim()).filter(Boolean).join(', ')} (${row.studentsAssignedToThisRoom})`
    );
  });

  return Array.from(map.values()).map((row) => ({
    Room: row.Room,
    RoomType: row.RoomType,
    Date: row.Date,
    Start: row.Start,
    End: row.End,
    MajorCap: row.MajorCap,
    MajorUsed: row.MajorUsed,
    MajorRemaining: Math.max(0, row.MajorCap - row.MajorUsed),
    MinorCap: row.MinorCap,
    MinorUsed: row.MinorUsed,
    MinorRemaining: Math.max(0, row.MinorCap - row.MinorUsed),
    PhysicalRoomTotalAssignedStudentsAtThisTime: row.PhysicalRoomTotalAssignedStudentsAtThisTime,
    PlacementGroups: Array.from(row.PlacementGroups).join('; '),
    CourseCodes: Array.from(row.CourseCodes).join('; '),
    CourseStudentDetails: Array.from(row.CourseStudentDetails.values()).join(' | '),
    AutoAvailable: row.AutoAvailable,
    Status: row.Status,
  })).sort((a, b) => `${a.Date} ${a.Start} ${a.Room}`.localeCompare(`${b.Date} ${b.Start} ${b.Room}`));
}

function buildUsedRoomsSheet(state) {
  return buildRoomSlotRows(state).filter((row) => row.Status !== 'UnusedImportedRoom');
}

function buildUnusedRoomsSheet(state) {
  return buildRoomSlotRows(state).filter((row) => row.Status === 'UnusedImportedRoom');
}

async function exportCourseRoomAssignment() {
  const state = await getCourseRoomAssignmentState();
  const quality = await getCourseRoomQuality();
  const summaryRows = Object.entries(state.summary).map(([metric, value]) => ({ Metric: metric, Value: value }));
  const roomGridRows = buildRoomSlotRows(state);
  return {
    sheets: [
      { name: 'Summary', rows: summaryRows },
      { name: 'PlacementResults', rows: state.results },
      { name: 'RoomRows', rows: state.roomRows },
      { name: 'RoomGridDetailed', rows: roomGridRows },
      { name: 'UsedRooms', rows: buildUsedRoomsSheet(state) },
      { name: 'UnusedRooms', rows: buildUnusedRoomsSheet(state) },
      { name: 'Unassigned', rows: quality.shortages },
      { name: 'ValidationErrors', rows: state.validationErrors },
      { name: 'QualityReport', rows: [
        { Section: 'FinalStrategy', Value: quality.stageSummaries.strategy || '' },
        { Section: 'Reason', Value: quality.stageSummaries.reason || '' },
        { Section: 'BackupGroups', Value: quality.autoAvailableUsage.totalGroupsUsingAutoAvailable || 0 },
        { Section: 'BackupStudents', Value: quality.autoAvailableUsage.totalStudentsAssignedThroughAutoAvailable || 0 },
      ] },
    ],
  };
}

async function exportCourseRoomUnassigned() {
  const quality = await getCourseRoomQuality();
  return {
    sheets: [
      { name: 'Unassigned', rows: quality.shortages || [] },
      { name: 'ShortageDiagnostics', rows: quality.shortageDiagnostics || [] },
    ],
  };
}

async function getCourseRoomQuality() {
  const cached = await getMeta('course_room_quality');
  if (cached) return { ...defaultQuality(), ...cached };
  const state = await getCourseRoomAssignmentState();
  return buildQualityReport(state);
}

module.exports = {
  getCourseRoomAssignmentState,
  importScheduleRows,
  importRoomSessionRows,
  importRoomCapacityRows,
  runCourseRoomAssignment,
  clearCourseRoomResults,
  manualAssignCourseRoom,
  exportCourseRoomAssignment,
  exportCourseRoomUnassigned,
  getCourseRoomQuality,
};
