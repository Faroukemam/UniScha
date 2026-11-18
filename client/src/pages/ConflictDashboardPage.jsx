import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { buildConflictDashboard } from '../conflictDashboard.mjs';

export default function ConflictDashboardPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [filters, setFilters] = useState({ search: '', role: '', type: '' });
  useEffect(() => {
    const reload = () => { api.clearCache(); setRefresh((value) => value + 1); };
    window.addEventListener('scheduler:data-changed', reload);
    window.addEventListener('focus', reload);
    return () => { window.removeEventListener('scheduler:data-changed', reload); window.removeEventListener('focus', reload); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    Promise.all([api.getReportsConflicts({}), api.getReportsEngagementOverrides({}), api.getReportsWorkload({}), api.getReportsSessionCoverage({}), api.getOnCall()])
      .then(([conflicts, overrides, workload, coverage, onCall]) => { if (active) setData({ ...buildConflictDashboard({ conflicts, overrides, workload, coverage, onCall }), updatedAt: new Date() }); })
      .catch((failure) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);
  const visible = useMemo(() => (data?.issues || []).filter((row) => (!filters.role || row.role === filters.role) && (!filters.type || row.type === filters.type) && `${row.staffId} ${row.staffName} ${row.duty} ${row.detail}`.toLocaleLowerCase().includes(filters.search.trim().toLocaleLowerCase())), [data, filters]);
  function update(key, value) { setFilters((current) => ({ ...current, [key]: value })); }
  return <div className="page-grid rules-page conflict-dashboard">
    <section className="rules-intro"><div><span className="rules-eyebrow">SCHEDULE HEALTH</span><h2>Keep conflicts to a minimum.</h2><p>Review the saved schedule, resolve conflicts, and track remaining coverage.</p></div><div className="action-row"><Link className="ghost-btn" to="/scheduling-rules">Scheduling rules</Link><button type="button" className="primary-btn" disabled={loading} onClick={() => { api.clearCache(); setRefresh((value) => value + 1); }}>{loading ? 'Checking...' : 'Refresh checks'}</button></div></section>
    {error ? <div className="rules-feedback is-error" role="alert">Checks could not load: {error}. Refresh to retry. Any earlier figures may be out of date.</div> : null}
    <section className="panel" aria-busy={loading}>
      <div className="panel-head"><div><h2>Conflict overview</h2><p>Targets: zero duty overlaps, zero policy violations, and the fewest permitted engagement overrides.</p></div><span className="rules-status">{loading ? 'Checking saved schedule...' : error ? 'Checks unavailable' : 'Saved schedule'}</span></div>
      <div className="summary-grid">{[['Review required', 'review', 'danger'], ['Permitted overrides', 'permitted', 'warning'], ['Affected staff', 'affectedStaff', 'purple'], ['Session duties unfilled', 'sessionGaps', 'danger'], ['On-call duties unfilled', 'onCallGaps', 'warning']].map(([label, key, tone]) => <div key={key} className={`summary-card ${tone}`}><div className="summary-card-value">{loading || error || !data ? '—' : data.summary[key]}</div><div className="summary-card-label">{label}</div></div>)}</div>
      <p className="conflict-explainer">Permitted overrides are shown separately from issues requiring review. A zero conflict count with unfilled duties still needs attention. These checks do not prove that the schedule has the mathematical minimum number of conflicts.</p>
      {data && !loading && !error ? <p className="muted conflict-updated">Checked {data.updatedAt.toLocaleString('en-GB', { timeZone: 'Africa/Cairo' })} (Cairo)</p> : null}
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Conflicts and engagement overrides</h2><p>Each engagement-affected duty appears once, with its recorded scheduling reason.</p></div><Link className="ghost-btn" to="/staff-schedule">Staff schedules</Link></div>
      <div className="form-grid conflict-filters"><label><span>Find staff or duty</span><input type="search" value={filters.search} onChange={(event) => update('search', event.target.value)} placeholder="Name, staff ID, or duty" /></label><label><span>Role</span><select value={filters.role} onChange={(event) => update('role', event.target.value)}><option value="">All roles</option><option value="TA">TA</option><option value="Doctor">Doctor</option></select></label><label><span>Issue type</span><select value={filters.type} onChange={(event) => update('type', event.target.value)}><option value="">All types</option>{[...new Set(data?.issues.map((row) => row.type) || [])].sort().map((type) => <option key={type}>{type}</option>)}</select></label></div>
      <div className="table-wrap"><table><thead><tr><th>Status</th><th>Staff</th><th>Type</th><th>Date</th><th>Duty and reason</th></tr></thead><tbody>{!loading && !error ? visible.map((row, index) => <tr key={index}><td><span className={`rules-status ${row.severity === 'Permitted' ? 'is-dirty' : 'conflict-review'}`}>{row.severity}</span></td><td><strong dir="auto">{row.staffName}</strong><small className="conflict-staff-id">{row.staffId} · {row.role}</small></td><td>{row.type}</td><td>{row.date || 'All dates'}</td><td><div>{row.duty}</div><small className="conflict-detail">{row.detail}</small></td></tr>) : null}</tbody></table></div>
      {loading || error || !visible.length ? <div className="empty-state small">{loading ? 'Checking schedule...' : error ? 'Checks unavailable. Refresh to retry.' : data?.issues.length ? 'No issues match these filters.' : 'No conflicts or engagement overrides in the saved assignments.'}</div> : null}
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Coverage to resolve</h2><p>Fill exam session gaps first, then reserve duties.</p></div><Link className="primary-btn" to="/scheduling">Open scheduling</Link></div>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Duty</th><th>Room / course</th><th>TA gaps</th><th>Doctor gaps</th></tr></thead><tbody>{!loading && !error ? data?.gaps.map((row, index) => <tr key={index}><td>{row.date}</td><td>{row.startTime} - {row.endTime}</td><td>{row.kind}</td><td>{row.room}{row.course ? ` / ${row.course}` : ''}</td><td>{row.taGap}</td><td>{row.doctorGap}</td></tr>) : null}</tbody></table></div>
      {loading || error || !data?.gaps.length ? <div className="empty-state small">{loading ? 'Checking coverage...' : error ? 'Coverage checks unavailable.' : 'No unfilled duties.'}</div> : null}
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Default staff workload balance</h2><p>Highest minus lowest assigned hours within each role. Availability and policies can require differences.</p></div></div><div className="table-wrap"><table><thead><tr><th>Role</th><th>Default staff</th><th>Total spread</th><th>Session spread</th><th>On-call spread</th></tr></thead><tbody>{!loading && !error ? data?.balance.map((row) => <tr key={row.role}><td>{row.role}</td><td>{row.staffCount}</td><td>{row.totalSpread.toFixed(2)}h</td><td>{row.sessionSpread.toFixed(2)}h</td><td>{row.onCallSpread.toFixed(2)}h</td></tr>) : null}</tbody></table></div></section>
  </div>;
}
