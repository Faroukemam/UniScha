import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import useOperationalView from '../useOperationalView';
import OperationsOverview from '../components/OperationsOverview';

export default function DayCoveragePage() {
  const { data: rows, loading, error, refresh } = useOperationalView(api.getDayCoverage, []);
  const [date, setDate] = useState('');
  const [status, setStatus] = useState('');
  const gap = (row) => Number(row.taRemaining || 0) + Number(row.doctorRemaining || 0) + Number(row.onCallTARemaining || 0) + Number(row.onCallDoctorRemaining || 0);
  const visible = rows.filter((row) => (!date || row.date === date) && (!status || (status === 'gaps' ? gap(row) > 0 : gap(row) === 0)));
  const sessionGaps = rows.reduce((sum, row) => sum + Number(row.taRemaining || 0) + Number(row.doctorRemaining || 0), 0);
  const reserveGaps = rows.reduce((sum, row) => sum + Number(row.onCallTARemaining || 0) + Number(row.onCallDoctorRemaining || 0), 0);
  return <div className="page-grid rules-page coverage-page">
    <OperationsOverview eyebrow="DAILY OPERATIONS" title="Coverage by exam day" description="Locate gaps in session and reserve staffing before reviewing individual assignments." loading={loading} metrics={[["Exam days", rows.length], ["Days with gaps", rows.filter((row) => gap(row) > 0).length], ["Session duties unfilled", sessionGaps], ["On-call duties unfilled", reserveGaps]]}><button type="button" className="ghost-btn" disabled={loading} onClick={refresh}>Refresh</button><Link className="primary-btn" to="/scheduling">Open scheduling</Link></OperationsOverview>
    {error ? <p className="rules-feedback is-error" role="alert">Coverage refresh failed: {error}. Earlier figures may be out of date.</p> : null}
    <section className="panel"><div className="panel-head"><div><h2>Daily coverage</h2><p>On-call figures combine distinct reserve periods on each date.</p></div><div className="action-row"><label className="ops-inline-filter">Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="ops-inline-filter">Coverage<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All days</option><option value="gaps">Needs attention</option><option value="covered">No remaining gaps</option></select></label><button type="button" className="ghost-btn" onClick={() => { setDate(''); setStatus(''); }}>Clear filters</button></div></div>
      <div className="coverage-card-grid">{visible.map((row) => <article className="coverage-day-card" key={row.date}><div className="panel-head"><div><h3>{row.date}</h3><p>{row.startTime} - {row.endTime}</p></div><span className={`ops-badge ${gap(row) ? 'tone-warning' : 'tone-success'}`}>{gap(row) ? `${gap(row)} duties unfilled` : 'No gaps'}</span></div><div className="coverage-role-grid"><div><span>Session gaps</span><strong>{row.taRemaining || 0} TA / {row.doctorRemaining || 0} Doctor</strong></div><div><span>On-call gaps</span><strong>{row.onCallTARemaining || 0} TA / {row.onCallDoctorRemaining || 0} Doctor</strong></div><div><span>Reserve duties assigned / needed</span><strong>{Number(row.onCallTAAssigned || 0) + Number(row.onCallDoctorAssigned || 0)} / {Number(row.onCallTANeeded || 0) + Number(row.onCallDoctorNeeded || 0)}</strong></div><div><span>Other duties assigned</span><strong>{row.superCount || 0} super / {row.controlCount || 0} control</strong></div></div><p className="ops-help">{row.sessionCount} exam sessions</p></article>)}</div>
      {!visible.length ? <div className="empty-state">{loading ? 'Loading daily coverage...' : error ? 'Coverage could not be loaded.' : rows.length ? 'No days match these filters.' : 'Add sessions to see daily coverage.'}</div> : null}
    </section>
  </div>;
}
