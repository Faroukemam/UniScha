import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../App';

export default function DayCoveragePage() {
  const [rows, setRows] = useState([]);
  const showToast = useToast();

  useEffect(() => {
    api.getDayCoverage()
      .then(setRows)
      .catch((error) => showToast(error.message, 'error'));
  }, []);

  return (
    <section className="panel table-panel">
      <div className="panel-head">
        <h2>Day Coverage</h2>
        <p>Daily coverage health across sessions, super invigilators, and control assignments.</p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Window</th>
              <th>Sessions</th>
              <th>TA Remaining</th>
              <th>Doctor Remaining</th>
              <th>Super Assigned</th>
              <th>Control Assigned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td>{row.startTime} - {row.endTime}</td>
                <td>{row.sessionCount}</td>
                <td>{row.taRemaining}</td>
                <td>{row.doctorRemaining}</td>
                <td>{row.superCount}</td>
                <td>{row.controlCount}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan="7" className="empty-cell">No daily coverage data yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
