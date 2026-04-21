import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../App';

export default function DashboardPage() {
  const [data, setData] = useState({
    totals: {},
    openNeeds: { ta: 0, doctor: 0 },
    dayWindows: []
  });
  const showToast = useToast();

  useEffect(() => {
    api.getDashboard()
      .then(setData)
      .catch((error) => showToast(error.message, 'error'));
  }, []);

  const cards = [
    { label: 'Sessions', value: data.totals.sessions || 0, tone: 'blue' },
    { label: 'Invigilators', value: data.totals.invigilators || 0, tone: 'purple' },
    { label: 'Doctors', value: data.totals.doctors || 0, tone: 'success' },
    { label: 'TAs', value: data.totals.tas || 0, tone: 'warning' },
    { label: 'Session Duties', value: data.totals.assignedSessionDuties || 0, tone: 'blue' },
    { label: 'Super Duties', value: data.totals.superAssignments || 0, tone: 'success' },
    { label: 'Control Duties', value: data.totals.controlAssignments || 0, tone: 'warning' },
    { label: 'Open Needs', value: (data.openNeeds.ta || 0) + (data.openNeeds.doctor || 0), tone: 'danger' }
  ];

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Operational Overview</h2>
            <p>Fast view of staffing pressure, daily windows, and coverage gaps.</p>
          </div>
        </div>
        <div className="summary-grid">
          {cards.map((card) => (
            <div className={`summary-card ${card.tone}`} key={card.label}>
              <div className="summary-card-value">{card.value}</div>
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
          {!data.dayWindows.length ? <div className="empty-state">No days available yet. Add sessions first.</div> : null}
        </div>
      </section>
    </div>
  );
}
