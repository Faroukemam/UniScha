const assert = require('node:assert/strict');
const { buildEngagementOverrideReport } = require('../reports');
const store = {
  sessions: [{ id: 'S', date: '2026-11-01', startTime: '09:00', endTime: '10:00', taNeeded: 1, doctorNeeded: 0, room: 'R1', courseName: 'Exam' }],
  invigilators: [{ id: 'A', staffId: 'TA01', name: 'Staff A', role: 'TA', department: 'D1' }],
  assignments: [{ id: 'ASG', sessionId: 'S', invigilatorId: 'A', role: 'TA', assignmentSource: 'auto', engagementOverrideReason: 'Cover exam shortage' }],
  onCallAssignments: [{ id: 'OC', invigilatorId: 'A', date: '2026-11-01', startTime: '10:00', endTime: '11:00', role: 'TA' }],
  engagements: [
    { id: 'E1', staffId: 'TA01', date: '2026-11-01', startTime: '08:30', endTime: '09:30', engagement: 1, notes: 'Meeting' },
    { id: 'E2', staffId: 'TA01', date: '2026-11-01', startTime: '09:15', endTime: '10:30', engagement: 1, notes: 'Travel' },
    { id: 'E3', staffId: 'TA01', date: '2026-11-01', startTime: '09:00', endTime: '11:00', engagement: 0 },
    { id: 'E4', staffId: 'TA01', date: '2026-11-01', startTime: '11:00', endTime: '12:00', engagement: 1 },
  ],
  staffHourPolicies: [{ id: 'P', invigilatorId: 'A', staffId: 'TA01', role: 'TA', mode: 'default', allowEngagementOverride: false }],
  superAssignments: [], controlSessions: [], controlAssignments: [],
  onCallConfig: { mode: 'fixed_per_period', fixedTAsPerPeriod: 0, fixedDoctorsPerPeriod: 0 },
};
const before = JSON.stringify(store);
const report = buildEngagementOverrideReport(store);
assert.deepEqual(report.summary, { affectedStaff: 1, affectedDuties: 2, overlapMinutes: 90 });
assert.equal(report.rows.length, 3, 'A detail row per actual engagement overlap.');
assert.ok(report.rows.every((row) => row.currentlyAllowed === 'No'), 'Existing conflicts remain reportable after opting out.');
assert.equal(report.rows.find((row) => row.engagementId === 'E1').overlapMinutes, 30);
assert.equal(report.rows.find((row) => row.dutyType === 'OnCall').overlapMinutes, 30);
assert.equal(report.rows.find((row) => row.dutyType === 'Session').assignmentSource, 'auto');
assert.equal(report.rows.find((row) => row.dutyType === 'Session').reason, 'Cover exam shortage');
assert.match(report.rows.find((row) => row.dutyType === 'OnCall').reason, /not recorded/);
for (const filters of [{ role: 'Doctor' }, { staffId: 'other' }, { department: 'D2' }, { day: '2026-11-02' }, { startDate: '2026-11-02' }, { endDate: '2026-10-31' }]) {
  assert.equal(buildEngagementOverrideReport(store, filters).rows.length, 0);
}
assert.equal(buildEngagementOverrideReport(store, { staffId: 'A' }).rows.length, 3);
assert.equal(buildEngagementOverrideReport(store, { staffId: 'TA01' }).rows.length, 3);
assert.equal(JSON.stringify(store), before, 'Reports never modify the saved data.');
console.log('PASS: engagement report, affected staff, all overlaps, union totals, current opt-outs, assignment sources, filters and read-only behavior.');
