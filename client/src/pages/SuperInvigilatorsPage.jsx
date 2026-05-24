import { useEffect, useState } from 'react';
import { api, downloadFile } from '../api';
import { useToast } from '../App';

export default function SuperInvigilatorsPage() {
  const [data, setData] = useState({ dayWindows: [], doctors: [], assignments: [] });
  const [selectedDoctorByDate, setSelectedDoctorByDate] = useState({});
  const showToast = useToast();

  async function load() {
    const response = await api.getSuperInvigilators();
    setData(response);
  }

  useEffect(() => {
    load().catch((error) => showToast(error.message, 'error'));
  }, []);

  async function assign(date) {
    const invigilatorId = selectedDoctorByDate[date];
    if (!invigilatorId) {
      showToast('Choose a doctor first.', 'error');
      return;
    }
    try {
      await api.assignSuperInvigilator({ date, invigilatorId });
      showToast('Doctor assigned as super invigilator.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function remove(id) {
    try {
      await api.removeSuperInvigilator(id);
      showToast('Super invigilator removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function removeAll() {
    if (!window.confirm('Remove all super invigilator assignments?')) return;
    try {
      await api.removeAllSuperInvigilators();
      showToast('All super invigilator assignments removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function exportAssignments() {
    try {
      const file = await api.exportSuperInvigilators();
      downloadFile(file.url, file.fileName || 'super_invigilator_assignments.xlsx');
      showToast('Super invigilator assignments exported.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  return (
    <section className="panel table-panel">
      <div className="panel-head">
        <div>
          <h2>Super Invigilators</h2>
          <p>Doctor-only assignments that automatically span the first session start to the last session end each day.</p>
        </div>
        <div className="action-row">
          <button type="button" className="ghost-btn" onClick={exportAssignments}>Export Assignments</button>
          <button type="button" className="danger-btn" onClick={removeAll}>Remove All</button>
        </div>
      </div>
      <div className="day-grid">
        {data.dayWindows.map((window) => {
          const assignments = data.assignments.filter((item) => item.date === window.date);
          return (
            <article className="day-card" key={window.date}>
              <h3>{window.date}</h3>
              <p>{window.startTime} - {window.endTime}</p>
              <p>{(window.durationMinutes / 60).toFixed(2)} hours full-day coverage</p>
              <div className="picker-row">
                <select
                  value={selectedDoctorByDate[window.date] || ''}
                  onChange={(event) => setSelectedDoctorByDate((current) => ({ ...current, [window.date]: event.target.value }))}
                >
                  <option value="">Select doctor</option>
                  {data.doctors.map((doctor) => (
                    <option key={doctor.id} value={doctor.id}>{doctor.name}</option>
                  ))}
                </select>
                <button type="button" className="primary-btn" onClick={() => assign(window.date)}>Assign</button>
              </div>
              <ul className="assignment-list">
                {assignments.map((assignment) => (
                  <li key={assignment.id}>
                    <span>{assignment.invigilator?.name || 'Unknown doctor'}</span>
                    <button type="button" className="ghost-btn" onClick={() => remove(assignment.id)}>Remove</button>
                  </li>
                ))}
                {!assignments.length ? <li className="empty-li">No doctor assigned yet.</li> : null}
              </ul>
            </article>
          );
        })}
        {!data.dayWindows.length ? <div className="empty-state">Add sessions first so the daily coverage window can be calculated.</div> : null}
      </div>
    </section>
  );
}
