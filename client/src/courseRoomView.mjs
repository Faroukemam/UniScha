export const placementStatusLabels = {
  Assigned: 'Placed',
  AssignedWithBackup: 'Placed with backup',
  CapacityShortage: 'Partially placed',
  Unassigned: 'Unassigned',
};

export function isBackupRoom(row) {
  return row.autoAvailable === true || ['1', 'true', 'yes', 'y'].includes(String(row.autoAvailable || '').trim().toLowerCase());
}

export function summarizeCourseRooms(state) {
  const results = state.results || [];
  const roomRows = state.roomRows || [];
  const totalStudents = results.length
    ? results.reduce((sum, row) => sum + Number(row.totalStudents || 0), 0)
    : (state.courses || []).reduce((sum, row) => sum + Number(row.students ?? row.Students ?? 0), 0);
  const shortage = results.length ? results.reduce((sum, row) => sum + Number(row.shortage || 0), 0) : null;
  return {
    groups: results.length,
    placedGroups: results.filter((row) => ['Assigned', 'AssignedWithBackup'].includes(row.status)).length,
    totalStudents,
    seatedStudents: shortage === null ? 0 : Math.max(0, totalStudents - shortage),
    shortage,
    usedRooms: new Set(roomRows.map((row) => row.room)).size,
    backupRooms: new Set(roomRows.filter(isBackupRoom).map((row) => row.room)).size,
    backupGroups: new Set(roomRows.filter(isBackupRoom).map((row) => row.placementGroupId)).size,
  };
}

export function filterCourseRoomRows(rows, filters = {}, kind = 'placements') {
  const search = String(filters.search || '').trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filters.date && row.date !== filters.date) return false;
    if (filters.type && (row.roomPlacementType || row.roomType) !== filters.type) return false;
    if (kind === 'placements' && filters.status && row.status !== filters.status) return false;
    if (kind === 'rooms' && filters.roomSource && isBackupRoom(row) !== (filters.roomSource === 'backup')) return false;
    return !search || [row.placementGroupId, row.courseCodes, row.linkedGroup, row.room, row.assignedRooms, row.shortageReason, row.notes]
      .join(' ').toLocaleLowerCase().includes(search);
  });
}

export function groupRoomPeriods(rows) {
  const periods = new Map();
  for (const row of rows) {
    const key = `${row.date}|${row.start}|${row.end}`;
    if (!periods.has(key)) periods.set(key, { date: row.date, start: row.start, end: row.end, rooms: [] });
    periods.get(key).rooms.push(row);
  }
  return [...periods.values()].sort((a, b) => `${a.date}|${a.start}|${a.end}`.localeCompare(`${b.date}|${b.start}|${b.end}`));
}
