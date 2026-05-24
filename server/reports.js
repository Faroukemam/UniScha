const {
  buildDutyCollections,
  buildOnCallNeeds,
  buildStaffHourPolicySummary,
  buildSchedulingView,
  buildWorkloadView,
  parseTimeToMinutes,
  rangesOverlap,
} = require('./store');

function parseDateTime(date, time) {
  const dateValue = String(date || '').trim();
  const timeValue = String(time || '').trim();
  if (!dateValue || !timeValue) return null;
  const normalizedTime = timeValue.includes(':') ? timeValue : `${String(Math.floor(Number(timeValue) / 100)).padStart(2, '0')}:${String(Number(timeValue) % 100).padStart(2, '0')}`;
  const value = new Date(`${dateValue}T${normalizedTime}:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function roundHours(minutes) {
  return Math.round((Number(minutes || 0) / 60) * 100) / 100;
}

function toPercent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function getFilters(query = {}) {
  return {
    startDate: String(query.startDate || '').trim(),
    endDate: String(query.endDate || '').trim(),
    role: String(query.role || 'All').trim() || 'All',
    department: String(query.department || '').trim(),
    day: String(query.day || '').trim(),
    staffId: String(query.staffId || '').trim(),
  };
}

function dateMatches(date, filters) {
  const value = String(date || '').trim();
  if (!value) return false;
  if (filters.day && value !== filters.day) return false;
  if (filters.startDate && value < filters.startDate) return false;
  if (filters.endDate && value > filters.endDate) return false;
  return true;
}

function personMatches(person, filters) {
  if (filters.role !== 'All' && person.role !== filters.role) return false;
  if (filters.department && String(person.department || '') !== filters.department) return false;
  if (filters.staffId && person.id !== filters.staffId && String(person.staffId || '') !== filters.staffId) return false;
  return true;
}

function buildReportContext(store, rawFilters) {
  const filters = getFilters(rawFilters);
  const scheduling = buildSchedulingView(store);
  const { sessionDuties, superDuties, controlDuties, onCallDuties } = buildDutyCollections(store);
  const allDuties = [...sessionDuties, ...superDuties, ...controlDuties, ...onCallDuties];
  const people = store.invigilators.filter((person) => personMatches(person, filters));
  const personMap = new Map(store.invigilators.map((person) => [person.id, person]));
  const filteredOnCallNeeds = buildOnCallNeeds(store).filter((need) => dateMatches(need.date, filters));

  const filteredDuties = allDuties.filter((duty) => {
    const person = personMap.get(duty.invigilatorId);
    if (!person || !personMatches(person, filters)) return false;
    return dateMatches(duty.date, filters);
  });

  const filteredSessions = scheduling.sessions.filter((session) => dateMatches(session.date, filters));
  const filteredEngagements = store.engagements.filter((row) => dateMatches(row.date, filters));

  return {
    filters,
    people,
    personMap,
    scheduling,
    filteredSessions,
    filteredDuties,
    filteredEngagements,
    filteredOnCallNeeds,
    allDuties,
  };
}

function buildWorkloadReport(store, rawFilters) {
  const context = buildReportContext(store, rawFilters);
  const policySummary = buildStaffHourPolicySummary(store);
  const workloadById = new Map(buildWorkloadView(store).map((row) => [row.id, row]));
  const rows = context.people.map((person) => {
    const base = workloadById.get(person.id);
    const assignedMinutes = Number(base?.totalMinutes || 0);
    const maxMinutes = Number(person.maxHours || 0) * 60;
    const remainingMinutes = Math.max(0, maxMinutes - assignedMinutes);
    const utilizationPercent = maxMinutes > 0 ? Math.round((assignedMinutes / maxMinutes) * 100) : 0;
    const effective = policySummary.effectivePolicyByInvigilatorId.get(person.id);
    return {
      id: person.id,
      staffId: person.staffId || '',
      name: person.name || '',
      role: person.role || '',
      department: person.department || '',
      maxHours: Number(person.maxHours || 0),
      assignedHours: roundHours(assignedMinutes),
      remainingHours: roundHours(remainingMinutes),
      assignedSessions: Number(base?.sessionCount || 0) + Number(base?.superCount || 0) + Number(base?.controlCount || 0) + Number(base?.onCallCount || 0),
      sessionHours: roundHours(base?.sessionMinutes || 0),
      superHours: roundHours(base?.superMinutes || 0),
      controlHours: roundHours(base?.controlMinutes || 0),
      onCallHours: roundHours(base?.onCallMinutes || 0),
      sessionCount: Number(base?.sessionCount || 0),
      superCount: Number(base?.superCount || 0),
      controlCount: Number(base?.controlCount || 0),
      onCallCount: Number(base?.onCallCount || 0),
      utilizationPercent,
      assignedMinutes,
      roleAverageHours: Number(effective?.rawAverageHours || 0),
      effectiveAllowedHours: Number(effective?.allowedHours || 0),
      differenceFromTargetHours: Number(base?.differenceFromTargetHours || 0),
      policyMode: effective?.mode || 'default',
      policyStatus: base?.policyStatus || 'default',
      excludeFromAutoSchedule: Boolean(base?.excludeFromAutoSchedule),
      status: assignedMinutes > maxMinutes && maxMinutes > 0
        ? 'Overloaded'
        : assignedMinutes === 0
          ? 'Unused'
          : utilizationPercent < 35
            ? 'Underutilized'
            : 'Balanced',
    };
  }).sort((a, b) => b.assignedMinutes - a.assignedMinutes || a.name.localeCompare(b.name));

  const assignedMinutesList = rows.map((row) => row.assignedMinutes);
  const totalAssignedMinutes = assignedMinutesList.reduce((sum, value) => sum + value, 0);
  const summary = {
    totalStaff: rows.length,
    totalAssignedHours: roundHours(totalAssignedMinutes),
    averageAssignedHours: rows.length ? roundHours(totalAssignedMinutes / rows.length) : 0,
    taAverageHours: policySummary.rawAverageHoursByRole.TA || 0,
    doctorAverageHours: policySummary.rawAverageHoursByRole.Doctor || 0,
    maxAssignedHours: rows.length ? roundHours(Math.max(...assignedMinutesList)) : 0,
    minAssignedHours: rows.length ? roundHours(Math.min(...assignedMinutesList)) : 0,
    sessionAssignments: rows.reduce((sum, row) => sum + Number(row.sessionCount || 0), 0),
    superAssignments: rows.reduce((sum, row) => sum + Number(row.superCount || 0), 0),
    controlAssignments: rows.reduce((sum, row) => sum + Number(row.controlCount || 0), 0),
    sessionHours: Math.round(rows.reduce((sum, row) => sum + Number(row.sessionHours || 0), 0) * 100) / 100,
    superHours: Math.round(rows.reduce((sum, row) => sum + Number(row.superHours || 0), 0) * 100) / 100,
    controlHours: Math.round(rows.reduce((sum, row) => sum + Number(row.controlHours || 0), 0) * 100) / 100,
    onCallAssignments: rows.reduce((sum, row) => sum + Number(row.onCallCount || 0), 0),
    onCallHours: Math.round(rows.reduce((sum, row) => sum + Number(row.onCallHours || 0), 0) * 100) / 100,
    overloadedCount: rows.filter((row) => row.status === 'Overloaded').length,
    underutilizedCount: rows.filter((row) => row.status === 'Underutilized').length,
    overPolicyCount: rows.filter((row) => row.policyStatus === 'over target').length,
    underTargetCount: rows.filter((row) => row.policyStatus === 'under target').length,
    excludedStaffCount: rows.filter((row) => row.excludeFromAutoSchedule).length,
  };

  return { filters: context.filters, summary, rows };
}

function computeFairnessMetrics(rows) {
  const assigned = rows.map((row) => Number(row.assignedHours || 0));
  const count = assigned.length;
  const average = count ? assigned.reduce((sum, value) => sum + value, 0) / count : 0;
  const max = count ? Math.max(...assigned) : 0;
  const min = count ? Math.min(...assigned) : 0;
  const gap = max - min;
  const variance = count
    ? assigned.reduce((sum, value) => sum + ((value - average) ** 2), 0) / count
    : 0;
  const stdDev = Math.sqrt(variance);
  // Fairness score is based on the coefficient of variation.
  // Lower relative spread means more even workload, so 100 is perfectly balanced
  // and the score declines as standard deviation becomes large relative to the mean.
  const fairnessScore = average <= 0
    ? 100
    : Math.max(0, Math.min(100, Math.round((1 - (stdDev / average)) * 100)));

  return {
    count,
    averageAssignedHours: Math.round(average * 100) / 100,
    maxAssignedHours: Math.round(max * 100) / 100,
    minAssignedHours: Math.round(min * 100) / 100,
    maxMinGap: Math.round(gap * 100) / 100,
    variance: Math.round(variance * 100) / 100,
    standardDeviation: Math.round(stdDev * 100) / 100,
    fairnessScore,
  };
}

function buildFairnessReport(store, rawFilters) {
  const workload = buildWorkloadReport(store, rawFilters);
  const taRows = workload.rows.filter((row) => row.role === 'TA');
  const doctorRows = workload.rows.filter((row) => row.role === 'Doctor');
  return {
    filters: workload.filters,
    ta: computeFairnessMetrics(taRows),
    doctor: computeFairnessMetrics(doctorRows),
  };
}

function buildDailyCoverageReport(store, rawFilters) {
  const context = buildReportContext(store, rawFilters);
  const rowsByDate = new Map();

  for (const session of context.filteredSessions) {
    if (!rowsByDate.has(session.date)) {
      rowsByDate.set(session.date, {
        date: session.date,
        totalSessions: 0,
        taRequired: 0,
        doctorRequired: 0,
        taAssigned: 0,
        doctorAssigned: 0,
        onCallTANeeded: 0,
        onCallDoctorNeeded: 0,
        onCallTAAssigned: 0,
        onCallDoctorAssigned: 0,
      });
    }
    const row = rowsByDate.get(session.date);
    row.totalSessions += 1;
    row.taRequired += Number(session.taNeeded || 0);
    row.doctorRequired += Number(session.doctorNeeded || 0);
    row.taAssigned += session.taAssignments.length;
    row.doctorAssigned += session.doctorAssignments.length;
  }

  for (const need of context.filteredOnCallNeeds) {
    if (!rowsByDate.has(need.date)) {
      rowsByDate.set(need.date, {
        date: need.date,
        totalSessions: 0,
        taRequired: 0,
        doctorRequired: 0,
        taAssigned: 0,
        doctorAssigned: 0,
        onCallTANeeded: 0,
        onCallDoctorNeeded: 0,
        onCallTAAssigned: 0,
        onCallDoctorAssigned: 0,
      });
    }
    const row = rowsByDate.get(need.date);
    row.onCallTANeeded += Number(need.onCallTANeeded || 0);
    row.onCallDoctorNeeded += Number(need.onCallDoctorNeeded || 0);
  }

  context.filteredDuties
    .filter((duty) => duty.dutyType === 'OnCall')
    .forEach((duty) => {
      if (!rowsByDate.has(duty.date)) {
        rowsByDate.set(duty.date, {
          date: duty.date,
          totalSessions: 0,
          taRequired: 0,
          doctorRequired: 0,
          taAssigned: 0,
          doctorAssigned: 0,
          onCallTANeeded: 0,
          onCallDoctorNeeded: 0,
          onCallTAAssigned: 0,
          onCallDoctorAssigned: 0,
        });
      }
      const row = rowsByDate.get(duty.date);
      if ((duty.role || duty.invigilator?.role) === 'Doctor') {
        row.onCallDoctorAssigned += 1;
      } else {
        row.onCallTAAssigned += 1;
      }
    });

  const rows = Array.from(rowsByDate.values())
    .map((row) => {
      const totalRequired = row.taRequired + row.doctorRequired;
      const totalAssigned = row.taAssigned + row.doctorAssigned;
      return {
        ...row,
        taGaps: Math.max(0, row.taRequired - row.taAssigned),
        doctorGaps: Math.max(0, row.doctorRequired - row.doctorAssigned),
        onCallTAGaps: Math.max(0, Number(row.onCallTANeeded || 0) - Number(row.onCallTAAssigned || 0)),
        onCallDoctorGaps: Math.max(0, Number(row.onCallDoctorNeeded || 0) - Number(row.onCallDoctorAssigned || 0)),
        coveragePercent: toPercent(totalAssigned, totalRequired),
        status: totalAssigned >= totalRequired ? 'Covered' : 'Shortage',
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return { filters: context.filters, rows };
}

function buildConflictReport(store, rawFilters) {
  const context = buildReportContext(store, rawFilters);
  const conflicts = [];
  const seenKeys = new Set();

  function pushConflict(conflict) {
    const key = JSON.stringify(conflict);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    conflicts.push(conflict);
  }

  const dutiesByPerson = new Map();
  context.filteredDuties.forEach((duty) => {
    const rows = dutiesByPerson.get(duty.invigilatorId) || [];
    rows.push(duty);
    dutiesByPerson.set(duty.invigilatorId, rows);
  });

  for (const [invigilatorId, duties] of dutiesByPerson.entries()) {
    const person = context.personMap.get(invigilatorId);
    const sorted = duties
      .map((duty) => ({
        ...duty,
        startDateTime: parseDateTime(duty.date, duty.startTime),
        endDateTime: parseDateTime(duty.date, duty.endTime),
      }))
      .filter((duty) => duty.startDateTime && duty.endDateTime)
      .sort((a, b) => a.startDateTime - b.startDateTime);

    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        if (a.date !== b.date) continue;
        if (a.startDateTime < b.endDateTime && b.startDateTime < a.endDateTime) {
          pushConflict({
            type: 'Overlap',
            staffId: person?.staffId || '',
            staffName: person?.name || '',
            role: person?.role || '',
            relatedSessions: `${a.label} | ${b.label}`,
            date: a.date,
            explanation: 'Staff member is assigned to overlapping duties.',
          });
        }
      }
    }

    const totalMinutes = duties.reduce((sum, duty) => sum + Number(duty.durationMinutes || 0), 0);
    const maxMinutes = Number(person?.maxHours || 0) * 60;
    if (maxMinutes > 0 && totalMinutes > maxMinutes) {
      pushConflict({
        type: 'Max Hours',
        staffId: person?.staffId || '',
        staffName: person?.name || '',
        role: person?.role || '',
        relatedSessions: duties.map((duty) => duty.label).join(' | '),
        date: '',
        explanation: `Assigned ${roundHours(totalMinutes)}h which exceeds max ${Number(person?.maxHours || 0)}h.`,
      });
    }

    const personEngagements = context.filteredEngagements.filter((engagement) => engagement.staffId === person?.staffId);
    for (const duty of duties) {
      for (const engagement of personEngagements) {
        if (engagement.date !== duty.date || Number(engagement.engagement) !== 1) continue;
        if (rangesOverlap(duty.startTime, duty.endTime, engagement.startTime, engagement.endTime)) {
          pushConflict({
            type: 'Engagement',
            staffId: person?.staffId || '',
            staffName: person?.name || '',
            role: person?.role || '',
            relatedSessions: duty.label,
            date: duty.date,
            explanation: 'Assigned during a blocked engagement period.',
          });
        }
      }
    }
  }

  const duplicateTracker = new Map();
  store.assignments.forEach((assignment) => {
    const session = store.sessions.find((item) => item.id === assignment.sessionId);
    const person = context.personMap.get(assignment.invigilatorId);
    if (!session || !person || !personMatches(person, context.filters) || !dateMatches(session.date, context.filters)) return;
    const key = JSON.stringify([assignment.sessionId, assignment.invigilatorId]);
    const count = duplicateTracker.get(key) || 0;
    duplicateTracker.set(key, count + 1);
  });

  duplicateTracker.forEach((count, key) => {
    if (count <= 1) return;
    const [sessionId, invigilatorId] = JSON.parse(key);
    const session = store.sessions.find((item) => item.id === sessionId);
    const person = context.personMap.get(invigilatorId);
    pushConflict({
      type: 'Duplicate',
      staffId: person?.staffId || '',
      staffName: person?.name || '',
      role: person?.role || '',
      relatedSessions: session ? `${session.courseName || session.room || 'Session'} (${session.room || 'No room'})` : 'Session',
      date: session?.date || '',
      explanation: 'Staff member is assigned more than once to the same session.',
    });
  });

  return {
    filters: context.filters,
    rows: conflicts.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.staffName.localeCompare(b.staffName)),
  };
}

function buildStaffReport(store, rawFilters, staffRef) {
  const context = buildReportContext(store, rawFilters);
  const person = store.invigilators.find((item) => item.id === staffRef || String(item.staffId || '') === staffRef);
  if (!person) {
    return { filters: context.filters, person: null, sessions: [], summary: null };
  }

  const duties = context.filteredDuties
    .filter((duty) => duty.invigilatorId === person.id)
    .map((duty) => ({
      date: duty.date,
      startTime: duty.startTime,
      endTime: duty.endTime,
      room: duty.label.includes('(') ? duty.label.split('(').slice(-1)[0].replace(')', '') : '',
      course: duty.label,
      role: duty.role || person.role,
      dutyType: duty.dutyType,
      durationHours: roundHours(duty.durationMinutes),
    }))
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));

  const totalMinutes = context.filteredDuties
    .filter((duty) => duty.invigilatorId === person.id)
    .reduce((sum, duty) => sum + Number(duty.durationMinutes || 0), 0);
  const maxMinutes = Number(person.maxHours || 0) * 60;
  const workedDays = new Set(duties.map((duty) => duty.date)).size;

  return {
    filters: context.filters,
    person: {
      id: person.id,
      staffId: person.staffId || '',
      name: person.name || '',
      email: person.email || '',
      role: person.role || '',
      department: person.department || '',
      maxHours: Number(person.maxHours || 0),
    },
    summary: {
      totalAssignedHours: roundHours(totalMinutes),
      utilizationPercent: maxMinutes > 0 ? Math.round((totalMinutes / maxMinutes) * 100) : 0,
      workedDaysCount: workedDays,
      assignedSessionsCount: duties.length,
    },
    sessions: duties,
  };
}

function buildDetailedLoadReport(store, rawFilters) {
  const context = buildReportContext(store, rawFilters);
  const sessionById = new Map((store.sessions || []).map((item) => [item.id, item]));
  const controlSessionById = new Map((store.controlSessions || []).map((item) => [item.id, item]));

  const rows = context.filteredDuties
    .map((duty) => {
      const person = context.personMap.get(duty.invigilatorId) || duty.invigilator || {};
      const session = duty.dutyType === 'Session' ? sessionById.get(duty.sessionId) : null;
      const controlSession = duty.dutyType === 'Control' ? controlSessionById.get(duty.controlSessionId) : null;
      return {
        DutyType: duty.dutyType || '',
        StaffID: person?.staffId || '',
        StaffName: person?.name || '',
        Role: person?.role || duty.role || '',
        Date: duty.date || '',
        Start: duty.startTime || '',
        End: duty.endTime || '',
        DurationHours: roundHours(duty.durationMinutes || 0),
        CourseCode: session
          ? (Array.isArray(session.courseNames) && session.courseNames.length ? session.courseNames.join('; ') : session.courseName || '')
          : (controlSession
            ? (Array.isArray(controlSession.courseNames) && controlSession.courseNames.length ? controlSession.courseNames.join('; ') : controlSession.courseName || '')
            : ''),
        Room: session?.room || controlSession?.room || '',
        SessionID: duty.sessionId || '',
        ControlSessionID: duty.controlSessionId || '',
        Label: duty.label || '',
      };
    })
    .sort((a, b) =>
      a.Date.localeCompare(b.Date)
      || a.Start.localeCompare(b.Start)
      || a.DutyType.localeCompare(b.DutyType)
      || a.StaffName.localeCompare(b.StaffName)
    );

  const summary = {
    totalDuties: rows.length,
    sessionDuties: rows.filter((row) => row.DutyType === 'Session').length,
    superDuties: rows.filter((row) => row.DutyType === 'Super').length,
    controlDuties: rows.filter((row) => row.DutyType === 'Control').length,
    onCallDuties: rows.filter((row) => row.DutyType === 'OnCall').length,
    totalHours: Math.round(rows.reduce((sum, row) => sum + Number(row.DurationHours || 0), 0) * 100) / 100,
  };

  return { filters: context.filters, summary, rows };
}

function buildSessionCoverageReport(store, rawFilters) {
  const context = buildReportContext(store, rawFilters);
  const rows = context.filteredSessions.map((session) => {
    const taAssigned = session.taAssignments.length;
    const doctorAssigned = session.doctorAssignments.length;
    const taNeeded = Number(session.taNeeded || 0);
    const doctorNeeded = Number(session.doctorNeeded || 0);
    const fullyCovered = taAssigned >= taNeeded && doctorAssigned >= doctorNeeded;
    const partiallyCovered = taAssigned > 0 || doctorAssigned > 0;
    return {
      sessionId: session.id,
      course: Array.isArray(session.courseNames) && session.courseNames.length
        ? session.courseNames.join('; ')
        : (session.courseName || ''),
      room: session.room || '',
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
      taNeeded,
      doctorNeeded,
      taAssigned,
      doctorAssigned,
      status: fullyCovered ? 'Fully Covered' : partiallyCovered ? 'Partially Covered' : 'Uncovered',
    };
  }).sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));

  return { filters: context.filters, rows };
}

function buildRoomShortageReport(store, rawFilters) {
  const context = buildReportContext(store, rawFilters);
  const rowsByRoomPeriod = new Map();

  context.filteredSessions.forEach((session) => {
    const room = String(session.room || '').trim() || 'Unassigned Room';
    const date = String(session.date || '').trim();
    const startTime = String(session.startTime || '').trim();
    const endTime = String(session.endTime || '').trim();
    const key = `${room}|${date}|${startTime}|${endTime}`;
    if (!rowsByRoomPeriod.has(key)) {
      rowsByRoomPeriod.set(key, {
        room,
        date,
        startTime,
        endTime,
        totalSessions: 0,
        taNeeded: 0,
        doctorNeeded: 0,
        taAssigned: 0,
        doctorAssigned: 0,
      });
    }
    const row = rowsByRoomPeriod.get(key);
    row.totalSessions += 1;
    row.taNeeded += Number(session.taNeeded || 0);
    row.doctorNeeded += Number(session.doctorNeeded || 0);
    row.taAssigned += Number(session.taAssignments?.length || 0);
    row.doctorAssigned += Number(session.doctorAssignments?.length || 0);
  });

  const rows = Array.from(rowsByRoomPeriod.values())
    .map((row) => {
      const totalNeeded = row.taNeeded + row.doctorNeeded;
      const totalAssigned = row.taAssigned + row.doctorAssigned;
      const taShortage = Math.max(0, row.taNeeded - row.taAssigned);
      const doctorShortage = Math.max(0, row.doctorNeeded - row.doctorAssigned);
      const totalShortage = taShortage + doctorShortage;
      return {
        ...row,
        taShortage,
        doctorShortage,
        totalShortage,
        coveragePercent: toPercent(totalAssigned, totalNeeded),
        status: totalShortage > 0 ? 'Shortage' : 'Covered',
      };
    })
    .sort((a, b) =>
      b.totalShortage - a.totalShortage
      || a.date.localeCompare(b.date)
      || a.startTime.localeCompare(b.startTime)
      || a.room.localeCompare(b.room)
    );

  const uniqueRooms = new Set(rows.map((row) => row.room));
  const roomsWithShortage = new Set(rows.filter((row) => row.totalShortage > 0).map((row) => row.room));

  const summary = {
    totalRooms: uniqueRooms.size,
    totalRoomPeriods: rows.length,
    roomsWithShortage: roomsWithShortage.size,
    roomPeriodsWithShortage: rows.filter((row) => row.totalShortage > 0).length,
    totalTAShortage: rows.reduce((sum, row) => sum + Number(row.taShortage || 0), 0),
    totalDoctorShortage: rows.reduce((sum, row) => sum + Number(row.doctorShortage || 0), 0),
    totalShortage: rows.reduce((sum, row) => sum + Number(row.totalShortage || 0), 0),
  };

  return { filters: context.filters, summary, rows };
}

function buildUtilizationReport(store, rawFilters) {
  const workload = buildWorkloadReport(store, rawFilters);
  const rows = workload.rows.map((row) => ({
    ...row,
    band: row.maxHours <= 0
      ? 'Unbounded'
      : row.utilizationPercent > 100
        ? 'Over Limit'
        : row.utilizationPercent >= 80
          ? 'High Utilization'
          : row.utilizationPercent >= 40
            ? 'Moderate Utilization'
            : 'Low Utilization',
  }));
  return { filters: workload.filters, rows };
}

function buildQualityScoreReport(store, rawFilters) {
  const context = buildReportContext(store, rawFilters);
  const fairness = buildFairnessReport(store, rawFilters);
  const conflicts = buildConflictReport(store, rawFilters);
  const workload = buildWorkloadReport(store, rawFilters);

  const totalRequired = context.filteredSessions.reduce(
    (sum, session) => sum + Number(session.taNeeded || 0) + Number(session.doctorNeeded || 0),
    0
  );
  const totalAssigned = context.filteredSessions.reduce(
    (sum, session) => sum + session.taAssignments.length + session.doctorAssignments.length,
    0
  );
  const coverageScore = totalRequired ? Math.round((totalAssigned / totalRequired) * 100) : 100;

  const fairnessScores = [fairness.ta, fairness.doctor]
    .filter((item) => item.count > 0)
    .map((item) => item.fairnessScore);
  const fairnessScore = fairnessScores.length
    ? Math.round(fairnessScores.reduce((sum, value) => sum + value, 0) / fairnessScores.length)
    : 100;

  const conflictPenalty = Math.min(30, conflicts.rows.length * 5);
  const overloadPenalty = Math.min(20, workload.rows.filter((row) => row.status === 'Overloaded').length * 10);
  const finalScore = Math.max(0, Math.min(100, Math.round((coverageScore * 0.6) + (fairnessScore * 0.4) - conflictPenalty - overloadPenalty)));

  return {
    filters: context.filters,
    breakdown: {
      coverageScore,
      fairnessScore,
      conflictPenalty,
      overloadPenalty,
      finalScore,
    },
  };
}

function buildReportsSummary(store, rawFilters) {
  const workload = buildWorkloadReport(store, rawFilters);
  const fairness = buildFairnessReport(store, rawFilters);
  const conflicts = buildConflictReport(store, rawFilters);
  const quality = buildQualityScoreReport(store, rawFilters);
  const sessionCoverage = buildSessionCoverageReport(store, rawFilters);
  const dailyCoverage = buildDailyCoverageReport(store, rawFilters);
  const roomShortage = buildRoomShortageReport(store, rawFilters);

  const fullyCoveredCount = sessionCoverage.rows.filter((row) => row.status === 'Fully Covered').length;
  const onCallShortage = dailyCoverage.rows.reduce(
    (sum, row) => sum + Number(row.onCallTAGaps || 0) + Number(row.onCallDoctorGaps || 0),
    0
  );
  return {
    filters: workload.filters,
    cards: {
      totalStaff: workload.summary.totalStaff,
      totalAssignedHours: workload.summary.totalAssignedHours,
      averageAssignedHours: workload.summary.averageAssignedHours,
      taAverageHours: workload.summary.taAverageHours || 0,
      doctorAverageHours: workload.summary.doctorAverageHours || 0,
      conflictCount: conflicts.rows.length,
      qualityScore: quality.breakdown.finalScore,
      fullyCoveredSessions: fullyCoveredCount,
      roomsWithShortage: roomShortage.summary.roomsWithShortage || 0,
      roomShortageTotal: roomShortage.summary.totalShortage || 0,
      sessionAssignments: workload.summary.sessionAssignments || 0,
      sessionHours: workload.summary.sessionHours || 0,
      superAssignments: workload.summary.superAssignments || 0,
      superHours: workload.summary.superHours || 0,
      controlAssignments: workload.summary.controlAssignments || 0,
      controlHours: workload.summary.controlHours || 0,
      onCallAssignments: workload.summary.onCallAssignments || 0,
      onCallHours: workload.summary.onCallHours || 0,
      onCallShortage,
      overPolicyCount: workload.summary.overPolicyCount || 0,
      underTargetCount: workload.summary.underTargetCount || 0,
      excludedStaffCount: workload.summary.excludedStaffCount || 0,
    },
  };
}

module.exports = {
  buildReportsSummary,
  buildWorkloadReport,
  buildFairnessReport,
  buildDailyCoverageReport,
  buildConflictReport,
  buildStaffReport,
  buildDetailedLoadReport,
  buildSessionCoverageReport,
  buildRoomShortageReport,
  buildUtilizationReport,
  buildQualityScoreReport,
};
