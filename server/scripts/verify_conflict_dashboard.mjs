import assert from 'node:assert/strict';
import { buildConflictDashboard } from '../../client/src/conflictDashboard.mjs';

const input = { conflicts: { rows: [{ type: 'Overlap', staffId: 'A', explanation: 'Overlapping duties' }, { type: 'Engagement', staffId: 'A' }] }, overrides: { rows: [
  ...[['09:00', '09:45'], ['09:30', '10:00']].map(([engagementStart, engagementEnd]) => ({ staffId: 'A', name: 'A', role: 'TA', dutyType: 'Session', dutyId: 'D1', date: '2026-11-01', startTime: '09:00', endTime: '10:00', engagementStart, engagementEnd, currentlyAllowed: 'Yes', reason: 'Cover exam shortage' })),
  { staffId: 'B', name: 'B', role: 'TA', dutyType: 'OnCall', dutyId: 'D1', date: '2026-11-01', startTime: '09:00', endTime: '10:00', engagementStart: '09:30', engagementEnd: '10:00', currentlyAllowed: 'No', reason: 'Existing overlap' },
] }, workload: { rows: [
  { staffId: 'A', role: 'TA', policyMode: 'default', assignedHours: 4, assignedMinutes: 240, effectiveAllowedHours: 2, sessionHours: 3, onCallHours: 1 },
  { staffId: 'B', role: 'TA', policyMode: 'exact', assignedHours: 3, assignedMinutes: 180, effectiveAllowedHours: 2 },
  { staffId: 'C', role: 'TA', policyMode: 'default', assignedHours: 2, assignedMinutes: 120, sessionHours: 2, onCallHours: 0 },
  { staffId: 'D', role: 'TA', policyMode: 'default', assignedHours: 0, excludeFromAutoSchedule: true },
] }, coverage: { rows: [{ date: '2026-11-01', taNeeded: 3, taAssigned: 1, doctorNeeded: 0, doctorAssigned: 2 }] }, onCall: { periods: [{ date: '2026-11-01', onCallTARemaining: 2, onCallDoctorRemaining: 1 }] } };
const before = JSON.stringify(input);
const result = buildConflictDashboard(input);
assert.deepEqual(result.summary, { review: 3, permitted: 1, affectedStaff: 2, sessionGaps: 2, onCallGaps: 3 });
assert.equal(result.issues.filter((row) => row.type === 'Permitted override').length, 1, 'One affected duty, despite multiple engagements.');
assert.equal(result.issues.find((row) => row.type === 'Permitted override').overlapMinutes, 60, 'Overlapping engagements counted once.');
assert.equal(result.issues.find((row) => row.type === 'Blocked engagement').overlapMinutes, 30);
assert.equal(result.issues.filter((row) => row.type === 'Policy hours').length, 1, 'Default targets are not hard caps.');
assert.deepEqual(result.balance[0], { role: 'TA', staffCount: 2, totalSpread: 2, sessionSpread: 1, onCallSpread: 1 });
assert.equal(result.gaps.find((row) => row.kind === 'Session').doctorGap, 0, 'Overstaffing does not cancel shortages in the other role.');
assert.equal(JSON.stringify(input), before, 'Dashboard does not change source reports.');
const empty = buildConflictDashboard({ conflicts: {}, overrides: {}, workload: {}, coverage: {}, onCall: {} });
assert.equal(empty.summary.review, 0);
assert.equal(empty.gaps.length, 0);
console.log('PASS: conflict classification, permission checks, engagement deduplication and union minutes, policy caps, role-specific gaps, default staff balance, empty data, and read-only inputs.');
