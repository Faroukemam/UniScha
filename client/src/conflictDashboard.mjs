export function buildConflictDashboard({ conflicts, overrides, workload, coverage, onCall }) {
  const issues = (conflicts.rows || []).filter((row) => row.type !== 'Engagement')
    .map((row) => ({ ...row, severity: 'Review', detail: row.explanation, duty: row.relatedSessions }));
  const duties = new Map();
  for (const row of overrides.rows || []) {
    const key = JSON.stringify([row.staffId, row.dutyType, row.dutyId, row.date, row.startTime, row.endTime]);
    if (!duties.has(key)) duties.set(key, { ...row, intervals: [] });
    duties.get(key).intervals.push([Math.max(minutes(row.startTime), minutes(row.engagementStart)), Math.min(minutes(row.endTime), minutes(row.engagementEnd))]);
  }
  for (const row of duties.values()) {
    let overlapMinutes = 0, previousEnd = -1;
    for (const [start, end] of row.intervals.sort((a, b) => a[0] - b[0])) {
      overlapMinutes += Math.max(0, end - Math.max(start, previousEnd));
      previousEnd = Math.max(previousEnd, end);
    }
    issues.push({ type: row.currentlyAllowed === 'Yes' ? 'Permitted override' : 'Blocked engagement',
      severity: row.currentlyAllowed === 'Yes' ? 'Permitted' : 'Review', staffId: row.staffId,
      staffName: row.name, role: row.role, date: row.date, duty: row.duty,
      detail: `${overlapMinutes} overlap minutes. ${row.reason}`, overlapMinutes });
  }
  for (const row of workload.rows || []) {
    if (['exact', 'add', 'reduce'].includes(row.policyMode) && Number(row.assignedMinutes) > Number(row.effectiveAllowedHours) * 60 + 0.001) {
      issues.push({ type: 'Policy hours', severity: 'Review', staffId: row.staffId, staffName: row.name,
        role: row.role, date: '', duty: 'All duties', detail: `${row.assignedHours}h assigned; policy allows ${row.effectiveAllowedHours}h.` });
    }
  }
  issues.sort((a, b) => (a.severity === 'Permitted') - (b.severity === 'Permitted') || String(a.date).localeCompare(String(b.date)) || String(a.staffId).localeCompare(String(b.staffId)));
  const gaps = (coverage.rows || []).map((row) => ({ ...row, kind: 'Session', taGap: Math.max(0, row.taNeeded - row.taAssigned), doctorGap: Math.max(0, row.doctorNeeded - row.doctorAssigned) }))
    .concat((onCall.periods || []).map((row) => ({ ...row, kind: 'On-call', room: 'Reserve pool', course: '', taGap: Math.max(0, Number(row.onCallTARemaining || 0)), doctorGap: Math.max(0, Number(row.onCallDoctorRemaining || 0)) })))
    .filter((row) => row.taGap + row.doctorGap > 0)
    .sort((a, b) => `${a.date}|${a.startTime}|${a.kind}`.localeCompare(`${b.date}|${b.startTime}|${b.kind}`));
  const balance = ['TA', 'Doctor'].map((role) => {
    const rows = (workload.rows || []).filter((row) => row.role === role && row.policyMode === 'default' && !row.excludeFromAutoSchedule);
    const spread = (key) => rows.length ? Math.round((Math.max(...rows.map((row) => Number(row[key] || 0))) - Math.min(...rows.map((row) => Number(row[key] || 0)))) * 100) / 100 : 0;
    return { role, staffCount: rows.length, totalSpread: spread('assignedHours'), sessionSpread: spread('sessionHours'), onCallSpread: spread('onCallHours') };
  });
  return { issues, gaps, balance, summary: {
    review: issues.filter((row) => row.severity === 'Review').length,
    permitted: issues.filter((row) => row.severity === 'Permitted').length,
    affectedStaff: new Set(issues.map((row) => row.staffId)).size,
    sessionGaps: gaps.filter((row) => row.kind === 'Session').reduce((sum, row) => sum + row.taGap + row.doctorGap, 0),
    onCallGaps: gaps.filter((row) => row.kind === 'On-call').reduce((sum, row) => sum + row.taGap + row.doctorGap, 0),
  } };
}

function minutes(value) { const [hours, mins] = String(value).split(':').map(Number); return hours * 60 + mins; }
