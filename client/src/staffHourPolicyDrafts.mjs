export function makeStaffHourPolicyDraft(row) {
  const policy = row.policy || null;
  return {
    id: policy?.id || '',
    invigilatorId: row.id,
    staffId: row.staffId,
    role: row.role,
    mode: policy?.mode || 'default',
    hoursValue: Number(policy?.hoursValue || 0),
    excludeFromAutoSchedule: Boolean(policy?.excludeFromAutoSchedule || policy?.mode === 'exclude'),
    preferConsecutiveDuties: Boolean(policy?.preferConsecutiveDuties),
    preferConsecutiveDays: Boolean(policy?.preferConsecutiveDays),
    allowEngagementOverride: policy?.allowEngagementOverride ?? true,
    notes: policy?.notes || '',
  };
}

export function reconcileStaffHourPolicyDrafts(rows, current, editedIds) {
  return Object.fromEntries(rows.map((row) => [
    row.id,
    editedIds.has(row.id) && current[row.id] ? current[row.id] : makeStaffHourPolicyDraft(row),
  ]));
}
