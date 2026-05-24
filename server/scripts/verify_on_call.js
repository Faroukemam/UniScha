const fs = require('fs');
const os = require('os');
const path = require('path');
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeStore(roomCount, options = {}) {
  const date = options.date || '2026-06-01';
  const startTime = options.startTime || '09:30';
  const endTime = options.endTime || '11:30';
  return {
    sessions: Array.from({ length: roomCount }, (_, index) => ({
      id: `ses_${index + 1}`,
      courseNames: [`C${index + 1}`],
      courseName: `C${index + 1}`,
      room: `R${index + 1}`,
      date,
      startTime,
      endTime,
      taNeeded: 1,
      doctorNeeded: 0,
      totalNeeded: 1,
      notes: '',
    })),
    invigilators: [
      { id: 'inv_ta_1', staffId: 'TA1', name: 'TA One', role: 'TA', loadType: 'full', maxHours: 8, department: '', notes: '' },
      { id: 'inv_ta_2', staffId: 'TA2', name: 'TA Two', role: 'TA', loadType: 'full', maxHours: 8, department: '', notes: '' },
      { id: 'inv_ta_3', staffId: 'TA3', name: 'TA Three', role: 'TA', loadType: 'full', maxHours: 8, department: '', notes: '' },
      { id: 'inv_doc_1', staffId: 'DOC1', name: 'Doctor One', role: 'Doctor', loadType: 'full', maxHours: 8, department: '', notes: '' },
      { id: 'inv_doc_2', staffId: 'DOC2', name: 'Doctor Two', role: 'Doctor', loadType: 'full', maxHours: 8, department: '', notes: '' },
    ],
    engagements: [],
    assignments: [],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: [],
    onCallAssignments: [],
    onCallConfig: options.onCallConfig || {},
    staffHourPolicies: [],
  };
}

function assignOnCall(mods, store, date, startTime, endTime, invigilatorId) {
  const person = store.invigilators.find((item) => item.id === invigilatorId);
  assert(person, 'Invigilator not found');
  const need = mods.buildOnCallNeeds(store).find((item) => item.date === date && item.startTime === startTime && item.endTime === endTime);
  assert(need, 'On-call period not found');
  const eligibility = mods.getEligibilityForOnCall(store, need, person, mods.buildSchedulingIndexes(store));
  assert(eligibility.eligible, `Expected on-call eligibility, got ${eligibility.reason || 'blocked'}`);
  const assignment = {
    id: `oncall_test_${store.onCallAssignments.length + 1}`,
    date,
    startTime,
    endTime,
    invigilatorId,
    role: person.role,
  };
  store.onCallAssignments.push(assignment);
  return assignment;
}

