import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../App';

function formatHours(minutes) {
  return (minutes / 60).toFixed(2);
}

export default function WorkloadPage() {
  const [data, setData] = useState({ rows: [], dayWindows: [] });
  const showToast = useToast();

  useEffect(() => {
    api.getWorkload()
      .then(setData)
      .catch((error) => showToast(error.message, 'error'));
  }, []);

  return (
    <div className="page-grid">
      <section className="panel summary-panel">
        <div className="panel-head">
          <h2>Daily Full-Day Windows</h2>
          <p>These ranges drive super invigilators and control session duration.</p>
        </div>
        <div className="chips-wrap">
          {data.dayWindows.map((window) => (
            <div className="info-chip" key={window.date}>
              <strong>{window.date}</strong>
              <span>{window.startTime} - {window.endTime}</span>
            </div>
          ))}
          {!data.dayWindows.length ? <div className="empty-state small">No session days available yet.</div> : null}
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>Work Load</h2>
          <p>Combined totals from session assignments, super invigilators, and control sessions.</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Session H</th>
                <th>Super H</th>
                <th>Control H</th>
                <th>Total H</th>
                <th>Session Count</th>
                <th>Super Count</th>
                <th>Control Count</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.role}</td>
                  <td>{formatHours(row.sessionMinutes)}</td>
                  <td>{formatHours(row.superMinutes)}</td>
                  <td>{formatHours(row.controlMinutes)}</td>
                  <td>{formatHours(row.totalMinutes)}</td>
                  <td>{row.sessionCount}</td>
                  <td>{row.superCount}</td>
                  <td>{row.controlCount}</td>
                </tr>
              ))}
              {!data.rows.length ? (
                <tr>
                  <td colSpan="9" className="empty-cell">No workload data yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
