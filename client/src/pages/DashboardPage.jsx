import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useToast } from '../App';

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({
    totals: {},
    openNeeds: { ta: 0, doctor: 0 },
    onCallNeeds: { ta: 0, doctor: 0, total: 0 },
    dayWindows: []
  });
  const showToast = useToast();

  useEffect(() => {
    setLoading(true);
    api.getDashboard()
      .then(setData)
      .catch((error) => showToast(error.message, 'error'))
      .finally(() => setLoading(false));
  }, []);

  const cards = [
    { label: 'Sessions', value: data.totals.sessions || 0, tone: 'blue' },
    { label: 'Invigilators', value: data.totals.invigilators || 0, tone: 'purple' },
    { label: 'Doctors', value: data.totals.doctors || 0, tone: 'success' },
    { label: 'TAs', value: data.totals.tas || 0, tone: 'warning' },
    { label: 'Session Duties', value: data.totals.assignedSessionDuties || 0, tone: 'blue' },
    { label: 'On-Call Periods', value: data.totals.onCallPeriods || 0, tone: 'purple' },
    { label: 'On-Call Duties', value: data.totals.onCallAssignments || 0, tone: 'success' },
    { label: 'Custom Hour Policies', value: data.totals.customHourPolicies || 0, tone: 'purple' },
    { label: 'Excluded Staff', value: data.totals.excludedStaff || 0, tone: 'danger' },
    { label: 'Over Policy', value: data.totals.overLimitStaff || 0, tone: 'danger' },
    { label: 'Super Duties', value: data.totals.superAssignments || 0, tone: 'success' },
    { label: 'Control Duties', value: data.totals.controlAssignments || 0, tone: 'warning' },
    { label: 'Open Needs', value: (data.openNeeds.ta || 0) + (data.openNeeds.doctor || 0), tone: 'danger' }
  ];

  return (
    <div className="page-grid rules-page dashboard-page">
      <section className="rules-intro"><div><span className="rules-eyebrow">EXAM OPERATIONS</span><h2>Your scheduling workspace</h2><p>Start with coverage, review staff policies, then generate and inspect a schedule.</p></div><div className="action-row"><Link className="primary-btn" to="/scheduling">Open scheduling</Link><Link className="ghost-btn" to="/conflict-dashboard">Conflict dashboard</Link></div></section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Operational Overview</h2>
            <p>Fast view of staffing pressure, daily windows, and coverage gaps.</p>
          </div>
          <Link className="ghost-btn" to="/conflict-dashboard">Conflict dashboard</Link>
        </div>
        <div className="summary-grid">
          {cards.map((card) => (
            <div className={`summary-card ${card.tone}`} key={card.label}>
              <div className="summary-card-value">{loading ? '...' : card.value}</div>
              <div className="summary-card-label">{card.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Open Need Breakdown</h2>
          <p>Remaining staffing still needed in session assignments.</p>
        </div>
        <div className="chips-wrap">
          <div className="info-chip"><strong>TA Remaining</strong><span>{data.openNeeds.ta || 0}</span></div>
          <div className="info-chip"><strong>Doctor Remaining</strong><span>{data.openNeeds.doctor || 0}</span></div>
          <div className="info-chip"><strong>On-Call TA Shortage</strong><span>{data.onCallNeeds.ta || 0}</span></div>
          <div className="info-chip"><strong>On-Call Doctor Shortage</strong><span>{data.onCallNeeds.doctor || 0}</span></div>
          <div className="info-chip"><strong>Total On-Call Shortage</strong><span>{data.onCallNeeds.total || 0}</span></div>
          <div className="info-chip"><strong>TA Average H</strong><span>{Number(data.hourAverages?.TA || 0).toFixed(2)}</span></div>
          <div className="info-chip"><strong>Doctor Average H</strong><span>{Number(data.hourAverages?.Doctor || 0).toFixed(2)}</span></div>
        </div>
        {loading ? <div className="empty-state small">Loading dashboard...</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Planning and schedule checks</h2>
            <p>Use these before final invigilator scheduling to validate capacity and assign courses to compatible rooms.</p>
          </div>
          <div className="action-row">
            <Link className="ghost-btn" to="/conflict-dashboard">Conflict Dashboard</Link>
            <Link className="ghost-btn" to="/room-capability">Room Capability</Link>
            <Link className="primary-btn" to="/course-room-assignment">Course Room Assignment</Link>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Day Windows</h2>
          <p>Daily first-start to last-end windows used by super and control duties.</p>
        </div>
        <div className="day-grid">
          {data.dayWindows.map((window) => (
            <article className="day-card" key={window.date}>
              <h3>{window.date}</h3>
              <p>{window.startTime} - {window.endTime}</p>
              <p>{(window.durationMinutes / 60).toFixed(2)} hours</p>
            </article>
          ))}
          {loading && !data.dayWindows.length ? <div className="empty-state">Loading day windows...</div> : null}
          {!loading && !data.dayWindows.length ? <div className="empty-state">No days available yet. Add sessions first.</div> : null}
        </div>
      </section>
    </div>
  );
}
