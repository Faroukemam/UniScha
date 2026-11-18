// Run: node server/scripts/verify_staff_schedule.mjs (no saved data used).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildStaffSchedule, staffScheduleExportRows } from '../../client/src/staffSchedule.mjs';
const require = createRequire(import.meta.url);
const { buildStaffReport } = require('../reports');

const store = {
  invigilators: [
    { id: 'other', staffId: 'target', name: 'Other staff', role: 'TA' },
    { id: 'target', staffId: '001', name: 'Selected doctor', role: 'Doctor', department: 'Engineering', maxHours: 20 },
    { id: 'empty', staffId: '003', name: 'Unassigned', role: 'TA' },
  ],
  sessions: [
    { id: 'S1', date: '2026-11-01', startTime: '09:00', endTime: '10:00', room: 'Lab (East)', courseNames: ['CS101', 'CS102'], taNeeded: 1, doctorNeeded: 1 },
    { id: 'S2', date: '2026-11-01', startTime: '10:00', endTime: '11:00', room: 'R2', courseName: 'MATH', taNeeded: 0, doctorNeeded: 0 },
    { id: 'S3', date: '2026-11-03', startTime: '09:00', endTime: '12:00', room: 'R3', courseName: 'SCI', taNeeded: 0, doctorNeeded: 0 },
  ],
  assignments: [{ id: 'A1', sessionId: 'S1', invigilatorId: 'target', role: 'Doctor' }, { id: 'A2', sessionId: 'S1', invigilatorId: 'other', role: 'TA' }],
  onCallAssignments: [{ id: 'O1', date: '2026-11-01', startTime: '10:00', endTime: '11:00', invigilatorId: 'target', role: 'Doctor' }],
  superAssignments: [{ id: 'SUPER1', date: '2026-11-03', invigilatorId: 'target', role: 'Doctor' }],
  controlSessions: [{ id: 'C1', date: '2026-11-01', startTime: '13:00', endTime: '14:00', room: 'Control (Main)', courseName: 'Control desk', taNeeded: 0, doctorNeeded: 1 }],
  controlAssignments: [{ id: 'CA1', controlSessionId: 'C1', invigilatorId: 'target', role: 'Doctor' }],
  engagements: [], onCallConfig: {},
  staffHourPolicies: [{ id: 'P', invigilatorId: 'target', staffId: '001', role: 'Doctor', mode: 'exact', hoursValue: 20, preferConsecutiveDuties: true, preferConsecutiveDays: false }],
};
const before = JSON.stringify(store);
const report = buildStaffReport(store, {}, 'target');
assert.equal(report.person.id, 'target', 'An internal ID must win over another person’s matching staff ID.');
assert.equal(report.person.staffId, '001');
assert.equal(report.policy.preferConsecutiveDuties, true);
assert.equal(report.policy.preferConsecutiveDays, false);
assert.deepEqual(report.sessions.map((row) => row.dutyType), ['Session', 'OnCall', 'Control', 'Super']);
assert.equal(report.sessions.find((row) => row.id === 'A1').room, 'Lab (East)', 'Room names containing parentheses must remain intact.');
assert.equal(report.sessions.find((row) => row.id === 'CA1').room, 'Control (Main)');
assert.equal(report.sessions.find((row) => row.id === 'O1').room, '', 'An on-call room count is not a room name.');
assert.equal(report.sessions.find((row) => row.id === 'A1').courseCode, 'CS101; CS102');
assert.equal(report.summary.totalAssignedHours, 6);
assert.equal(report.summary.workedDaysCount, 2);
assert.equal(buildStaffReport(store, {}, '001').person.id, 'target');
assert.equal(buildStaffReport(store, {}, 'missing').person, null);
assert.deepEqual(buildStaffReport(store, {}, 'empty').sessions, []);
assert.equal(buildStaffReport(store, { startDate: '2026-11-03' }, 'target').sessions.length, 1);

const schedule = buildStaffSchedule([...report.sessions].reverse());
assert.equal(schedule.dutyCount, 4);
assert.equal(schedule.totalMinutes, 360);
assert.equal(schedule.workedDays, 2);
assert.equal(schedule.workingDayGaps, 1);
assert.equal(schedule.idleMinutes, 120);
assert.equal(schedule.days[0].minutes, 180);
assert.deepEqual(schedule.rows.map((row) => row.id), ['A1', 'O1', 'CA1', 'SUPER1']);
const filtered = buildStaffSchedule(report.sessions, { startDate: '2026-11-01', endDate: '2026-11-01', dutyType: 'OnCall' });
assert.equal(filtered.dutyCount, 1);
assert.equal(filtered.totalMinutes, 60);
assert.equal(filtered.workingDayGaps, 0);
assert.equal(filtered.idleMinutes, 0);
assert.equal(buildStaffSchedule(report.sessions, { startDate: '2026-11-04' }).rows.length, 0);
assert.equal(buildStaffSchedule(report.sessions, { startDate: '2026-11-04', endDate: '2026-11-01' }).invalidRange, true);
assert.deepEqual(buildStaffSchedule([]).days, []);

// Overlapping and nested duties must not invent additional idle time.
const overlap = buildStaffSchedule([
  { date: '2026-11-01', startTime: '09:00', endTime: '12:00', durationMinutes: 180, dutyType: 'Session' },
  { date: '2026-11-01', startTime: '10:00', endTime: '11:00', durationMinutes: 60, dutyType: 'Control' },
  { date: '2026-11-01', startTime: '12:00', endTime: '13:00', durationMinutes: 60, dutyType: 'OnCall' },
]);
assert.equal(overlap.idleMinutes, 0);
const exported = staffScheduleExportRows(report.person, filtered.rows);
assert.equal(exported.length, 1);
assert.equal(exported[0].StaffID, '001');
assert.equal(exported[0].Name, 'Selected doctor');
assert.equal(exported[0].Duty, 'On-call');
assert.equal(exported[0].Hours, 1);
assert.equal(JSON.stringify(store), before, 'Reading a staff schedule must never change assignments or policies.');
console.log('PASS: all duty types, staff identity/isolation, precise rooms and courses, date/type filters, totals, continuity gaps, overlap handling, export scope and read-only behavior.');
