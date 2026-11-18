import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useToast } from '../App';

const defaultConfig = {
  mode: 'rooms_based',
  fixedTAsPerPeriod: 1,
  fixedDoctorsPerPeriod: 1,
  taRoomsPerStep: 3,
  taStaffPerStep: 1,
  taBelowThresholdMode: 'at_least_one',
  doctorRoomsPerStep: 6,
  doctorStaffPerStep: 1,
  doctorBelowThresholdMode: 'at_least_one',
  excludedInvigilatorIds: [],
};

function periodLabel(period) {
  return `${period.date} | ${period.startTime} - ${period.endTime}`;
}

function coverageStatus(period) {
  return Number(period.onCallTARemaining || 0) + Number(period.onCallDoctorRemaining || 0) > 0 ? 'Gap' : 'Covered';
}

function coverageTone(period) {
  return Number(period.onCallTARemaining || 0) + Number(period.onCallDoctorRemaining || 0) > 0 ? 'needs-attention' : 'covered';
}

function formatProjectedHours(minutes) {
  return `${(Number(minutes || 0) / 60).toFixed(2)}h`;
}

export default function OnCallPage() {
  const showToast = useToast();
  const [data, setData] = useState({
    periods: [],
    assignments: [],
    taInvigilators: [],
    doctorInvigilators: [],
    config: defaultConfig,
  });
  const [loading, setLoading] = useState(true);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState('');
  const [eligibleByPeriod, setEligibleByPeriod] = useState({});
  const [eligibleLoadingByPeriod, setEligibleLoadingByPeriod] = useState({});
  const [selection, setSelection] = useState({});
  const [periodFilters, setPeriodFilters] = useState({ search: '', date: '', coverage: '' });
  const [assignmentSearch, setAssignmentSearch] = useState('');
  const [assignmentRole, setAssignmentRole] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const [loadError, setLoadError] = useState('');
  const [eligibilityErrors, setEligibilityErrors] = useState({});
  const [eligibilityRefresh, setEligibilityRefresh] = useState(0);
  const loadSequence = useRef(0);

  async function load() {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError('');
    try {
      const response = await api.getOnCall();
      if (sequence !== loadSequence.current) return;
      setEligibleByPeriod({}); setEligibilityErrors({});
      setData({
        periods: response.periods || [],
        assignments: response.assignments || [],
        taInvigilators: response.taInvigilators || [],
        doctorInvigilators: response.doctorInvigilators || [],
        config: response.config || defaultConfig,
      });
      setSelectedPeriodKey((current) => {
        if (current && (response.periods || []).some((item) => item.periodKey === current)) {
          return current;
        }
        return response.periods?.[0]?.periodKey || '';
      });
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(error.message);
      showToast(error.message, 'error');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => { loadSequence.current += 1; };
  }, []);

  const visiblePeriods = useMemo(() => data.periods.filter((period) =>
    (!periodFilters.date || period.date === periodFilters.date) &&
    (!periodFilters.coverage || coverageStatus(period) === periodFilters.coverage) &&
    `${period.date} ${period.startTime} ${period.endTime} ${(period.rooms || []).join(' ')}`.toLocaleLowerCase().includes(periodFilters.search.trim().toLocaleLowerCase())
  ), [data.periods, periodFilters]);
  const selectedPeriod = useMemo(() => visiblePeriods.find((item) => item.periodKey === selectedPeriodKey) || visiblePeriods[0] || null, [visiblePeriods, selectedPeriodKey]);

  useEffect(() => {
    if (!selectedPeriod) return;
    if (eligibleByPeriod[selectedPeriod.periodKey]) return;

    let active = true;
    setEligibilityErrors((current) => ({ ...current, [selectedPeriod.periodKey]: '' }));
    setEligibleLoadingByPeriod((current) => ({ ...current, [selectedPeriod.periodKey]: true }));
    api.getOnCallEligible(selectedPeriod.date, selectedPeriod.startTime, selectedPeriod.endTime)
      .then((response) => {
        if (!active) return;
        setEligibleLoadingByPeriod((current) => ({ ...current, [selectedPeriod.periodKey]: false }));
        setEligibleByPeriod((current) => ({ ...current, [selectedPeriod.periodKey]: response }));
      })
      .catch((error) => {
        if (!active) return;
        setEligibleLoadingByPeriod((current) => ({ ...current, [selectedPeriod.periodKey]: false }));
        setEligibilityErrors((current) => ({ ...current, [selectedPeriod.periodKey]: error.message }));
      });

    return () => {
      active = false;
    };
  }, [selectedPeriod, eligibleByPeriod, showToast, eligibilityRefresh]);

  const selectedEligibility = selectedPeriod ? eligibleByPeriod[selectedPeriod.periodKey] : null;
  const selectedEligibilityLoading = selectedPeriod ? Boolean(eligibleLoadingByPeriod[selectedPeriod.periodKey]) : false;

  const summary = useMemo(() => {
    return data.periods.reduce((acc, period) => ({
      totalPeriods: acc.totalPeriods + 1,
      activeRooms: acc.activeRooms + Number(period.activeRoomCount || 0),
      taNeeded: acc.taNeeded + Number(period.onCallTANeeded || 0),
      doctorNeeded: acc.doctorNeeded + Number(period.onCallDoctorNeeded || 0),
      taAssigned: acc.taAssigned + Number(period.assignedTACount || 0),
      doctorAssigned: acc.doctorAssigned + Number(period.assignedDoctorCount || 0),
      taRemaining: acc.taRemaining + Number(period.onCallTARemaining || 0),
      doctorRemaining: acc.doctorRemaining + Number(period.onCallDoctorRemaining || 0),
    }), {
      totalPeriods: 0,
      activeRooms: 0,
      taNeeded: 0,
      doctorNeeded: 0,
      taAssigned: 0,
      doctorAssigned: 0,
      taRemaining: 0,
      doctorRemaining: 0,
    });
  }, [data.periods]);

  const taOptions = (selectedEligibility?.eligibleTAs || []).map((person) => ({ id: person.id, label: `${person.name} (${person.staffId}) / ${formatProjectedHours(person.projectedMinutes)} projected` }));
  const doctorOptions = (selectedEligibility?.eligibleDoctors || []).map((person) => ({ id: person.id, label: `${person.name} (${person.staffId}) / ${formatProjectedHours(person.projectedMinutes)} projected` }));

  const allAssignments = useMemo(() => {
    return [...(data.assignments || [])].sort((a, b) =>
      `${a.date} ${a.startTime} ${a.role} ${a.invigilator?.name || ''}`.localeCompare(
        `${b.date} ${b.startTime} ${b.role} ${b.invigilator?.name || ''}`
      )
    );
  }, [data.assignments]);

  function setSelectValue(periodKey, role, value) {
    setSelection((current) => ({ ...current, [`${periodKey}_${role}`]: value }));
  }

  async function assign(period, role) {
    const personId = selection[`${period.periodKey}_${role}`];
    const options = role === 'TA' ? taOptions : doctorOptions;
    if (!personId || !options.some((person) => person.id === personId)) {
      showToast(`Select a ${role === 'TA' ? 'TA' : 'Doctor'} first.`, 'error');
      return;
    }
    setPendingAction('assign');
    try {
      const result = await api.assignOnCall({
        date: period.date,
        startTime: period.startTime,
        endTime: period.endTime,
        invigilatorId: personId,
      });
      setEligibleByPeriod({});
      setSelection((current) => ({ ...current, [`${period.periodKey}_${role}`]: '' }));
      await load();
      showToast(`On-call assignment added.${result.continuityWarning ? ` ${result.continuityWarning}` : ''}`, 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPendingAction(''); }
  }

  async function autoAssignRemaining() {
    setAutoAssigning(true);
    try {
      const result = await api.autoAssignOnCall(false);
      setEligibleByPeriod({});
      await load();
      showToast(`On-call auto-assign completed. Added ${result.addedCount || 0} assignments.`, 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setAutoAssigning(false);
    }
  }

  async function removeAssignment(id) {
    setPendingAction(id);
    try {
      await api.removeOnCallAssignment(id);
      setEligibleByPeriod({});
      await load();
      showToast('On-call assignment removed.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPendingAction(''); }
  }

  async function clearAssignments() {
    if (!window.confirm('Remove all on-call assignments?')) return;
    setPendingAction('clear');
    try {
      await api.removeAllOnCallAssignments();
      setEligibleByPeriod({});
      await load();
      showToast('All on-call assignments removed.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPendingAction(''); }
  }

  const busy = loading || autoAssigning || Boolean(pendingAction);
  const eligibleError = selectedPeriod ? eligibilityErrors[selectedPeriod.periodKey] : '';
  const coverageTotal = summary.taNeeded + summary.doctorNeeded;
  const coverageAssigned = summary.taAssigned + summary.doctorAssigned;
  const filled = data.periods.reduce((sum, period) => sum + Math.min(Number(period.assignedTACount || 0), Number(period.onCallTANeeded || 0)) + Math.min(Number(period.assignedDoctorCount || 0), Number(period.onCallDoctorNeeded || 0)), 0);
  const coveragePercent = coverageTotal ? Math.round(filled / coverageTotal * 100) : 0;
  const visibleAssignments = allAssignments.filter((row) => (!assignmentRole || row.role === assignmentRole) && `${row.invigilator?.name || ''} ${row.invigilator?.staffId || ''} ${row.date} ${row.startTime}`.toLocaleLowerCase().includes(assignmentSearch.trim().toLocaleLowerCase()));
  function setFilter(key, value) { setPeriodFilters((current) => ({ ...current, [key]: value })); }
  return <div className="page-grid rules-page oncall-page oncall-operations">
    <section className="rules-intro"><div><span className="rules-eyebrow">RESERVE COVERAGE</span><h2>On-call staffing at a glance</h2><p>Find uncovered periods and assign eligible staff to each reserve window.</p></div><div className="action-row"><Link className="ghost-btn" to="/scheduling-rules">Edit on-call rules</Link><button type="button" className="ghost-btn" onClick={load} disabled={busy}>Refresh</button><button type="button" className="primary-btn" onClick={autoAssignRemaining} disabled={busy || !data.periods.length || summary.taRemaining + summary.doctorRemaining === 0}>{autoAssigning ? 'Assigning...' : 'Auto-assign remaining'}</button></div></section>
    {loadError ? <p className="rules-feedback is-error" role="alert">Unable to refresh on-call data: {loadError}. Displayed data may be out of date.</p> : null}
    <section className="ops-metrics" aria-label="On-call coverage summary">{[
      ['Reserve periods', summary.totalPeriods, `${data.periods.filter((period) => coverageStatus(period) === 'Gap').length} need attention`],
      ['Duties assigned', coverageAssigned, `${coverageTotal} required`],
      ['TA shortage', summary.taRemaining, `${summary.taAssigned} assigned / ${summary.taNeeded} required`],
      ['Doctor shortage', summary.doctorRemaining, `${summary.doctorAssigned} assigned / ${summary.doctorNeeded} required`],
    ].map(([label, value, note]) => <div className="ops-metric" key={label}><span>{label}</span><strong>{loading ? '...' : value}</strong><small>{note}</small></div>)}</section>
    <section className="panel oncall-coverage-strip"><div><strong>{loading ? 'Checking coverage...' : coverageTotal ? `${coveragePercent}% of required reserve duties covered` : 'No reserve duties required'}</strong><p className="ops-help">{data.config.mode === 'fixed_per_period' ? 'Fixed staffing per period' : 'Staffing based on active rooms'}. Staff exclusions and requirement settings are in Scheduling Rules.</p></div><progress max="100" value={coveragePercent} aria-label="Required on-call duties covered" /><Link className="ghost-btn" to="/conflict-dashboard">Review conflicts</Link></section>
    <div className="oncall-layout">
      <section className="panel oncall-directory"><div className="panel-head"><div><h2>Reserve periods</h2><p>{visiblePeriods.length} of {data.periods.length} periods / select one to manage assignments</p></div></div>
        <div className="form-grid ops-filters"><label><span>Find a period</span><input type="search" value={periodFilters.search} onChange={(event) => setFilter('search', event.target.value)} placeholder="Room, date, or time" /></label><label><span>Date</span><select value={periodFilters.date} onChange={(event) => setFilter('date', event.target.value)}><option value="">All dates</option>{[...new Set(data.periods.map((period) => period.date))].sort().map((date) => <option key={date}>{date}</option>)}</select></label><label><span>Coverage</span><select value={periodFilters.coverage} onChange={(event) => setFilter('coverage', event.target.value)}><option value="">All periods</option><option value="Gap">Needs attention</option><option value="Covered">Covered</option></select></label></div>
        <div className="oncall-period-grid">{visiblePeriods.map((period) => <button type="button" key={period.periodKey} className={`oncall-period-card ${coverageTone(period)}${selectedPeriod?.periodKey === period.periodKey ? ' is-selected' : ''}`} aria-pressed={selectedPeriod?.periodKey === period.periodKey} onClick={() => setSelectedPeriodKey(period.periodKey)}>
          <span className="oncall-card-heading"><strong>{period.date}</strong><span className={`ops-badge ${coverageStatus(period) === 'Gap' ? 'tone-warning' : 'tone-success'}`}>{coverageStatus(period) === 'Gap' ? 'Needs attention' : 'Covered'}</span></span>
          <span className="oncall-card-time">{period.startTime} - {period.endTime}</span><span className="oncall-card-rooms" title={period.rooms?.join(', ')}>{period.activeRoomCount} rooms / {(Number(period.durationMinutes || 0) / 60).toFixed(1)}h<span>{period.rooms?.join(', ') || 'No rooms'}</span></span>
          <span className="oncall-card-role-counts"><span>TA <strong>{period.assignedTACount} / {period.onCallTANeeded}</strong></span><span>Doctor <strong>{period.assignedDoctorCount} / {period.onCallDoctorNeeded}</strong></span></span>
        </button>)}{!visiblePeriods.length ? <div className="empty-state">{loading ? 'Loading reserve periods...' : data.periods.length ? 'No periods match these filters.' : 'Add exam sessions to generate reserve periods.'}</div> : null}</div>
      </section>
      <aside className="panel schedule-detail-sidebar oncall-sidebar" aria-label="Selected reserve period">
        {selectedPeriod ? <><div className="panel-head"><div><span className="rules-eyebrow">SELECTED PERIOD</span><h2>{selectedPeriod.startTime} - {selectedPeriod.endTime}</h2><p>{selectedPeriod.date} / {selectedPeriod.activeRoomCount} rooms</p></div></div><p className="ops-help">Choose from eligible staff, ordered by projected total hours. Duty conflicts, engagements, and hour policies are checked before assignment.</p>
          {eligibleError ? <div className="ops-inline-warning" role="alert">Candidate checks failed: {eligibleError}<button type="button" className="ghost-btn" disabled={busy} onClick={() => { api.clearCache(); setEligibilityRefresh((value) => value + 1); }}>Retry candidate checks</button></div> : null}
          {['TA', 'Doctor'].map((role) => {
            const options = role === 'TA' ? taOptions : doctorOptions;
            const assignments = role === 'TA' ? selectedPeriod.taAssignments || [] : selectedPeriod.doctorAssignments || [];
            const remaining = Number(role === 'TA' ? selectedPeriod.onCallTARemaining : selectedPeriod.onCallDoctorRemaining);
            const selectedValue = selection[`${selectedPeriod.periodKey}_${role}`] || '';
            const validSelection = options.some((person) => person.id === selectedValue);
            return <section className="oncall-role-editor" key={role}><div className="panel-head"><h3>{role === 'TA' ? 'Teaching assistants' : 'Doctors'}</h3><span className={`ops-badge ${remaining ? 'tone-warning' : 'tone-success'}`}>{remaining ? `${remaining} needed` : 'Covered'}</span></div>
              <label className="oncall-candidate"><span>{!selectedEligibility || selectedEligibilityLoading ? 'Checking eligible staff...' : `${options.length} eligible / projected hours shown`}</span><select aria-label={`Choose ${role} for ${periodLabel(selectedPeriod)}`} disabled={busy || !selectedEligibility || selectedEligibilityLoading || Boolean(eligibleError) || remaining === 0} value={validSelection ? selectedValue : ''} onChange={(event) => setSelectValue(selectedPeriod.periodKey, role, event.target.value)}><option value="">{remaining === 0 ? 'Requirement covered' : options.length ? `Select ${role}` : 'No eligible staff available'}</option>{options.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}</select></label>
              <button type="button" className="primary-btn" disabled={busy || !validSelection || selectedEligibilityLoading || Boolean(eligibleError) || remaining === 0} onClick={() => assign(selectedPeriod, role)}>Assign {role}</button>
              <div className="oncall-assigned-staff">{assignments.map((assignment) => <div className="oncall-assigned-row" key={assignment.id}><span><strong dir="auto">{assignment.invigilator?.name || assignment.invigilatorId}</strong><small>{assignment.invigilator?.staffId || role}</small></span><button type="button" className="ghost-btn" disabled={busy} onClick={() => removeAssignment(assignment.id)} aria-label={`Remove ${assignment.invigilator?.name || role} from this period`}>Remove</button></div>)}{!assignments.length ? <p className="ops-help">No {role === 'TA' ? 'TAs' : 'Doctors'} assigned yet.</p> : null}</div>
            </section>;
          })}
        </> : <div className="empty-state">Select a reserve period to manage its staff.</div>}
      </aside>
    </div>
    <details className="panel oncall-assignment-register" open><summary>Assignment register <span className="ops-badge">{allAssignments.length} duties</span></summary><div className="form-grid ops-filters"><label><span>Find an assignment</span><input type="search" value={assignmentSearch} onChange={(event) => setAssignmentSearch(event.target.value)} placeholder="Name, staff ID, date, or start time" /></label><label><span>Role</span><select value={assignmentRole} onChange={(event) => setAssignmentRole(event.target.value)}><option value="">All roles</option><option value="TA">TA</option><option value="Doctor">Doctor</option></select></label></div><div className="table-wrap oncall-assignment-table"><table><thead><tr><th>Staff member</th><th>Role</th><th>Date</th><th>Time</th><th /></tr></thead><tbody>{visibleAssignments.map((assignment) => <tr key={assignment.id}><td><strong dir="auto">{assignment.invigilator?.name || assignment.invigilatorId}</strong><small className="ops-cell-note">{assignment.invigilator?.staffId}</small></td><td>{assignment.role}</td><td>{assignment.date}</td><td>{assignment.startTime} - {assignment.endTime}</td><td><button type="button" className="ghost-btn" disabled={busy} onClick={() => removeAssignment(assignment.id)} aria-label={`Remove on-call assignment for ${assignment.invigilator?.name || assignment.invigilatorId} on ${assignment.date} at ${assignment.startTime}`}>Remove</button></td></tr>)}</tbody></table>{!visibleAssignments.length ? <div className="empty-state small">{loading ? 'Loading assignments...' : allAssignments.length ? 'No assignments match these filters.' : 'No on-call assignments yet.'}</div> : null}</div><div className="rules-save-bar"><p>{visibleAssignments.length} matching assignments. Removal updates saved coverage immediately.</p><button type="button" className="ghost-btn ops-danger" onClick={clearAssignments} disabled={busy || !allAssignments.length}>Remove all {allAssignments.length} assignments</button></div></details>
  </div>;
}
