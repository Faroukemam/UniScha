// Run: node server/scripts/verify_staff_hour_policy_drafts.mjs
import assert from 'node:assert/strict';
import { makeStaffHourPolicyDraft, reconcileStaffHourPolicyDrafts } from '../../client/src/staffHourPolicyDrafts.mjs';

const original = ['exact', 'add', 'reduce', 'exclude', 'default'].map((mode) => ({ id: mode, staffId: mode, role: 'TA', policy: null }));
const oldDrafts = reconcileStaffHourPolicyDrafts(original, {}, new Set());
const saved = original.map((row) => ({ ...row, policy: { id: `P_${row.id}`, mode: row.id, hoursValue: 4, excludeFromAutoSchedule: row.id === 'exclude', preferConsecutiveDuties: row.id === 'exact', preferConsecutiveDays: row.id === 'add', notes: 'Imported' } }));

// An overlapping background refresh can finish after an import. Untouched old
// drafts must always be replaced, even if another response already saw new data.
const refreshed = reconcileStaffHourPolicyDrafts(saved, oldDrafts, new Set());
for (const row of saved) assert.deepEqual(refreshed[row.id], makeStaffHourPolicyDraft(row));
const repeated = reconcileStaffHourPolicyDrafts(saved, refreshed, new Set());
assert.deepEqual(repeated, refreshed);
assert.equal(refreshed.exact.preferConsecutiveDuties, true);
assert.equal(refreshed.exact.preferConsecutiveDays, false);
assert.equal(refreshed.add.preferConsecutiveDays, true);
assert.equal(oldDrafts.exact.preferConsecutiveDuties, false);
assert.equal(oldDrafts.exact.preferConsecutiveDays, false);

// A real local edit survives a background refresh, then import/Refresh clears
// the explicit edit marker and shows the saved policy again.
const local = { ...refreshed, exact: { ...refreshed.exact, hoursValue: 9 } };
const kept = reconcileStaffHourPolicyDrafts(saved, local, new Set(['exact']));
assert.equal(kept.exact.hoursValue, 9);
assert.equal(kept.reduce.hoursValue, 4);
const imported = reconcileStaffHourPolicyDrafts(saved, kept, new Set());
assert.equal(imported.exact.hoursValue, 4);
assert.equal(imported.exact.mode, 'exact');
// Saving one staff member must leave another person's local work intact.
const multipleEdits = { ...refreshed, exact: { ...refreshed.exact, hoursValue: 5 }, reduce: { ...refreshed.reduce, notes: 'Keep this unsaved note' } };
const editedStaff = new Set(['exact', 'reduce']);
const afterSave = saved.map((row) => row.id === 'exact' ? { ...row, policy: { ...row.policy, hoursValue: 5 } } : row);
editedStaff.delete('exact');
const reconciledAfterSave = reconcileStaffHourPolicyDrafts(afterSave, multipleEdits, editedStaff);
assert.equal(reconciledAfterSave.exact.hoursValue, 5);
assert.equal(reconciledAfterSave.reduce.notes, 'Keep this unsaved note');
assert.deepEqual(reconcileStaffHourPolicyDrafts([], imported, new Set()), {});
console.log('PASS: all imported modes refresh, repeated responses stay current, explicit edits survive background refresh, import clears stale drafts.');
