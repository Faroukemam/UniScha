import { useEffect, useMemo, useState } from 'react';
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

function isExcluded(config, invigilatorId) {
  return Array.isArray(config?.excludedInvigilatorIds) && config.excludedInvigilatorIds.includes(invigilatorId);
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
  const [configDraft, setConfigDraft] = useState(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState('');
  const [eligibleByPeriod, setEligibleByPeriod] = useState({});
  const [eligibleLoadingByPeriod, setEligibleLoadingByPeriod] = useState({});
  const [selection, setSelection] = useState({});

  async function load() {
    setLoading(true);
    try {
      const response = await api.getOnCall();
      setData({
        periods: response.periods || [],
        assignments: response.assignments || [],
        taInvigilators: response.taInvigilators || [],
        doctorInvigilators: response.doctorInvigilators || [],
        config: response.config || defaultConfig,
      });
      setConfigDraft(response.config || defaultConfig);
      setSelectedPeriodKey((current) => {
        if (current && (response.periods || []).some((item) => item.periodKey === current)) {
          return current;
        }
        return response.periods?.[0]?.periodKey || '';
      });
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const selectedPeriod = useMemo(
    () => data.periods.find((item) => item.periodKey === selectedPeriodKey) || null,
    [data.periods, selectedPeriodKey]
  );

  useEffect(() => {
    if (!selectedPeriod) return;
    if (eligibleByPeriod[selectedPeriod.periodKey]) return;

    let active = true;
    setEligibleLoadingByPeriod((current) => ({ ...current, [selectedPeriod.periodKey]: true }));
    api.getOnCallEligible(selectedPeriod.date, selectedPeriod.startTime, selectedPeriod.endTime)
      .then((response) => {
        if (!active) return;
        setEligibleByPeriod((current) => ({ ...current, [selectedPeriod.periodKey]: response }));
      })
      .catch((error) => {
        if (!active) return;
        showToast(error.message, 'error');
      })
      .finally(() => {
        if (!active) return;
        setEligibleLoadingByPeriod((current) => ({ ...current, [selectedPeriod.periodKey]: false }));
      });

    return () => {
      active = false;
    };
  }, [selectedPeriod, eligibleByPeriod, showToast]);

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

  const selectedAssignments = useMemo(() => {
    if (!selectedPeriod) return [];
    return [...(selectedPeriod.taAssignments || []), ...(selectedPeriod.doctorAssignments || [])];
  }, [selectedPeriod]);

  const taOptions = useMemo(() => {
    const eligibleRows = selectedEligibility?.eligibleTAs?.length
      ? selectedEligibility.eligibleTAs.map((person) => ({
          id: person.id,
          label: `${person.name} (${person.staffId}) | ${formatProjectedHours(person.projectedMinutes)}`,
        }))
      : [];
    if (eligibleRows.length) return eligibleRows;
    return (data.taInvigilators || []).filter((person) => !person.onCallExcluded).map((person) => ({
      id: person.id,
      label: `${person.name} (${person.staffId})`,
    }));
  }, [selectedEligibility, data.taInvigilators]);

  const doctorOptions = useMemo(() => {
    const eligibleRows = selectedEligibility?.eligibleDoctors?.length
      ? selectedEligibility.eligibleDoctors.map((person) => ({
          id: person.id,
          label: `${person.name} (${person.staffId}) | ${formatProjectedHours(person.projectedMinutes)}`,
        }))
      : [];
    if (eligibleRows.length) return eligibleRows;
    return (data.doctorInvigilators || []).filter((person) => !person.onCallExcluded).map((person) => ({
      id: person.id,
      label: `${person.name} (${person.staffId})`,
    }));
  }, [selectedEligibility, data.doctorInvigilators]);

  const currentExcludedCount = useMemo(
    () => Number(configDraft.excludedInvigilatorIds?.length || 0),
    [configDraft.excludedInvigilatorIds]
  );

  const allAssignments = useMemo(() => {
    return [...(data.assignments || [])].sort((a, b) =>
      `${a.date} ${a.startTime} ${a.role} ${a.invigilator?.name || ''}`.localeCompare(
        `${b.date} ${b.startTime} ${b.role} ${b.invigilator?.name || ''}`
      )
    );
  }, [data.assignments]);

  function updateConfigField(name, value) {
    setConfigDraft((current) => ({ ...current, [name]: value }));
  }

  function toggleExcluded(invigilatorId) {
    setConfigDraft((current) => {
      const currentIds = Array.isArray(current.excludedInvigilatorIds) ? current.excludedInvigilatorIds : [];
      const nextIds = currentIds.includes(invigilatorId)
        ? currentIds.filter((item) => item !== invigilatorId)
        : [...currentIds, invigilatorId];
      return { ...current, excludedInvigilatorIds: nextIds };
    });
  }

  async function saveConfig() {
    setSavingConfig(true);
    try {
      await api.saveOnCallConfig({
        ...configDraft,
        fixedTAsPerPeriod: Number(configDraft.fixedTAsPerPeriod || 0),
        fixedDoctorsPerPeriod: Number(configDraft.fixedDoctorsPerPeriod || 0),
        taRoomsPerStep: Number(configDraft.taRoomsPerStep || 0),
        taStaffPerStep: Number(configDraft.taStaffPerStep || 0),
        doctorRoomsPerStep: Number(configDraft.doctorRoomsPerStep || 0),
        doctorStaffPerStep: Number(configDraft.doctorStaffPerStep || 0),
        excludedInvigilatorIds: Array.isArray(configDraft.excludedInvigilatorIds) ? configDraft.excludedInvigilatorIds : [],
      });
      setEligibleByPeriod({});
      await load();
      showToast('On-call rule updated.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setSavingConfig(false);
    }
  }

  function setSelectValue(periodKey, role, value) {
    setSelection((current) => ({ ...current, [`${periodKey}_${role}`]: value }));
  }

  async function assign(period, role) {
    const personId = selection[`${period.periodKey}_${role}`];
    if (!personId) {
      showToast(`Select a ${role === 'TA' ? 'TA' : 'Doctor'} first.`, 'error');
      return;
    }
    try {
      await api.assignOnCall({
        date: period.date,
        startTime: period.startTime,
        endTime: period.endTime,
        invigilatorId: personId,
      });
      setEligibleByPeriod({});
      setSelection((current) => ({ ...current, [`${period.periodKey}_${role}`]: '' }));
      await load();
      showToast('On-call assignment added.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
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
    try {
      await api.removeOnCallAssignment(id);
      setEligibleByPeriod({});
      await load();
      showToast('On-call assignment removed.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function clearAssignments() {
    try {
      await api.removeAllOnCallAssignments();
      setEligibleByPeriod({});
      await load();
      showToast('All on-call assignments removed.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  return (
    <div className="page-grid oncall-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>On-Call Rule Setup</h2>
            <p>Define how many reserve TAs and Doctors each on-call session should require before manual or auto assignment.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={load}>Refresh</button>
            <button type="button" className="ghost-btn" onClick={clearAssignments}>Clear All Assignments</button>
            <button type="button" className="primary-btn" onClick={saveConfig} disabled={savingConfig}>
              {savingConfig ? 'Saving...' : 'Save Rule'}
            </button>
          </div>
        </div>

        <div className="chips-wrap oncall-rule-chips">
          <div className="info-chip"><strong>Rule Mode</strong><span>{configDraft.mode === 'fixed_per_period' ? 'Fixed per period' : 'From active rooms'}</span></div>
          <div className="info-chip"><strong>TA Rule</strong><span>{configDraft.mode === 'fixed_per_period' ? `${configDraft.fixedTAsPerPeriod} / period` : `${configDraft.taStaffPerStep} per ${configDraft.taRoomsPerStep} rooms`}</span></div>
          <div className="info-chip"><strong>Doctor Rule</strong><span>{configDraft.mode === 'fixed_per_period' ? `${configDraft.fixedDoctorsPerPeriod} / period` : `${configDraft.doctorStaffPerStep} per ${configDraft.doctorRoomsPerStep} rooms`}</span></div>
          <div className="info-chip"><strong>Excluded</strong><span>{currentExcludedCount}</span></div>
          {configDraft.mode === 'rooms_based' ? (
            <>
              <div className="info-chip"><strong>TA Below Threshold</strong><span>{configDraft.taBelowThresholdMode === 'zero' ? 'Zero allowed' : 'At least one'}</span></div>
              <div className="info-chip"><strong>Doctor Below Threshold</strong><span>{configDraft.doctorBelowThresholdMode === 'zero' ? 'Zero allowed' : 'At least one'}</span></div>
            </>
          ) : null}
        </div>

        <div className="form-grid oncall-config-grid">
          <label>
            <span>Rule Mode</span>
            <select value={configDraft.mode} onChange={(event) => updateConfigField('mode', event.target.value)}>
              <option value="rooms_based">From active rooms</option>
              <option value="fixed_per_period">Fixed TA / Doctor per period</option>
            </select>
          </label>
          {configDraft.mode === 'fixed_per_period' ? (
            <>
              <label>
                <span>TA per Period</span>
                <input type="number" min="0" value={configDraft.fixedTAsPerPeriod} onChange={(event) => updateConfigField('fixedTAsPerPeriod', event.target.value)} />
              </label>
              <label>
                <span>Doctor per Period</span>
                <input type="number" min="0" value={configDraft.fixedDoctorsPerPeriod} onChange={(event) => updateConfigField('fixedDoctorsPerPeriod', event.target.value)} />
              </label>
            </>
          ) : (
            <>
              <label>
                <span>TA Rooms Threshold</span>
                <input type="number" min="1" value={configDraft.taRoomsPerStep} onChange={(event) => updateConfigField('taRoomsPerStep', event.target.value)} />
              </label>
              <label>
                <span>TA Staff per Threshold</span>
                <input type="number" min="1" value={configDraft.taStaffPerStep} onChange={(event) => updateConfigField('taStaffPerStep', event.target.value)} />
              </label>
              <label>
                <span>TA Below Threshold</span>
                <select value={configDraft.taBelowThresholdMode} onChange={(event) => updateConfigField('taBelowThresholdMode', event.target.value)}>
                  <option value="at_least_one">At least one</option>
                  <option value="zero">Zero</option>
                </select>
              </label>
              <label>
                <span>Doctor Rooms Threshold</span>
                <input type="number" min="1" value={configDraft.doctorRoomsPerStep} onChange={(event) => updateConfigField('doctorRoomsPerStep', event.target.value)} />
              </label>
              <label>
                <span>Doctor Staff per Threshold</span>
                <input type="number" min="1" value={configDraft.doctorStaffPerStep} onChange={(event) => updateConfigField('doctorStaffPerStep', event.target.value)} />
              </label>
              <label>
                <span>Doctor Below Threshold</span>
                <select value={configDraft.doctorBelowThresholdMode} onChange={(event) => updateConfigField('doctorBelowThresholdMode', event.target.value)}>
                  <option value="at_least_one">At least one</option>
                  <option value="zero">Zero</option>
                </select>
              </label>
            </>
          )}
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <div>
              <h3>Exclude Invigilators From On-Call</h3>
              <p>This affects on-call manual assignment and on-call auto-assign only.</p>
            </div>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <div>
              <h4>TA</h4>
              <div className="calendar-assignment-list">
                {(data.taInvigilators || []).map((person) => (
                  <label key={person.id} className="calendar-assignment-row" style={{ cursor: 'pointer' }}>
                    <span>{person.name} ({person.staffId})</span>
                    <input
                      type="checkbox"
                      checked={isExcluded(configDraft, person.id)}
                      onChange={() => toggleExcluded(person.id)}
                    />
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h4>Doctor</h4>
              <div className="calendar-assignment-list">
                {(data.doctorInvigilators || []).map((person) => (
                  <label key={person.id} className="calendar-assignment-row" style={{ cursor: 'pointer' }}>
                    <span>{person.name} ({person.staffId})</span>
                    <input
                      type="checkbox"
                      checked={isExcluded(configDraft, person.id)}
                      onChange={() => toggleExcluded(person.id)}
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
        <p className="muted oncall-page-note">
          Auto-assign fills remaining on-call shortages first, then chooses the lowest projected-load eligible invigilator to keep total load more balanced.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>On-Call Session Summary</h2>
            <p>Each period is treated as one on-call session derived from the active room block for that exact date and time.</p>
          </div>
          <div className="action-row">
            <button type="button" className="primary-btn" onClick={autoAssignRemaining} disabled={autoAssigning}>
              {autoAssigning ? 'Auto Assigning...' : 'Auto Assign Remaining'}
            </button>
          </div>
        </div>
        <div className="summary-grid">
          <div className="summary-card blue"><div className="summary-card-value">{loading ? '...' : summary.totalPeriods}</div><div className="summary-card-label">On-Call Sessions</div></div>
          <div className="summary-card purple"><div className="summary-card-value">{loading ? '...' : summary.activeRooms}</div><div className="summary-card-label">Active Rooms</div></div>
          <div className="summary-card success"><div className="summary-card-value">{loading ? '...' : summary.taNeeded}</div><div className="summary-card-label">TA Needed</div></div>
          <div className="summary-card warning"><div className="summary-card-value">{loading ? '...' : summary.doctorNeeded}</div><div className="summary-card-label">Doctor Needed</div></div>
          <div className="summary-card blue"><div className="summary-card-value">{loading ? '...' : summary.taAssigned}</div><div className="summary-card-label">TA Assigned</div></div>
          <div className="summary-card purple"><div className="summary-card-value">{loading ? '...' : summary.doctorAssigned}</div><div className="summary-card-label">Doctor Assigned</div></div>
          <div className="summary-card danger"><div className="summary-card-value">{loading ? '...' : summary.taRemaining}</div><div className="summary-card-label">TA Shortage</div></div>
          <div className="summary-card danger"><div className="summary-card-value">{loading ? '...' : summary.doctorRemaining}</div><div className="summary-card-label">Doctor Shortage</div></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Current On-Call Assignments</h2>
            <p>Remove assignments directly here without opening each period.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={clearAssignments} disabled={!allAssignments.length}>
              Remove All Assignments
            </button>
          </div>
        </div>
        <div className="calendar-assignment-list">
          {allAssignments.map((assignment) => (
            <div key={assignment.id} className="calendar-assignment-row">
              <span>
                {assignment.date} | {assignment.startTime} - {assignment.endTime} | {assignment.invigilator?.name || assignment.invigilatorId} ({assignment.role})
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeAssignment(assignment.id)}>Remove</button>
            </div>
          ))}
          {!allAssignments.length ? <div className="empty-state">No on-call assignments yet.</div> : null}
        </div>
      </section>

      <div className="oncall-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>On-Call Sessions</h2>
              <p>Select a period to manage manual assignments. The non-overlap, engagement, max-hours, and staff-hour policy checks still apply.</p>
            </div>
          </div>
          <div className="chips-wrap oncall-list-chips">
            <div className="info-chip"><strong>Total Periods</strong><span>{data.periods.length}</span></div>
            <div className="info-chip"><strong>Covered</strong><span>{data.periods.filter((item) => coverageStatus(item) === 'Covered').length}</span></div>
            <div className="info-chip"><strong>Need Attention</strong><span>{data.periods.filter((item) => coverageStatus(item) === 'Gap').length}</span></div>
            <div className="info-chip"><strong>Selected</strong><span>{selectedPeriod ? periodLabel(selectedPeriod) : 'None'}</span></div>
          </div>
          <div className="oncall-period-grid">
            {(data.periods || []).map((period) => (
              <article
                key={period.periodKey}
                className={`oncall-period-card ${coverageTone(period)}${selectedPeriodKey === period.periodKey ? ' is-selected' : ''}`}
                onClick={() => setSelectedPeriodKey(period.periodKey)}
              >
                <div className="oncall-period-topline">
                  <span className={`oncall-period-status${selectedPeriodKey === period.periodKey ? ' active' : ''}`}>
                    {coverageStatus(period)}
                  </span>
                </div>
                <div className="oncall-period-title">{period.date}</div>
                <div className="oncall-period-time">{period.startTime} - {period.endTime}</div>
                <div className="oncall-period-room">{period.rooms?.join('; ') || 'No rooms'}</div>
                <div className="oncall-period-meta">
                  <span>{period.activeRoomCount} rooms</span>
                  <span>{(Number(period.durationMinutes || 0) / 60).toFixed(1)}h</span>
                </div>
                <div className="oncall-period-needs">
                  <span>TA {period.assignedTACount}/{period.onCallTANeeded}</span>
                  <span>Doctor {period.assignedDoctorCount}/{period.onCallDoctorNeeded}</span>
                </div>
              </article>
            ))}
            {!data.periods.length ? <div className="empty-state">{loading ? 'Loading on-call sessions...' : 'No on-call sessions available.'}</div> : null}
          </div>
        </section>

        <aside className="panel schedule-detail-panel schedule-detail-sidebar oncall-sidebar">
          {selectedPeriod ? (
            <>
              <div className="panel-head">
                <div>
                  <h2>On-Call Session</h2>
                  <p>{periodLabel(selectedPeriod)}</p>
                </div>
                <div className="need-badges">
                  <span>TA {selectedPeriod.assignedTACount}/{selectedPeriod.onCallTANeeded}</span>
                  <span>Doctor {selectedPeriod.assignedDoctorCount}/{selectedPeriod.onCallDoctorNeeded}</span>
                </div>
              </div>

              <div className="schedule-detail-summary">
                <div className="info-chip"><strong>Rooms</strong><span>{selectedPeriod.activeRoomCount}</span></div>
                <div className="info-chip"><strong>TA left</strong><span>{selectedPeriod.onCallTARemaining}</span></div>
                <div className="info-chip"><strong>Doctor left</strong><span>{selectedPeriod.onCallDoctorRemaining}</span></div>
                <div className="info-chip"><strong>Duration</strong><span>{(Number(selectedPeriod.durationMinutes || 0) / 60).toFixed(1)}h</span></div>
                <div className="info-chip"><strong>Eligible TA</strong><span>{selectedPeriod.eligibleTACount ?? (selectedEligibility?.eligibleTAs.length || 0)}</span></div>
                <div className="info-chip"><strong>Eligible Doctor</strong><span>{selectedPeriod.eligibleDoctorCount ?? (selectedEligibility?.eligibleDoctors.length || 0)}</span></div>
                <div className="info-chip"><strong>Assigned</strong><span>{selectedAssignments.length}</span></div>
              </div>
              <p className="muted oncall-selected-note">
                Rule mode: {data.config.mode === 'fixed_per_period' ? 'Fixed per period' : 'From active rooms'}.
                {selectedPeriod.rooms?.length ? ` Rooms: ${selectedPeriod.rooms.join('; ')}` : ''}
              </p>
              {selectedEligibilityLoading ? <p className="muted">Loading eligible candidates. You can still choose from the current TA/Doctor lists while backend validation runs on assign.</p> : null}

              <div className="schedule-detail-sections">
                <div className="duty-column">
                  <h4>TA Assignment</h4>
                  <div className="calendar-session-block">
                    <select value={selection[`${selectedPeriod.periodKey}_TA`] || ''} onChange={(event) => setSelectValue(selectedPeriod.periodKey, 'TA', event.target.value)}>
                      <option value="">Select TA</option>
                      {taOptions.map((person) => (
                        <option key={person.id} value={person.id}>{person.label}</option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-primary" onClick={() => assign(selectedPeriod, 'TA')}>Assign TA</button>
                  </div>
                  <div className="calendar-assignment-list">
                    {(selectedPeriod.taAssignments || []).map((assignment) => (
                      <div key={assignment.id} className="calendar-assignment-row">
                        <span>{assignment.invigilator?.name || assignment.invigilatorId} (TA)</span>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeAssignment(assignment.id)}>Remove</button>
                      </div>
                    ))}
                    {!selectedPeriod.taAssignments?.length ? <div className="exam-cell-empty">No TA assigned</div> : null}
                  </div>
                </div>

                <div className="duty-column">
                  <h4>Doctor Assignment</h4>
                  <div className="calendar-session-block">
                    <select value={selection[`${selectedPeriod.periodKey}_Doctor`] || ''} onChange={(event) => setSelectValue(selectedPeriod.periodKey, 'Doctor', event.target.value)}>
                      <option value="">Select Doctor</option>
                      {doctorOptions.map((person) => (
                        <option key={person.id} value={person.id}>{person.label}</option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-primary" onClick={() => assign(selectedPeriod, 'Doctor')}>Assign Doctor</button>
                  </div>
                  <div className="calendar-assignment-list">
                    {(selectedPeriod.doctorAssignments || []).map((assignment) => (
                      <div key={assignment.id} className="calendar-assignment-row">
                        <span>{assignment.invigilator?.name || assignment.invigilatorId} (Doctor)</span>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeAssignment(assignment.id)}>Remove</button>
                      </div>
                    ))}
                    {!selectedPeriod.doctorAssignments?.length ? <div className="exam-cell-empty">No doctor assigned</div> : null}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">Select an on-call session to manage TA and Doctor assignments.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
