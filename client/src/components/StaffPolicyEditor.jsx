const modes = {
  default: 'Use the role average as a target. A positive Max Hours value still limits assignments.',
  exact: 'Set a fixed hour cap. This does not guarantee exactly this many assigned hours.',
  add: 'Set the cap to the role average plus the entered hours.',
  reduce: 'Set the cap to the role average minus the entered hours, with a minimum of zero.',
  exclude: 'Exclude this person from normal automatic scheduling.',
};

export default function StaffPolicyEditor({ row, draft, preview, dirty, busy, onChange, onSave, onReset }) {
  if (!row) return <aside className="panel policy-editor"><div className="empty-state">Select a staff member to review their hour policy.</div></aside>;
  const hoursValid = draft.hoursValue !== '' && Number.isFinite(Number(draft.hoursValue)) && Number(draft.hoursValue) >= 0;
  const custom = ['exact', 'add', 'reduce'].includes(draft.mode);
  const assigned = Number(row.currentAssignedMinutes ?? Number(row.currentAssignedHours || 0) * 60) / 60;
  const overLimit = preview.hasLimit && assigned > preview.limitHours;
  return <aside className="panel policy-editor" aria-label="Staff policy editor">
    <div className="panel-head"><div><span className="rules-eyebrow">STAFF POLICY</span><h2 dir="auto">{row.name}</h2><p>{row.staffId} / {row.role}{row.department ? ` / ${row.department}` : ''}</p></div><span className={`ops-badge ${dirty ? 'tone-warning' : 'tone-neutral'}`} role="status">{dirty ? 'Unsaved changes' : 'Saved policy'}</span></div>
    <div className="policy-workload"><div><span>Assigned total</span><strong>{assigned.toFixed(2)}<small> h</small></strong></div><div><span>On-call</span><strong>{Number(row.onCallHours || 0).toFixed(2)}<small> h</small></strong></div><div><span>Role average</span><strong>{Number(row.effectivePolicy?.rawAverageHours || 0).toFixed(2)}<small> h</small></strong></div></div>
    <fieldset className="ops-fieldset" disabled={busy}>
      <div className="policy-editor-section"><h3>Workload limits</h3><div className="form-grid policy-limit-fields"><label><span>Policy mode</span><select value={draft.mode} onChange={(event) => onChange('mode', event.target.value)}><option value="default">Role average</option><option value="exact">Fixed cap (exact)</option><option value="add">Add to average</option><option value="reduce">Reduce from average</option><option value="exclude">Exclude from scheduling</option></select></label><label><span>{draft.mode === 'exact' ? 'Hour cap' : 'Adjustment hours'}</span><input type="number" min="0" step="0.5" value={draft.hoursValue} disabled={!custom} onChange={(event) => onChange('hoursValue', event.target.value)} /></label></div><p className="ops-help">{modes[draft.mode]}</p>
        <div className="policy-limit-preview"><div><span>Effective limit</span><strong>{preview.hasLimit ? `${preview.limitHours.toFixed(2)}h` : 'No fixed cap'}</strong></div><div><span>Remaining capacity</span><strong>{preview.hasLimit ? `${Math.max(0, preview.limitHours - assigned).toFixed(2)}h` : 'No fixed cap'}</strong></div></div>
        {overLimit ? <p className="ops-inline-warning" role="status">Current assignments exceed this limit by {(assigned - preview.limitHours).toFixed(2)}h. Saving the policy does not change existing assignments.</p> : null}
        {custom && !hoursValid ? <p className="ops-inline-warning" role="alert">Enter a valid number of hours, zero or greater.</p> : null}
      </div>
      <div className="policy-editor-section"><h3>Scheduling preferences</h3><p className="ops-help">Preferences follow coverage, workload balance, and the saved scheduling priorities.</p>
        {[
          ['preferConsecutiveDuties', 'Consecutive duties', 'Reduce idle time between duties within the same day.'],
          ['preferConsecutiveDays', 'Consecutive working days', 'Reduce calendar days off between working dates.'],
          ['allowEngagementOverride', 'Allow engagement overrides', 'Allow automatic assignments during engagements. Hour limits and duty conflicts still apply.'],
          ['excludeFromAutoSchedule', 'Exclude from auto-scheduling', draft.mode === 'exclude' ? 'Change the policy mode before clearing this exclusion.' : 'Keep this person out of normal automatic assignment.'],
        ].map(([key, label, description]) => <label key={key} className="policy-checkbox"><input type="checkbox" checked={Boolean(draft[key] || (key === 'excludeFromAutoSchedule' && draft.mode === 'exclude'))} disabled={key === 'excludeFromAutoSchedule' && draft.mode === 'exclude'} onChange={(event) => onChange(key, event.target.checked)} /><span><strong>{label}</strong><small>{description}</small></span></label>)}
      </div>
      <label className="policy-note"><span>Policy notes</span><textarea className="form-textarea" rows="3" value={draft.notes} placeholder="Add context for this staff policy" onChange={(event) => onChange('notes', event.target.value)} /></label>
    </fieldset>
    <div className="policy-editor-actions"><button type="button" className="ghost-btn" onClick={onReset} disabled={busy || (!dirty && !draft.id)}>Reset to default</button><button type="button" className="primary-btn" onClick={onSave} disabled={busy || !dirty || (custom && !hoursValid)}>{busy ? 'Please wait...' : 'Save policy'}</button></div>
    <p className="ops-help">Total hours include session, on-call, control, and super duties.</p>
  </aside>;
}
