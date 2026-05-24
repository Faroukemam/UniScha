import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../App';

function formatHours(minutes) {
  return (minutes / 60).toFixed(2);
}

export default function WorkloadPage() {
  const [data, setData] = useState({ rows: [], dayWindows: [] });
  const [loading, setLoading] = useState(true);
  const showToast = useToast();

  useEffect(() => {
    setLoading(true);
    api.getWorkload()
      .then(setData)
      .catch((error) => showToast(error.message, 'error'))
      .finally(() => setLoading(false));
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
          {loading && !data.dayWindows.length ? <div className="empty-state small">Loading day windows...</div> : null}
          {!loading && !data.dayWindows.length ? <div className="empty-state small">No session days available yet.</div> : null}
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>Work Load</h2>
          <p>Combined totals from session assignments, on-call duties, super invigilators, and control sessions.</p>
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
                <th>On-Call H</th>
                <th>Total H</th>
                <th>Role Avg H</th>
                <th>Allowed H</th>
                <th>Diff Target H</th>
                <th>Policy Mode</th>
                <th>Policy Status</th>
                <th>Session Count</th>
                <th>On-Call Count</th>
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
                  <td>{formatHours(row.onCallMinutes || 0)}</td>
                  <td>{formatHours(row.totalMinutes)}</td>
                  <td>{Number(row.roleAverageHours || 0).toFixed(2)}</td>
                  <td>{Number(row.effectiveAllowedHours || 0).toFixed(2)}</td>
                  <td>{Number(row.differenceFromTargetHours || 0).toFixed(2)}</td>
                  <td>{row.policyMode || 'default'}</td>
                  <td>{row.policyStatus || 'default'}</td>
                  <td>{row.sessionCount}</td>
                  <td>{row.onCallCount || 0}</td>
                  <td>{row.superCount}</td>
                  <td>{row.controlCount}</td>
                </tr>
              ))}
              {!data.rows.length ? (
                <tr>
                  <td colSpan="16" className="empty-cell">{loading ? 'Loading workload data...' : 'No workload data yet.'}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
