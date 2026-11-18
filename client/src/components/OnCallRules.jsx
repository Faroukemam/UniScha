import { useEffect, useState } from 'react';
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

function isExcluded(config, invigilatorId) {
  return Array.isArray(config?.excludedInvigilatorIds) && config.excludedInvigilatorIds.includes(invigilatorId);
}

export default function OnCallRules({ disabled = false, onBusyChange }) {
  const showToast = useToast();
  const [data, setData] = useState({ taInvigilators: [], doctorInvigilators: [] });
  const [configDraft, setConfigDraft] = useState(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [savedConfig, setSavedConfig] = useState(null);
  const [staffSearch, setStaffSearch] = useState('');
  const dirty = savedConfig !== null && JSON.stringify(savedConfig) !== JSON.stringify(configDraft);
  const matchesSearch = (person) => `${person.name} ${person.staffId}`.toLocaleLowerCase().includes(staffSearch.trim().toLocaleLowerCase());
  const currentExcludedCount = configDraft.excludedInvigilatorIds?.length || 0;
  async function load() {
    setLoading(true); setLoadError('');
    try {
      const response = await api.getOnCall();
      setData(response); setConfigDraft(response.config || defaultConfig); setSavedConfig(response.config || defaultConfig);
    } catch (error) { setLoadError(error.message); showToast(error.message, 'error'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { onBusyChange?.(loading || savingConfig); }, [loading, savingConfig, onBusyChange]);
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
      await load();
      showToast('On-call rule updated.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setSavingConfig(false);
    }
  }

  return (
      <section className="panel rules-oncall">
        <div className="panel-head">
          <div className="rules-section-title"><span className="rules-section-number">02</span><div><h2>On-call coverage rules</h2><p>Set reserve requirements for each active exam period.</p></div></div>
          <span className={`rules-status ${dirty ? 'is-dirty' : ''}`} role="status">{loading || savingConfig ? 'Loading or saving...' : !savedConfig ? 'Not loaded' : dirty ? 'Unsaved changes' : 'Saved'}</span>
        </div>

        <fieldset disabled={disabled || loading || savingConfig} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
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
        <div className="rules-exclusions">
          <div className="rules-exclusion-heading"><div><h3>Staff exclusions</h3><p>Checked staff cannot receive on-call duties. Session assignments are unaffected.</p></div><label className="rules-staff-search"><span>Find staff</span><input type="search" value={staffSearch} onChange={(event) => setStaffSearch(event.target.value)} placeholder="Search by name or staff ID" /></label></div>
          <div className="rules-staff-columns">
            {[['TA', data.taInvigilators || []], ['Doctor', data.doctorInvigilators || []]].map(([role, people]) => {
              const visible = people.filter(matchesSearch);
              return <div className="rules-staff-group" key={role}><div className="rules-staff-group-head"><h4>{role === 'TA' ? 'Teaching assistants' : 'Doctors'}</h4><span>{people.filter((person) => isExcluded(configDraft, person.id)).length} / {people.length} excluded</span></div>
                <div className="rules-staff-list">{visible.map((person) => <label key={person.id} className={`rules-staff-row ${isExcluded(configDraft, person.id) ? 'is-excluded' : ''}`}><input type="checkbox" checked={isExcluded(configDraft, person.id)} onChange={() => toggleExcluded(person.id)} /><span><strong dir="auto">{person.name}</strong><small>{person.staffId}</small></span></label>)}
                  {!visible.length ? <p className="empty-state small">{loading ? 'Loading staff...' : people.length ? 'No staff match your search.' : 'No staff in this role.'}</p> : null}
                </div>
              </div>;
            })}
          </div>
        </div>
        </fieldset>
        {loadError ? <p role="alert">{loadError}</p> : null}
        <div className="rules-save-bar"><p>Save rules before generating a new scheduling preview.</p><div className="action-row">
          <button type="button" className="ghost-btn" onClick={load} disabled={savingConfig || loading || disabled}>Reload saved rules</button>
          <button type="button" className="primary-btn" onClick={saveConfig} disabled={savingConfig || loading || disabled || Boolean(loadError) || !dirty}>{savingConfig ? 'Saving...' : 'Save on-call rules'}</button>
        </div></div>
      </section>
  );
}