function buildExportWorkbook(mods, store) {
  const workbook = XLSX.utils.book_new();
  const onCallNeedRows = mods.buildOnCallNeeds(store).map((need) => ({
    Date: need.date,
    Start: need.startTime,
    End: need.endTime,
    ActiveRooms: need.activeRoomCount,
    OnCallTANeeded: need.onCallTANeeded,
    OnCallDoctorNeeded: need.onCallDoctorNeeded,
  }));
  const onCallAssignmentRows = store.onCallAssignments.map((item) => ({
    AssignmentID: item.id,
    Date: item.date,
    Start: item.startTime,
    End: item.endTime,
    InvigilatorID: item.invigilatorId,
    Role: item.role,
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(onCallNeedRows.length ? onCallNeedRows : [{ Notice: 'No data' }]), 'OnCallNeeds');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(onCallAssignmentRows.length ? onCallAssignmentRows : [{ Notice: 'No data' }]), 'OnCallAssignments');
  const filePath = path.join(os.tmpdir(), `oncall_verify_${Date.now()}.xlsx`);
  XLSX.writeFile(workbook, filePath);
  return { filePath, onCallNeedRows, onCallAssignmentRows };
}

function run() {
  const examples = {};

  {
    const mods = loadModulesFresh();
    const need3 = mods.buildOnCallNeeds(makeStore(3))[0];
    assert(need3.onCallTANeeded === 1, 'Default rooms-based rule should need 1 TA for 3 rooms');
    assert(need3.onCallDoctorNeeded === 1, 'Default rooms-based rule should need 1 Doctor for 3 rooms');
    examples.defaultRooms3 = { activeRooms: 3, onCallTANeeded: 1, onCallDoctorNeeded: 1 };
  }

  {
    const mods = loadModulesFresh();
    const need6 = mods.buildOnCallNeeds(makeStore(6))[0];
    assert(need6.onCallTANeeded === 2, 'Default rooms-based rule should need 2 TA for 6 rooms');
    assert(need6.onCallDoctorNeeded === 1, 'Default rooms-based rule should need 1 Doctor for 6 rooms');
    examples.defaultRooms6 = { activeRooms: 6, onCallTANeeded: 2, onCallDoctorNeeded: 1 };
  }

  {
    const mods = loadModulesFresh();
    const zeroStore = makeStore(2, {
      onCallConfig: {
        mode: 'rooms_based',
        taRoomsPerStep: 3,
        taStaffPerStep: 1,
        taBelowThresholdMode: 'zero',
        doctorRoomsPerStep: 6,
        doctorStaffPerStep: 1,
        doctorBelowThresholdMode: 'zero',
      },
    });
    const need = mods.buildOnCallNeeds(zeroStore)[0];
    assert(need.onCallTANeeded === 0, 'Zero-below-threshold should allow 0 TA for 2 rooms');
    assert(need.onCallDoctorNeeded === 0, 'Zero-below-threshold should allow 0 Doctor for 2 rooms');
    examples.zeroBelowThreshold = { activeRooms: 2, onCallTANeeded: 0, onCallDoctorNeeded: 0 };
  }

  {
    const mods = loadModulesFresh();
    const excludedStore = makeStore(3, {
      onCallConfig: {
        excludedInvigilatorIds: ['inv_ta_1', 'inv_doc_1'],
      },
    });
    const need = mods.buildOnCallNeeds(excludedStore)[0];
    const context = mods.buildSchedulingIndexes(excludedStore);
    const taExcluded = mods.getEligibilityForOnCall(excludedStore, need, excludedStore.invigilators.find((item) => item.id === 'inv_ta_1'), context);
    const docExcluded = mods.getEligibilityForOnCall(excludedStore, need, excludedStore.invigilators.find((item) => item.id === 'inv_doc_1'), context);
    assert(!taExcluded.eligible && taExcluded.reason === 'on_call_excluded', 'Excluded TA should be blocked from on-call');
    assert(!docExcluded.eligible && docExcluded.reason === 'on_call_excluded', 'Excluded Doctor should be blocked from on-call');
    examples.excludedInvigilators = { ta: taExcluded.reason, doctor: docExcluded.reason };
  }

  {
    const mods = loadModulesFresh();
    const fixedStore = makeStore(2, {
      onCallConfig: {
        mode: 'fixed_per_period',
        fixedTAsPerPeriod: 2,
        fixedDoctorsPerPeriod: 1,
      },
    });
    const need = mods.buildOnCallNeeds(fixedStore)[0];
    assert(need.onCallTANeeded === 2, 'Fixed mode should use the configured TA count');
    assert(need.onCallDoctorNeeded === 1, 'Fixed mode should use the configured Doctor count');
    examples.fixedPerPeriod = { onCallTANeeded: 2, onCallDoctorNeeded: 1 };
  }

  const store = makeStore(4);
  const mods = loadModulesFresh();
  const primaryNeed = mods.buildOnCallNeeds(store)[0];
  const created = assignOnCall(mods, store, primaryNeed.date, primaryNeed.startTime, primaryNeed.endTime, 'inv_ta_1');
  assert(store.onCallAssignments.length === 1, 'Manual on-call assign should create one assignment');

  const workloadAfterAssign = mods.buildWorkloadView(store).find((item) => item.id === 'inv_ta_1');
  assert(workloadAfterAssign.onCallCount === 1, 'Workload should include one on-call duty');
  assert(workloadAfterAssign.onCallMinutes === 120, 'Workload should include on-call minutes');

  const reportsAfterAssign = mods.buildReportsSummary(store, {});
  assert(Number(reportsAfterAssign.cards.onCallAssignments || 0) === 1, 'Reports summary should include on-call assignment count');
  assert(Number(reportsAfterAssign.cards.onCallHours || 0) === 2, 'Reports summary should include on-call hours');

  const schedulingContext = mods.buildSchedulingIndexes(store);
  const overlapSession = store.sessions[0];
  const blockedSessionEligibility = mods.getEligibilityForSession(store, overlapSession, store.invigilators.find((item) => item.id === 'inv_ta_1'), schedulingContext);
  assert(!blockedSessionEligibility.eligible && blockedSessionEligibility.reason === 'overlap', 'On-call should block overlapping normal session assignment');

  const overlapStore = clone(store);
  overlapStore.sessions.push({
    id: 'ses_overlap',
    courseNames: ['Overlap'],
    courseName: 'Overlap',
    room: 'R9',
    date: primaryNeed.date,
    startTime: '10:00',
    endTime: '12:00',
    taNeeded: 1,
    doctorNeeded: 0,
    totalNeeded: 1,
    notes: '',
  });
  const overlapMods = loadModulesFresh();
  const overlapNeed = overlapMods.buildOnCallNeeds(overlapStore).find((item) => item.startTime === '10:00');
  const overlapContext = overlapMods.buildSchedulingIndexes(overlapStore);
  const overlappingOnCall = overlapMods.getEligibilityForOnCall(overlapStore, overlapNeed, overlapStore.invigilators.find((item) => item.id === 'inv_ta_1'), overlapContext);
  assert(!overlappingOnCall.eligible && overlappingOnCall.reason === 'overlap', 'On-call should block another overlapping on-call');

  const maxHoursStore = makeStore(4);
  maxHoursStore.invigilators.find((item) => item.id === 'inv_doc_1').maxHours = 1;
  const maxMods = loadModulesFresh();
  const maxNeed = maxMods.buildOnCallNeeds(maxHoursStore)[0];
  const maxContext = maxMods.buildSchedulingIndexes(maxHoursStore);
  const maxHoursEligibility = maxMods.getEligibilityForOnCall(maxHoursStore, maxNeed, maxHoursStore.invigilators.find((item) => item.id === 'inv_doc_1'), maxContext);
  assert(!maxHoursEligibility.eligible && maxHoursEligibility.reason === 'max_hours', 'Max-hours should block on-call assignment');

  {
    const autoStore = makeStore(6);
    autoStore.staffHourPolicies.push(
      { id: 'pol_doc_1', invigilatorId: 'inv_doc_1', staffId: 'DOC1', role: 'Doctor', mode: 'exact', hoursValue: 8, excludeFromAutoSchedule: false, notes: '' },
      { id: 'pol_doc_2', invigilatorId: 'inv_doc_2', staffId: 'DOC2', role: 'Doctor', mode: 'exact', hoursValue: 8, excludeFromAutoSchedule: false, notes: '' },
    );
    autoStore.controlSessions.push({
      id: 'ctrl_1',
      courseName: 'Control',
      room: 'Control Room',
      date: '2026-06-01',
      startTime: '09:30',
      endTime: '11:30',
      taNeeded: 1,
      doctorNeeded: 0,
      totalNeeded: 1,
      notes: '',
    });
    autoStore.controlAssignments.push({
      id: 'ctrl_asg_1',
      controlSessionId: 'ctrl_1',
      invigilatorId: 'inv_ta_1',
      role: 'TA',
    });
    const autoMods = loadModulesFresh();
    const autoResult = autoMods.buildOnCallAutoScheduleResult(autoStore, { dryRun: true });
    assert(autoResult.summary.addedCount > 0, 'Auto-assign should add on-call assignments when shortages exist');
    assert(autoResult.summary.totalRemainingShortage === 0, 'Auto-assign should fill all reachable shortages in the isolated case');
    const firstTA = autoResult.summary.createdAssignments.find((item) => item.role === 'TA');
    assert(firstTA && firstTA.invigilator.id !== 'inv_ta_1', 'Auto-assign should prefer the lower projected-load TA when another TA already has control load');
    examples.autoAssign = {
      addedCount: autoResult.summary.addedCount,
      totalRemainingShortage: autoResult.summary.totalRemainingShortage,
      firstTAChosen: firstTA?.invigilator?.id || null,
    };
  }

  {
    const autoStore = makeStore(3, {
      onCallConfig: {
        mode: 'fixed_per_period',
        fixedTAsPerPeriod: 1,
        fixedDoctorsPerPeriod: 1,
        excludedInvigilatorIds: ['inv_ta_1', 'inv_doc_1'],
      },
    });
    const autoMods = loadModulesFresh();
    const autoResult = autoMods.buildOnCallAutoScheduleResult(autoStore, { dryRun: true });
    const assignedIds = new Set((autoResult.summary.createdAssignments || []).map((item) => item.invigilator?.id));
    assert(!assignedIds.has('inv_ta_1'), 'Auto-assign should skip excluded TA');
    assert(!assignedIds.has('inv_doc_1'), 'Auto-assign should skip excluded Doctor');
  }

  {
    const policyStore = makeStore(3, {
      onCallConfig: {
        mode: 'fixed_per_period',
        fixedTAsPerPeriod: 1,
        fixedDoctorsPerPeriod: 0,
      },
    });
    policyStore.invigilators = [
      { id: 'inv_ta_1', staffId: 'TA1', name: 'TA One', role: 'TA', loadType: 'full', maxHours: 8, department: '', notes: '' },
    ];
    policyStore.staffHourPolicies = [
      { id: 'pol_1', invigilatorId: 'inv_ta_1', staffId: 'TA1', role: 'TA', mode: 'exact', hoursValue: 1, excludeFromAutoSchedule: false, notes: '' },
    ];
    const policyMods = loadModulesFresh();
    const policyNeed = policyMods.buildOnCallNeeds(policyStore)[0];
    const policyEligibility = policyMods.getEligibilityForOnCall(policyStore, policyNeed, policyStore.invigilators[0], policyMods.buildSchedulingIndexes(policyStore));
    assert(!policyEligibility.eligible && policyEligibility.reason === 'policy_limit', 'Staff-hour policy should block on-call assignment');
    const autoResult = policyMods.buildOnCallAutoScheduleResult(policyStore, { dryRun: true });
    assert(autoResult.summary.addedCount === 0, 'Auto-assign should respect staff-hour policy and not add blocked staff');
  }

  {
    const engagementStore = makeStore(3, {
      onCallConfig: {
        mode: 'fixed_per_period',
        fixedTAsPerPeriod: 1,
        fixedDoctorsPerPeriod: 0,
      },
    });
    engagementStore.invigilators = [
      { id: 'inv_ta_1', staffId: 'TA1', name: 'TA One', role: 'TA', loadType: 'full', maxHours: 8, department: '', notes: '' },
    ];
    engagementStore.engagements = [
      { id: 'eng_1', staffId: 'TA1', date: '2026-06-01', startTime: '09:30', endTime: '11:30', engagement: 1, notes: '' },
    ];
    const engagementMods = loadModulesFresh();
    const engagementNeed = engagementMods.buildOnCallNeeds(engagementStore)[0];
    const engagementEligibility = engagementMods.getEligibilityForOnCall(engagementStore, engagementNeed, engagementStore.invigilators[0], engagementMods.buildSchedulingIndexes(engagementStore));
    assert(!engagementEligibility.eligible && engagementEligibility.reason === 'engagement', 'Engagement should block on-call assignment');
    const autoResult = engagementMods.buildOnCallAutoScheduleResult(engagementStore, { dryRun: true });
    assert(autoResult.summary.addedCount === 0, 'Auto-assign should respect engagement blocking');
  }

  const exportStore = makeStore(4);
  assignOnCall(loadModulesFresh(), exportStore, primaryNeed.date, primaryNeed.startTime, primaryNeed.endTime, 'inv_ta_1');
  const exportResult = buildExportWorkbook(loadModulesFresh(), exportStore);
  const workbook = XLSX.readFile(exportResult.filePath);
  const onCallAssignmentSheetRows = XLSX.utils.sheet_to_json(workbook.Sheets.OnCallAssignments);
  assert(onCallAssignmentSheetRows.length >= 1, 'Workbook export should include OnCallAssignments rows after assignment exists');
  fs.unlinkSync(exportResult.filePath);

  console.log(JSON.stringify({
    result: 'PASS',
    examples,
    conflictChecks: {
      onCallBlocksSession: blockedSessionEligibility.reason,
      onCallBlocksOnCall: overlappingOnCall.reason,
      maxHours: maxHoursEligibility.reason,
    },
    workloadAfterAssign: {
      onCallCount: workloadAfterAssign.onCallCount,
      onCallMinutes: workloadAfterAssign.onCallMinutes,
      totalMinutes: workloadAfterAssign.totalMinutes,
    },
    reportsAfterAssign: reportsAfterAssign.cards,
    exportAfterAssign: {
      onCallNeedRows: exportResult.onCallNeedRows.length,
      onCallAssignmentRows: exportResult.onCallAssignmentRows.length,
      workbookSheetRows: onCallAssignmentSheetRows.length,
    },
    recreatedAssignmentId: created.id,
  }, null, 2));
}

run();
