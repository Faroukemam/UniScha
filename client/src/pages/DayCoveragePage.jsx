import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../App';

export default function DayCoveragePage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const showToast = useToast();

  useEffect(() => {
    setLoading(true);
    api.getDayCoverage()
      .then(setRows)
      .catch((error) => showToast(error.message, 'error'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="panel table-panel">
      <div className="panel-head">
        <h2>Day Coverage</h2>
        <p>Daily aggregate coverage across sessions, on-call reserve coverage, super invigilators, and control assignments. On-call values here are summed from exact same-date same-start same-end periods.</p>
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
              <th>On-Call TA Need (Day)</th>
              <th>On-Call TA Assigned (Day)</th>
              <th>On-Call TA Remaining (Day)</th>
              <th>On-Call Doctor Need (Day)</th>
              <th>On-Call Doctor Assigned (Day)</th>
              <th>On-Call Doctor Remaining (Day)</th>
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
                <td>{row.onCallTANeeded || 0}</td>
                <td>{row.onCallTAAssigned || 0}</td>
                <td>{row.onCallTARemaining || 0}</td>
                <td>{row.onCallDoctorNeeded || 0}</td>
                <td>{row.onCallDoctorAssigned || 0}</td>
                <td>{row.onCallDoctorRemaining || 0}</td>
                <td>{row.superCount}</td>
                <td>{row.controlCount}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan="13" className="empty-cell">{loading ? 'Loading daily coverage...' : 'No daily coverage data yet.'}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
