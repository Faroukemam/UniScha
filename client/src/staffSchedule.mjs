export const dutyLabels = { Session: 'Session', OnCall: 'On-call', Control: 'Control', Super: 'Super invigilator' };

function timeMinutes(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

export function buildStaffSchedule(duties, { startDate = '', endDate = '', dutyType = '' } = {}) {
  const invalidRange = Boolean(startDate && endDate && startDate > endDate);
  const rows = invalidRange ? [] : duties.filter((row) => (!startDate || row.date >= startDate)
    && (!endDate || row.date <= endDate) && (!dutyType || row.dutyType === dutyType))
    .slice().sort((a, b) => `${a.date}|${a.startTime}|${a.endTime}|${a.dutyType}|${a.id || ''}`.localeCompare(`${b.date}|${b.startTime}|${b.endTime}|${b.dutyType}|${b.id || ''}`));
  const groups = new Map();
  let totalMinutes = 0;
  for (const row of rows) {
    if (!groups.has(row.date)) groups.set(row.date, { date: row.date, duties: [], minutes: 0, idleMinutes: 0 });
    const day = groups.get(row.date);
    const minutes = Number.isFinite(row.durationMinutes) ? row.durationMinutes : Number(row.durationHours || 0) * 60;
    day.duties.push(row);
    day.minutes += minutes;
    totalMinutes += minutes;
  }
  const days = [...groups.values()];
  for (const day of days) {
    let lastEnd = null;
    for (const row of day.duties) {
      const start = timeMinutes(row.startTime);
      const end = timeMinutes(row.endTime);
      if (start === null || end === null || end <= start) continue;
      if (lastEnd !== null) day.idleMinutes += Math.max(0, start - lastEnd);
      lastEnd = Math.max(lastEnd ?? end, end);
    }
  }
  const ordinals = days.map((day) => Date.parse(`${day.date}T00:00:00Z`) / 86400000);
  return { rows, days, invalidRange, dutyCount: rows.length, totalMinutes, workedDays: days.length,
    idleMinutes: days.reduce((sum, day) => sum + day.idleMinutes, 0),
    workingDayGaps: ordinals.length ? ordinals[ordinals.length - 1] - ordinals[0] + 1 - ordinals.length : 0 };
}

export function staffScheduleExportRows(person, rows) {
  return rows.map((row) => ({ StaffID: person.staffId, Name: person.name, Role: person.role, Date: row.date,
    Start: row.startTime, End: row.endTime, Duty: dutyLabels[row.dutyType] || row.dutyType,
    Course: row.courseCode || row.course || '', Room: row.room || '',
    Hours: Number(((row.durationMinutes ?? Number(row.durationHours || 0) * 60) / 60).toFixed(2)) }));
}
