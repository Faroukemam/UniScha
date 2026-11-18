import { useEffect, useState } from 'react';
import { api } from '../api';

export const priorityLabels = {
  engagement_overrides: 'Minimize engagement overrides',
  consecutive_days: 'Prefer consecutive working days',
  consecutive_duties: 'Prefer consecutive duties within each day',
  daily_soft_target: 'Minimize duties above the daily soft target',
};
const units = { engagement_overrides: 'per overlap hour', consecutive_days: 'per gap day', consecutive_duties: 'per idle hour', daily_soft_target: 'per extra duty' };
const defaults = { preferenceOrder: Object.keys(priorityLabels), dailySoftTarget: 2, scoringMode: 'ranked', weights: { engagement_overrides: 100, consecutive_days: 50, consecutive_duties: 10, daily_soft_target: 1 } };

export default function SchedulingPriorities({ disabled, onDirtyChange, onSaved, onBusyChange }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(defaults);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);

  async function load() {
    setPending(true); setError('');
    try { const value = await api.getSchedulingConfig(); setSaved(value); setDraft(value); }
    catch (e) { setError(e.message); }
    finally { setPending(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { onDirtyChange?.(!saved || dirty || pending || Boolean(error)); }, [saved, dirty, pending, error, onDirtyChange]);

  useEffect(() => { onBusyChange?.(pending); }, [pending, onBusyChange]);

  function move(index, offset) {
    const preferenceOrder = [...draft.preferenceOrder];
    [preferenceOrder[index], preferenceOrder[index + offset]] = [preferenceOrder[index + offset], preferenceOrder[index]];
    setDraft({ ...draft, preferenceOrder }); setMessage('');
  }
  async function save() {
    setPending(true); setError(''); setMessage('');
    try {
      const value = await api.saveSchedulingConfig(draft);
      setSaved(value); setDraft(value);
      await onSaved?.();
      setMessage('Priorities saved. Your next preview will use these settings.');
    } catch (e) { setError(e.message); }
    finally { setPending(false); }
  }

  const controlsDisabled = disabled || pending || !saved;
  const invalidWeights = Object.values(draft.weights).some((weight) => !Number.isInteger(weight) || weight < 0 || weight > 1000) || !Object.values(draft.weights).some((weight) => weight > 0);
  const invalidTarget = !Number.isInteger(draft.dailySoftTarget) || draft.dailySoftTarget < 0 || draft.dailySoftTarget > 20;
  const descriptions = {
    engagement_overrides: 'Reduce conflicts with staff engagements. Only permitted overrides are considered.',
    consecutive_days: 'Reduce days off between the first and last working dates.',
    consecutive_duties: 'Reduce idle time between duties on the same day.',
    daily_soft_target: 'Spread duties to reduce assignments above the daily target.',
  };
  return <div className="rules-priorities" aria-busy={pending}>
    <div className="panel-head">
      <div className="rules-section-title"><span className="rules-section-number">01</span><div><h2>Scheduling priorities</h2><p>Decide which preferences matter most when they compete.</p></div></div>
      <span className={`rules-status ${dirty ? 'is-dirty' : ''}`} role="status">{pending ? 'Loading or saving...' : !saved ? 'Not loaded' : dirty ? 'Unsaved changes' : 'Saved'}</span>
    </div>
    <div className="rules-protected">
      <strong>Always protected</strong>
      <p>Staff roles, hour limits, exclusions, duty conflicts, and preserved assignments. Engagement overrides require permission in each staff policy.</p>
      <div className="rules-coverage-flow"><span>1. Fill exam duties</span><span aria-hidden="true">&rarr;</span><span>2. Fill on-call duties</span><span aria-hidden="true">&rarr;</span><span>3. Balance total and duty-type hours</span></div>
    </div>
    <div className="rules-subheading"><h3>Preference scoring</h3><p>Coverage and workload balance take priority over these preferences.</p></div>
    <div className="rules-mode-options" role="group" aria-label="Scoring method">
      {[['ranked', 'Priority order', 'Higher preferences win. Use Up and Down to reorder.'], ['weighted', 'Weighted points', 'Assign penalty points to each preference. Lower total wins.']].map(([mode, title, description]) =>
        <button key={mode} type="button" className={`rules-mode ${draft.scoringMode === mode ? 'is-selected' : ''}`} aria-pressed={draft.scoringMode === mode} disabled={controlsDisabled} onClick={() => { setDraft({ ...draft, scoringMode: mode }); setMessage(''); }}>
          <span className="rules-radio" aria-hidden="true" /><span><strong>{title}</strong><small>{description}</small></span>
        </button>)}
    </div>
    <p className="rules-list-help">{draft.scoringMode === 'weighted' ? 'Use 0-1,000 points per unit. Zero excludes a preference from the score; the priority order breaks equal-score ties.' : 'The first preference takes priority over every preference below it.'} Consecutive preferences apply only to staff with the corresponding policy enabled.</p>
    <ol className="rules-priority-list" aria-label="Scheduling preference order">
      {draft.preferenceOrder.map((key, index) => <li key={key} className="rules-priority-card">
        <span className="rules-rank" aria-label={`Priority ${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
        <div className="rules-priority-copy"><strong>{priorityLabels[key]}</strong><p>{descriptions[key]}</p></div>
        {draft.scoringMode === 'weighted' ? <label className="rules-points"><span>Points</span><input type="number" min="0" max="1000" step="1" aria-label={`Points for ${priorityLabels[key]}`} value={draft.weights[key]} disabled={controlsDisabled} onChange={(event) => { setDraft({ ...draft, weights: { ...draft.weights, [key]: event.target.value === '' ? '' : Number(event.target.value) } }); setMessage(''); }} /><small>{units[key]}</small></label> : null}
        <div className="rules-move-controls">
          <button type="button" className="ghost-btn" aria-label={`Move ${priorityLabels[key]} up`} disabled={controlsDisabled || index === 0} onClick={() => move(index, -1)}><span aria-hidden="true">&uarr;</span> Up</button>
          <button type="button" className="ghost-btn" aria-label={`Move ${priorityLabels[key]} down`} disabled={controlsDisabled || index === draft.preferenceOrder.length - 1} onClick={() => move(index, 1)}><span aria-hidden="true">&darr;</span> Down</button>
        </div>
      </li>)}
    </ol>
    <div className="rules-daily-target"><div><label htmlFor="rules-daily-target">Daily soft target</label><p>A preferred number of duties per person per day. This does not set a hard limit.</p></div><div className="rules-target-input"><input id="rules-daily-target" type="number" min="0" max="20" step="1" value={draft.dailySoftTarget} disabled={controlsDisabled} onChange={(event) => { setDraft({ ...draft, dailySoftTarget: event.target.value === '' ? '' : Number(event.target.value) }); setMessage(''); }} /><span>duties / day</span></div></div>
    {dirty && (invalidTarget || invalidWeights) ? <p className="rules-feedback is-error" role="alert">{invalidTarget ? 'Enter a whole daily target from 0 to 20.' : 'Use whole point values from 0 to 1,000, with at least one above zero.'}</p> : null}
    <div className="rules-save-bar"><p>Save changes, then generate a new scheduling preview.</p><div className="action-row">
      <button type="button" className="ghost-btn" disabled={controlsDisabled} onClick={() => { setDraft(defaults); setMessage(''); }}>Restore defaults</button>
      <button type="button" className="primary-btn" disabled={controlsDisabled || !dirty || invalidTarget || invalidWeights} onClick={save}>{pending ? 'Please wait...' : 'Save priorities'}</button>
      {error ? <button type="button" className="ghost-btn" onClick={load} disabled={pending || disabled}>Reload priorities</button> : null}
    </div></div>
    {error ? <p className="rules-feedback is-error" role="alert">{error}</p> : null}
    {message ? <p className="rules-feedback" role="status">{message}</p> : null}
  </div>;
}
