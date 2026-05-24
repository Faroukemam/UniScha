const path = require('path');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');

function loadModulesFresh() {
  const storePath = require.resolve('../store');
  const reportsPath = require.resolve('../reports');
  delete require.cache[storePath];
  delete require.cache[reportsPath];
  return {
    ...require('../store'),
    ...require('../reports'),
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function makeBaseStore() {
  return {
    sessions: [],
    invigilators: [],
    engagements: [],
    assignments: [],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: [],
    onCallAssignments: [],
    onCallConfig: {
      mode: 'fixed_per_period',
      fixedTAsPerPeriod: 0,
      fixedDoctorsPerPeriod: 0,
    },
    staffHourPolicies: [],
  };
}

function makeInvigilator(id, staffId, role, maxHours = 12) {
  return {
    id,
    staffId,
    name: staffId,
    email: '',
    role,
    loadType: 'full',
    maxHours,
    department: '',
    notes: '',
  };
}

function makeSession(id, date, startTime, endTime, taNeeded, doctorNeeded) {
  return {
    id,
    courseNames: [id],
    courseName: id,
    room: `R_${id}`,
    date,
    startTime,
    endTime,
    taNeeded,
    doctorNeeded,
    totalNeeded: taNeeded + doctorNeeded,
    notes: '',
  };
}

function makeControlSession(id, date, startTime, endTime, taNeeded, doctorNeeded) {
  return {
    id,
    courseNames: [id],
    courseName: id,
    room: `CTL_${id}`,
    date,
    startTime,
    endTime,
    taNeeded,
    doctorNeeded,
    totalNeeded: taNeeded + doctorNeeded,
    notes: '',
  };
}

function runPythonSchedule(payload) {
  const scriptPath = path.join(__dirname, 'auto_schedule.py');
  const result = spawnSync('python', [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (!stdout) {
    throw new Error(stderr || 'auto_schedule.py returned no output');
  }
  const parsed = JSON.parse(stdout);
  if (result.status !== 0 && parsed.status !== 'ERROR') {
    throw new Error(stderr || `auto_schedule.py exited with code ${result.status}`);
  }
  if (parsed.status === 'ERROR') {
    throw new Error(parsed.error || 'auto_schedule.py returned ERROR');
  }
  return parsed;
}

function runPythonResultComparison(cpSatMetrics, fallbackMetrics) {
  const script = `
import json, sys
sys.path.insert(0, r"${__dirname.replace(/\\/g, '\\\\')}")
import auto_schedule
winner, reason = auto_schedule.compare_result_metrics(
    json.loads(sys.argv[1]),
    json.loads(sys.argv[2]),
)
print(json.dumps({"winner": winner, "reason": reason}))
`;
  const result = spawnSync('python', ['-c', script, JSON.stringify(cpSatMetrics), JSON.stringify(fallbackMetrics)], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0 || !stdout) {
    throw new Error(stderr || 'Python result comparison failed');
  }
  return JSON.parse(stdout);
}

function formatPolicyExceededMessage(eligibility, additionalMinutes) {
  return `Staff hour policy exceeded. Policy mode: ${eligibility.policyMode || 'default'}. Current hours: ${((eligibility.currentMinutes || 0) / 60).toFixed(2)}, new duty hours: ${(additionalMinutes / 60).toFixed(2)}, allowed hours: ${((eligibility.hardLimitMinutes || eligibility.allowedMinutes || 0) / 60).toFixed(2)}.`;
}

function validatePolicyImportRows(store, rows) {
  const mods = loadModulesFresh();
  const invigilatorByStaffId = new Map((store.invigilators || []).map((item) => [String(item.staffId || ''), item]));
  const validModes = new Set(['default', 'exact', 'add', 'reduce', 'exclude']);
  const accepted = [];
  const rejected = [];

  rows.forEach((row, index) => {
    const staffId = String(row.StaffID ?? row.staffId ?? '').trim();
    const person = invigilatorByStaffId.get(staffId);
    if (!person) {
      rejected.push({ row: index + 1, reason: 'unknown_staff', staffId });
      return;
    }
    const mode = String(row.Mode ?? row.mode ?? 'default').trim().toLowerCase();
    if (!validModes.has(mode)) {
      rejected.push({ row: index + 1, reason: 'invalid_mode', staffId, mode });
      return;
    }
    const hoursValue = Number(row.HoursValue ?? row.hoursValue ?? 0);
    if (!Number.isFinite(hoursValue) || hoursValue < 0) {
      rejected.push({ row: index + 1, reason: 'negative_hours', staffId, hoursValue });
      return;
    }
    accepted.push(mods.normalizeStaffHourPolicyRow({
      invigilatorId: person.id,
      staffId,
      role: row.Role ?? person.role,
      mode,
      hoursValue,
      excludeFromAutoSchedule: /^(yes|true|1)$/i.test(String(row.ExcludeFromAutoSchedule ?? '')),
      notes: row.Notes ?? '',
    }, new Map()));
  });

  return { accepted, rejected };
}

function toSolverPayload(store) {
  const mods = loadModulesFresh();
  const fixedDutyMinutesByStaff = {};
  const invigilatorById = new Map((store.invigilators || []).map((item) => [item.id, item]));
  const controlSessionById = new Map((store.controlSessions || []).map((item) => [item.id, item]));
  (store.superAssignments || []).forEach((item) => {
    const person = invigilatorById.get(item.invigilatorId);
    const staffId = String(person?.staffId || item.invigilatorId || '');
    if (!staffId) return;
    fixedDutyMinutesByStaff[staffId] = Number(fixedDutyMinutesByStaff[staffId] || 0) + (8 * 60);
  });
  (store.controlAssignments || []).forEach((item) => {
    const person = invigilatorById.get(item.invigilatorId);
    const session = controlSessionById.get(item.controlSessionId);
    if (!person || !session) return;
    const staffId = String(person.staffId || person.id || '');
    const [startHour, startMinute] = String(session.startTime || '00:00').split(':').map(Number);
    const [endHour, endMinute] = String(session.endTime || '00:00').split(':').map(Number);
    const minutes = Math.max(0, (endHour * 60 + endMinute) - (startHour * 60 + startMinute));
    fixedDutyMinutesByStaff[staffId] = Number(fixedDutyMinutesByStaff[staffId] || 0) + minutes;
  });
  (store.onCallAssignments || []).forEach((item) => {
    const person = invigilatorById.get(item.invigilatorId);
    if (!person) return;
    const staffId = String(person.staffId || person.id || '');
    const [startHour, startMinute] = String(item.startTime || '00:00').split(':').map(Number);
    const [endHour, endMinute] = String(item.endTime || '00:00').split(':').map(Number);
    const minutes = Math.max(0, (endHour * 60 + endMinute) - (startHour * 60 + startMinute));
    fixedDutyMinutesByStaff[staffId] = Number(fixedDutyMinutesByStaff[staffId] || 0) + minutes;
  });
  return {
    sessions: store.sessions.map((item) => ({
      id: item.id,
      exam_date: item.date,
      start_time: item.startTime,
      end_time: item.endTime,
      ta_needed: Number(item.taNeeded || 0),
      doctor_needed: Number(item.doctorNeeded || 0),
    })),
    invigilators: store.invigilators.map((item) => ({
      staff_id: String(item.staffId || item.id),
      role: item.role,
      load_type: item.loadType || 'full',
      max_hours: Number(item.maxHours || 0),
    })),
    engagements: store.engagements.map((item) => ({
      staff_id: String(item.staffId || ''),
      exam_date: item.date,
      start_time: item.startTime,
      end_time: item.endTime,
      engagement: Number(item.engagement ?? 1),
    })),
    locked_assignments: store.assignments.map((item) => {
      const person = store.invigilators.find((row) => row.id === item.invigilatorId);
      return {
        staff_id: String(person?.staffId || item.invigilatorId),
        session_id: item.sessionId,
        role: item.role,
      };
    }),
    staff_hour_policies: (store.staffHourPolicies || []).map((item) => ({
      staff_id: String(item.staffId || store.invigilators.find((row) => row.id === item.invigilatorId)?.staffId || ''),
      role: item.role,
      mode: item.mode,
      hours_value: Number(item.hoursValue || 0),
      exclude_from_auto_schedule: Boolean(item.excludeFromAutoSchedule || item.mode === 'exclude'),
      notes: item.notes || '',
    })),
    existing_duty_minutes_by_staff: fixedDutyMinutesByStaff,
    additional_required_minutes_by_role: (() => {
      const totals = { TA: 0, Doctor: 0 };
      (store.controlSessions || []).forEach((session) => {
        const [startHour, startMinute] = String(session.startTime || '00:00').split(':').map(Number);
        const [endHour, endMinute] = String(session.endTime || '00:00').split(':').map(Number);
        const minutes = Math.max(0, (endHour * 60 + endMinute) - (startHour * 60 + startMinute));
        totals.TA += Number(session.taNeeded || 0) * minutes;
        totals.Doctor += Number(session.doctorNeeded || 0) * minutes;
      });
      (mods.buildOnCallNeeds(store) || []).forEach((need) => {
        const minutes = Number(need.durationMinutes || 0);
        totals.TA += Number(need.onCallTANeeded || 0) * minutes;
        totals.Doctor += Number(need.onCallDoctorNeeded || 0) * minutes;
      });
      return totals;
    })(),
    options: {
      time_limit_seconds: 5,
      coverage_weight: 1000000,
      spread_weight: 100,
      imbalance_weight: 1,
    },
  };
}

function run() {
  const result = {
    result: 'PASS',
    cases: {},
  };

  const durationStore = makeBaseStore();
  durationStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
    makeInvigilator('inv_doc_1', 'DOC1', 'Doctor', 12),
  ];
  durationStore.sessions = [
    makeSession('ses_2h', '2026-07-01', '09:00', '11:00', 1, 0),
    makeSession('ses_6h', '2026-07-01', '12:00', '18:00', 1, 1),
  ];
  let mods = loadModulesFresh();
  const durationSummary = mods.buildStaffHourPolicySummary(durationStore);
  assert(durationSummary.totalRequiredHoursByRole.TA === 8, 'TA required hours must use actual duration.');
  assert(durationSummary.totalRequiredHoursByRole.Doctor === 6, 'Doctor required hours must be calculated separately.');
  assert(durationSummary.rawAverageHoursByRole.TA === 4, 'TA average must be 8 hours / 2 staff = 4.');
  assert(durationSummary.rawAverageHoursByRole.Doctor === 6, 'Doctor average must be 6 hours / 1 staff = 6.');
  result.cases.caseA_durationBasedFairness = {
    taTotalHours: durationSummary.totalRequiredHoursByRole.TA,
    doctorTotalHours: durationSummary.totalRequiredHoursByRole.Doctor,
    taAverageHours: durationSummary.rawAverageHoursByRole.TA,
    doctorAverageHours: durationSummary.rawAverageHoursByRole.Doctor,
  };

  const controlAverageStore = makeBaseStore();
  controlAverageStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
    makeInvigilator('inv_doc_1', 'DOC1', 'Doctor', 12),
  ];
  controlAverageStore.sessions = [
    makeSession('ses_2h', '2026-07-01', '09:00', '11:00', 1, 0),
  ];
  controlAverageStore.controlSessions = [
    makeControlSession('ctl_2h', '2026-07-01', '12:00', '14:00', 1, 1),
  ];
  mods = loadModulesFresh();
  const controlAverageSummary = mods.buildStaffHourPolicySummary(controlAverageStore);
  assert(controlAverageSummary.totalRequiredHoursByRole.TA === 4, 'TA required hours must include control session demand.');
  assert(controlAverageSummary.totalRequiredHoursByRole.Doctor === 2, 'Doctor required hours must include control session demand.');
  assert(controlAverageSummary.rawAverageHoursByRole.TA === 2, 'TA average must include control session demand.');
  assert(controlAverageSummary.rawAverageHoursByRole.Doctor === 2, 'Doctor average must include control session demand.');
  result.cases.caseAverageIncludesControlDemand = {
    taTotalHours: controlAverageSummary.totalRequiredHoursByRole.TA,
    doctorTotalHours: controlAverageSummary.totalRequiredHoursByRole.Doctor,
    taAverageHours: controlAverageSummary.rawAverageHoursByRole.TA,
    doctorAverageHours: controlAverageSummary.rawAverageHoursByRole.Doctor,
  };

  const onCallAverageStore = makeBaseStore();
  onCallAverageStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA'),
    makeInvigilator('inv_ta_2', 'TA2', 'TA'),
    makeInvigilator('inv_doc_1', 'DOC1', 'Doctor'),
    makeInvigilator('inv_doc_2', 'DOC2', 'Doctor'),
  ];
  onCallAverageStore.sessions = [
    {
      id: 'ses_oncall_1',
      courseNames: ['OC1'],
      courseName: 'OC1',
      room: 'R1',
      date: '2026-06-02',
      startTime: '09:30',
      endTime: '11:30',
      taNeeded: 0,
      doctorNeeded: 0,
      totalNeeded: 0,
      notes: '',
    },
    {
      id: 'ses_oncall_2',
      courseNames: ['OC2'],
      courseName: 'OC2',
      room: 'R2',
      date: '2026-06-02',
      startTime: '09:30',
      endTime: '11:30',
      taNeeded: 0,
      doctorNeeded: 0,
      totalNeeded: 0,
      notes: '',
    },
  ];
  onCallAverageStore.onCallConfig = {
    mode: 'fixed_per_period',
    fixedTAsPerPeriod: 1,
    fixedDoctorsPerPeriod: 1,
  };
  mods = loadModulesFresh();
  const onCallAverageSummary = mods.buildStaffHourPolicySummary(onCallAverageStore);
  assert(onCallAverageSummary.totalRequiredHoursByRole.TA === 2, 'TA required hours must include on-call demand.');
  assert(onCallAverageSummary.totalRequiredHoursByRole.Doctor === 2, 'Doctor required hours must include on-call demand.');
  assert(onCallAverageSummary.rawAverageHoursByRole.TA === 1, 'TA average must include on-call demand.');
  assert(onCallAverageSummary.rawAverageHoursByRole.Doctor === 1, 'Doctor average must include on-call demand.');
  result.cases.caseAverageIncludesOnCallDemand = {
    taTotalHours: onCallAverageSummary.totalRequiredHoursByRole.TA,
    doctorTotalHours: onCallAverageSummary.totalRequiredHoursByRole.Doctor,
    taAverageHours: onCallAverageSummary.rawAverageHoursByRole.TA,
    doctorAverageHours: onCallAverageSummary.rawAverageHoursByRole.Doctor,
  };

  const policyStore = makeBaseStore();
  policyStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
    makeInvigilator('inv_doc_1', 'DOC1', 'Doctor', 12),
  ];
  policyStore.sessions = [
    makeSession('ses_a', '2026-07-02', '09:00', '12:00', 2, 1),
    makeSession('ses_b', '2026-07-02', '13:00', '16:00', 2, 1),
  ];
  policyStore.staffHourPolicies = [
    { id: 'pol_exact', invigilatorId: 'inv_ta_1', staffId: 'TA1', role: 'TA', mode: 'exact', hoursValue: 4, excludeFromAutoSchedule: false, notes: '' },
    { id: 'pol_add', invigilatorId: 'inv_ta_2', staffId: 'TA2', role: 'TA', mode: 'add', hoursValue: 2, excludeFromAutoSchedule: false, notes: '' },
    { id: 'pol_reduce', invigilatorId: 'inv_doc_1', staffId: 'DOC1', role: 'Doctor', mode: 'reduce', hoursValue: 2, excludeFromAutoSchedule: false, notes: '' },
  ];
  mods = loadModulesFresh();
  const policySummary = mods.buildStaffHourPolicySummary(policyStore);
  assert(policySummary.rawAverageHoursByRole.TA === 6, 'TA average should be 12 required hours / 2 staff.');
  assert(policySummary.rawAverageHoursByRole.Doctor === 6, 'Doctor average should be 6 required hours / 1 staff.');
  assert(policySummary.effectivePolicyByInvigilatorId.get('inv_ta_1').allowedHours === 4, 'Exact policy should set allowed hours directly.');
  assert(policySummary.effectivePolicyByInvigilatorId.get('inv_ta_2').allowedHours === 8, 'Add policy should add hours above average.');
  assert(policySummary.effectivePolicyByInvigilatorId.get('inv_doc_1').allowedHours === 4, 'Reduce policy should subtract hours from average.');
  result.cases.caseC_addPolicy = {
    averageHours: policySummary.rawAverageHoursByRole.TA,
    addedHours: 2,
    effectiveAllowedHours: policySummary.effectivePolicyByInvigilatorId.get('inv_ta_2').allowedHours,
  };
  result.cases.caseD_reducePolicy = {
    averageHours: policySummary.rawAverageHoursByRole.Doctor,
    reducedHours: 2,
    effectiveAllowedHours: policySummary.effectivePolicyByInvigilatorId.get('inv_doc_1').allowedHours,
  };

  const excludeStore = makeBaseStore();
  excludeStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
  ];
  excludeStore.sessions = [makeSession('ses_ex', '2026-07-03', '09:00', '11:00', 1, 0)];
  excludeStore.staffHourPolicies = [
    { id: 'pol_exclude', invigilatorId: 'inv_ta_1', staffId: 'TA1', role: 'TA', mode: 'exclude', hoursValue: 0, excludeFromAutoSchedule: true, notes: '' },
  ];
  mods = loadModulesFresh();
  const excludeEligibility = mods.getEligibilityForSession(
    excludeStore,
    excludeStore.sessions[0],
    excludeStore.invigilators[0],
    mods.buildSchedulingIndexes(excludeStore)
  );
  assert(!excludeEligibility.eligible && excludeEligibility.reason === 'policy_excluded', 'Manual assignment should respect exclude policy.');
  result.cases.caseE_exclude = {
    excludedStaff: 'TA1',
    manualEligibilityReason: excludeEligibility.reason,
  };

  const engagementStore = makeBaseStore();
  engagementStore.invigilators = [makeInvigilator('inv_ta_1', 'TA1', 'TA', 12)];
  engagementStore.sessions = [
    makeSession('ses_busy', '2026-07-04', '09:00', '11:00', 1, 0),
    makeSession('ses_free', '2026-07-04', '12:00', '14:00', 1, 0),
  ];
  engagementStore.engagements = [
    { id: 'eng_1', staffId: 'TA1', date: '2026-07-04', startTime: '09:30', endTime: '10:30', engagement: 1, notes: '' },
  ];
  mods = loadModulesFresh();
  const engagementContext = mods.buildSchedulingIndexes(engagementStore);
  const blockedByEngagement = mods.getEligibilityForSession(engagementStore, engagementStore.sessions[0], engagementStore.invigilators[0], engagementContext);
  const allowedAfterEngagement = mods.getEligibilityForSession(engagementStore, engagementStore.sessions[1], engagementStore.invigilators[0], engagementContext);
  assert(!blockedByEngagement.eligible && blockedByEngagement.reason === 'engagement', 'Engagements must block only overlapping periods.');
  assert(allowedAfterEngagement.eligible, 'Engagements must remain separate from hour policies.');
  result.cases.caseG_engagementSeparate = {
    overlappingReason: blockedByEngagement.reason,
    nonOverlappingAllowed: allowedAfterEngagement.eligible,
  };

  const fairnessStore = makeBaseStore();
  fairnessStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
  ];
  fairnessStore.sessions = [
    makeSession('ses_short', '2026-07-05', '09:00', '11:00', 1, 0),
    makeSession('ses_long', '2026-07-05', '12:00', '18:00', 1, 0),
  ];
  const fairnessResult = runPythonSchedule(toSolverPayload(fairnessStore));
  assert((fairnessResult.assignments || []).length === 2, 'Hour-based scheduler should assign both isolated sessions.');
  assert(new Set(fairnessResult.assignments.map((item) => item.staff_id)).size === 2, 'Hour-based fairness should split different-duration sessions across available staff.');
  result.cases.caseA_solverFairness = {
    assignedStaff: fairnessResult.assignments.map((item) => item.staff_id),
    assignedHoursByStaff: fairnessResult.assignedHoursByStaff,
    averageHoursByRole: fairnessResult.averageHoursByRole,
    selectedSolver: fairnessResult.selectedSolver,
  };

  const exactStore = makeBaseStore();
  exactStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
  ];
  exactStore.sessions = [
    makeSession('ses_6h', '2026-07-06', '09:00', '15:00', 1, 0),
    makeSession('ses_2h', '2026-07-06', '16:00', '18:00', 1, 0),
  ];
  exactStore.staffHourPolicies = [
    { id: 'pol_exact', invigilatorId: 'inv_ta_1', staffId: 'TA1', role: 'TA', mode: 'exact', hoursValue: 4, excludeFromAutoSchedule: false, notes: '' },
  ];
  const exactResult = runPythonSchedule(toSolverPayload(exactStore));
  result.cases.caseB_exactLimit = {
    staff: 'TA1',
    allowedHours: 4,
    assignedHours: Number(exactResult.assignedHoursByStaff.TA1 || 0),
    policyStillReported: (exactResult.overLimitStaff || []).includes('TA1') || (exactResult.policyViolations || []).some((item) => item.staff_id === 'TA1'),
  };

  const softPolicyStore = makeBaseStore();
  softPolicyStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
  ];
  softPolicyStore.sessions = [
    makeSession('ses_soft_1', '2026-07-06', '09:00', '11:00', 1, 0),
    makeSession('ses_soft_2', '2026-07-06', '12:00', '16:00', 1, 0),
  ];
  softPolicyStore.staffHourPolicies = [
    { id: 'pol_exact_soft', invigilatorId: 'inv_ta_1', staffId: 'TA1', role: 'TA', mode: 'exact', hoursValue: 4, excludeFromAutoSchedule: false, notes: '' },
  ];
  const softPolicyResult = runPythonSchedule(toSolverPayload(softPolicyStore));
  assert((softPolicyResult.assignments || []).length === 2, 'Auto-schedule should still try to cover all sessions when policy is soft.');
  assert(Number(softPolicyResult.assignedHoursByStaff.TA1 || 0) === 6, 'Soft policy mode should allow policy overflow to cover sessions.');
  assert((softPolicyResult.overLimitStaff || []).includes('TA1') || (softPolicyResult.policyViolations || []).some((item) => item.staff_id === 'TA1'), 'Soft policy overflow must still be reported in diagnostics.');
  result.cases.casePolicySoftForCoverage = {
    assignedHours: Number(softPolicyResult.assignedHoursByStaff.TA1 || 0),
    overLimitStaff: softPolicyResult.overLimitStaff,
    policyViolations: softPolicyResult.policyViolations,
    shortageRemaining: softPolicyResult.shortageRemaining,
  };

  const controlLoadStore = makeBaseStore();
  controlLoadStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
  ];
  controlLoadStore.sessions = [
    makeSession('ses_control_sensitive', '2026-07-06', '09:00', '11:00', 1, 0),
  ];
  controlLoadStore.controlSessions = [
    makeControlSession('ctl_1', '2026-07-06', '12:00', '16:00', 1, 0),
  ];
  controlLoadStore.controlAssignments = [
    { id: 'ctlasg_1', controlSessionId: 'ctl_1', invigilatorId: 'inv_ta_1', role: 'TA' },
  ];
  const controlLoadResult = runPythonSchedule(toSolverPayload(controlLoadStore));
  assert(Number(controlLoadResult.assignedHoursByStaff.TA1 || 0) >= 4, 'Control duty hours must count toward solver baseline load.');
  assert((controlLoadResult.assignments || []).some((item) => item.staff_id === 'TA2' && item.session_id === 'ses_control_sensitive'), 'Solver should prefer the less-loaded TA when control duty hours already exist.');
  result.cases.caseControlDutyLoad = {
    assignedHoursByStaff: controlLoadResult.assignedHoursByStaff,
    chosenStaffForSession: (controlLoadResult.assignments || []).find((item) => item.session_id === 'ses_control_sensitive')?.staff_id || '',
  };

  const excludedStore = makeBaseStore();
  excludedStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
  ];
  excludedStore.sessions = [
    makeSession('ses_1', '2026-07-07', '09:00', '11:00', 1, 0),
    makeSession('ses_2', '2026-07-07', '12:00', '14:00', 1, 0),
  ];
  excludedStore.staffHourPolicies = [
    { id: 'pol_exclude', invigilatorId: 'inv_ta_1', staffId: 'TA1', role: 'TA', mode: 'exclude', hoursValue: 0, excludeFromAutoSchedule: true, notes: '' },
  ];
  const excludedResult = runPythonSchedule(toSolverPayload(excludedStore));
  assert(!(excludedResult.assignments || []).some((item) => item.staff_id === 'TA1'), 'Excluded staff must not be auto-assigned.');
  assert(Array.isArray(excludedResult.excludedStaffSkipped) && excludedResult.excludedStaffSkipped.includes('TA1'), 'Excluded diagnostics should report only policy-skipped excluded staff.');
  result.cases.caseE_solverExclude = {
    excludedStaff: 'TA1',
    assignedStaff: excludedResult.assignments.map((item) => item.staff_id),
    excludedStaffSkipped: excludedResult.excludedStaffSkipped,
  };

  const lockedStore = makeBaseStore();
  lockedStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA2', 'TA', 12),
  ];
  lockedStore.sessions = [
    makeSession('ses_locked', '2026-07-08', '09:00', '15:00', 1, 0),
    makeSession('ses_open', '2026-07-08', '16:00', '18:00', 1, 0),
  ];
  lockedStore.assignments = [
    { id: 'asg_locked', sessionId: 'ses_locked', invigilatorId: 'inv_ta_1', role: 'TA' },
  ];
  lockedStore.staffHourPolicies = [
    { id: 'pol_exact', invigilatorId: 'inv_ta_1', staffId: 'TA1', role: 'TA', mode: 'exact', hoursValue: 4, excludeFromAutoSchedule: false, notes: '' },
  ];
  const lockedResult = runPythonSchedule(toSolverPayload(lockedStore));
  assert((lockedResult.assignments || []).some((item) => item.staff_id === 'TA1' && item.session_id === 'ses_locked'), 'Locked assignment must be preserved.');
  assert((lockedResult.overLimitStaff || []).includes('TA1') || (lockedResult.policyViolations || []).some((item) => item.staff_id === 'TA1'), 'Locked over-limit policy must be reported, not silently dropped.');
  result.cases.caseF_lockedAssignments = {
    lockedPreserved: true,
    overLimitStaff: lockedResult.overLimitStaff,
    policyViolations: lockedResult.policyViolations,
  };

  const onCallStore = makeBaseStore();
  onCallStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA1', 'TA', 12),
  ];
  onCallStore.sessions = [
    makeSession('ses_overlap', '2026-07-09', '09:00', '11:00', 1, 0),
  ];
  onCallStore.onCallAssignments = [
    { id: 'oncall_1', date: '2026-07-09', startTime: '09:30', endTime: '10:30', invigilatorId: 'inv_ta_1', role: 'TA' },
  ];
  mods = loadModulesFresh();
  const onCallBlocked = mods.getEligibilityForSession(onCallStore, onCallStore.sessions[0], onCallStore.invigilators[0], mods.buildSchedulingIndexes(onCallStore));
  assert(!onCallBlocked.eligible && onCallBlocked.reason === 'overlap', 'On-call should block overlapping session assignment.');
  result.cases.caseH_onCallBlocksScheduling = {
    reason: onCallBlocked.reason,
  };

  const manualPolicyStore = makeBaseStore();
  manualPolicyStore.invigilators = [makeInvigilator('inv_ta_1', 'TA1', 'TA', 12)];
  manualPolicyStore.sessions = [
    makeSession('ses_locked', '2026-07-10', '09:00', '11:00', 1, 0),
    makeSession('ses_new', '2026-07-10', '12:00', '16:00', 1, 0),
  ];
  manualPolicyStore.assignments = [
    { id: 'asg_1', sessionId: 'ses_locked', invigilatorId: 'inv_ta_1', role: 'TA' },
  ];
  manualPolicyStore.staffHourPolicies = [
    { id: 'pol_reduce', invigilatorId: 'inv_ta_1', staffId: 'TA1', role: 'TA', mode: 'reduce', hoursValue: 4, excludeFromAutoSchedule: false, notes: '' },
  ];
  mods = loadModulesFresh();
  const manualPolicyEligibility = mods.getEligibilityForSession(
    manualPolicyStore,
    manualPolicyStore.sessions[1],
    manualPolicyStore.invigilators[0],
    mods.buildSchedulingIndexes(manualPolicyStore)
  );
  assert(!manualPolicyEligibility.eligible && manualPolicyEligibility.reason === 'policy_limit', 'Manual assignment should reject policy-limit overflow.');
  const manualPolicyMessage = formatPolicyExceededMessage(manualPolicyEligibility, 240);
  assert(manualPolicyMessage.includes('Policy mode:'), 'Manual policy message must include policy mode.');
  assert(manualPolicyMessage.includes('Current hours:'), 'Manual policy message must include current hours.');
  assert(manualPolicyMessage.includes('new duty hours:'), 'Manual policy message must include new duty hours.');
  assert(manualPolicyMessage.includes('allowed hours:'), 'Manual policy message must include allowed hours.');
  result.cases.caseManualValidation = {
    reason: manualPolicyEligibility.reason,
    message: manualPolicyMessage,
  };

  const importStore = makeBaseStore();
  importStore.invigilators = [
    makeInvigilator('inv_ta_1', 'TA001', 'TA', 12),
    makeInvigilator('inv_ta_2', 'TA002', 'TA', 12),
    makeInvigilator('inv_doc_1', 'DR003', 'Doctor', 12),
    makeInvigilator('inv_doc_2', 'DR004', 'Doctor', 12),
  ];
  const policyRows = [
    {
      StaffID: 'TA001',
      Name: 'Example TA',
      Role: 'TA',
      Mode: 'exact',
      HoursValue: 12,
      ExcludeFromAutoSchedule: 'No',
      Notes: 'Example note',
    },
    {
      StaffID: 'TA002',
      Name: 'Example TA Two',
      Role: 'TA',
      Mode: 'add',
      HoursValue: 4,
      ExcludeFromAutoSchedule: 'No',
      Notes: '',
    },
    {
      StaffID: 'DR003',
      Name: 'Example Doctor',
      Role: 'Doctor',
      Mode: 'reduce',
      HoursValue: 3,
      ExcludeFromAutoSchedule: 'No',
      Notes: '',
    },
    {
      StaffID: 'DR004',
      Name: 'Excluded Doctor',
      Role: 'Doctor',
      Mode: 'exclude',
      HoursValue: 0,
      ExcludeFromAutoSchedule: 'Yes',
      Notes: '',
    },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(policyRows), 'StaffHourPolicies');
  const roundTripRows = XLSX.utils.sheet_to_json(workbook.Sheets.StaffHourPolicies);
  const importValidation = validatePolicyImportRows(importStore, [
    ...roundTripRows,
    { StaffID: 'UNKNOWN', Role: 'TA', Mode: 'exact', HoursValue: 5 },
    { StaffID: 'TA001', Role: 'TA', Mode: 'badmode', HoursValue: 5 },
    { StaffID: 'TA001', Role: 'TA', Mode: 'exact', HoursValue: -1 },
  ]);
  assert(importValidation.accepted.length === 4, 'Valid import rows must be accepted.');
  assert(importValidation.rejected.some((item) => item.reason === 'unknown_staff'), 'Unknown StaffID must be rejected.');
  assert(importValidation.rejected.some((item) => item.reason === 'invalid_mode'), 'Invalid mode must be rejected.');
  assert(importValidation.rejected.some((item) => item.reason === 'negative_hours'), 'Negative HoursValue must be rejected.');
  result.cases.caseImportExport = {
    accepted: importValidation.accepted.map((item) => ({
      staffId: item.staffId,
      mode: item.mode,
      hoursValue: item.hoursValue,
      excludeFromAutoSchedule: item.excludeFromAutoSchedule,
    })),
    rejected: importValidation.rejected,
    workbookSheets: workbook.SheetNames,
  };

  result.cases.caseI_roleSeparation = {
    taAverageHours: durationSummary.rawAverageHoursByRole.TA,
    doctorAverageHours: durationSummary.rawAverageHoursByRole.Doctor,
  };

  const fallbackBetterCoverage = runPythonResultComparison(
    {
      totalShortage: 2,
      uncoveredSessionCount: 2,
      placedDuties: 4,
      policyViolationCount: 0,
      overLimitStaffCount: 0,
      roleHourSpread: { TA: 1, Doctor: 0 },
      maxAssignedHoursByRole: { TA: 6, Doctor: 0 },
      dutyCountSpreadByRole: { TA: 0, Doctor: 0 },
    },
    {
      totalShortage: 1,
      uncoveredSessionCount: 1,
      placedDuties: 5,
      policyViolationCount: 0,
      overLimitStaffCount: 0,
      roleHourSpread: { TA: 3, Doctor: 0 },
      maxAssignedHoursByRole: { TA: 7, Doctor: 0 },
      dutyCountSpreadByRole: { TA: 1, Doctor: 0 },
    }
  );
  assert(fallbackBetterCoverage.winner === 'fallback', 'Fallback must win when it has lower shortage.');
  result.cases.caseJ_resultSelectionFallbackCoverage = fallbackBetterCoverage;

  const cpSatBetterFairness = runPythonResultComparison(
    {
      totalShortage: 0,
      uncoveredSessionCount: 0,
      placedDuties: 6,
      policyViolationCount: 0,
      overLimitStaffCount: 0,
      roleHourSpread: { TA: 1, Doctor: 0 },
      maxAssignedHoursByRole: { TA: 6, Doctor: 0 },
      dutyCountSpreadByRole: { TA: 0, Doctor: 0 },
    },
    {
      totalShortage: 0,
      uncoveredSessionCount: 0,
      placedDuties: 6,
      policyViolationCount: 0,
      overLimitStaffCount: 0,
      roleHourSpread: { TA: 3, Doctor: 0 },
      maxAssignedHoursByRole: { TA: 7, Doctor: 0 },
      dutyCountSpreadByRole: { TA: 1, Doctor: 0 },
    }
  );
  assert(cpSatBetterFairness.winner === 'cp_sat', 'CP-SAT must win when coverage is equal and hour fairness is better.');
  result.cases.caseK_resultSelectionCpSatFairness = cpSatBetterFairness;

  const coverageDominatesFairness = runPythonResultComparison(
    {
      totalShortage: 0,
      uncoveredSessionCount: 0,
      placedDuties: 6,
      policyViolationCount: 0,
      overLimitStaffCount: 0,
      roleHourSpread: { TA: 4, Doctor: 0 },
      maxAssignedHoursByRole: { TA: 8, Doctor: 0 },
      dutyCountSpreadByRole: { TA: 2, Doctor: 0 },
    },
    {
      totalShortage: 1,
      uncoveredSessionCount: 1,
      placedDuties: 5,
      policyViolationCount: 0,
      overLimitStaffCount: 0,
      roleHourSpread: { TA: 1, Doctor: 0 },
      maxAssignedHoursByRole: { TA: 6, Doctor: 0 },
      dutyCountSpreadByRole: { TA: 0, Doctor: 0 },
    }
  );
  assert(coverageDominatesFairness.winner === 'cp_sat', 'Coverage must dominate fairness when fallback leaves more shortage.');
  result.cases.caseL_resultSelectionCoverageDominatesFairness = coverageDominatesFairness;

  console.log(JSON.stringify(result, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    result: 'FAIL',
    error: error.message,
  }, null, 2));
  process.exit(1);
}
