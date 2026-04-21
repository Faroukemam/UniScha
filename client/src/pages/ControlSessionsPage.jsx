import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';

const emptyForm = {
  courseName: 'Control Session',
  room: 'Control',
  date: '',
  startTime: '',
  endTime: '',
  taNeeded: 0,
  doctorNeeded: 0,
  notes: ''
};

export default function ControlSessionsPage() {
  const [data, setData] = useState({ sessions: [], invigilators: [], assignments: [] });
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState('');
  const [selection, setSelection] = useState({});
  const showToast = useToast();

  async function load() {
    const response = await api.getControlSessions();
    setData(response);
  }

  useEffect(() => {
    load().catch((error) => showToast(error.message, 'error'));
  }, []);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    try {
      if (editingId) {
        await api.updateControlSession(editingId, form);
        showToast('Control session updated.', 'success');
      } else {
        await api.createControlSession(form);
        showToast('Control session created.', 'success');
      }
      setForm(emptyForm);
      setEditingId('');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function startEdit(session) {
    setEditingId(session.id);
    setForm({
      courseName: session.courseName || 'Control Session',
      room: session.room || 'Control',
      date: session.date || '',
      startTime: session.startTime || '',
      endTime: session.endTime || '',
      taNeeded: session.taNeeded || 0,
      doctorNeeded: session.doctorNeeded || 0,
      notes: session.notes || ''
    });
  }

  async function removeSession(id) {
    try {
      await api.deleteControlSession(id);
      if (editingId === id) {
        setEditingId('');
        setForm(emptyForm);
      }
      showToast('Control session deleted.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function removeAssignment(id) {
    try {
      await api.removeControlSessionAssignment(id);
      showToast('Control assignment removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function assign(controlSessionId, role) {
    const invigilatorId = selection[`${controlSessionId}_${role}`];
    if (!invigilatorId) {
      showToast(`Choose a ${role} first.`, 'error');
      return;
    }
    try {
      await api.assignControlSession({ controlSessionId, invigilatorId });
      showToast(`${role} assigned to control session.`, 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function removeAll() {
    if (!window.confirm('Remove all control sessions and assignments?')) return;
    try {
      await api.removeAllControlSessions();
      setEditingId('');
      setForm(emptyForm);
      showToast('All control sessions removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function importExcel(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      await api.importControlSessionsRows(rows);
      showToast('Control sessions imported from Excel.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
  }

  function exportExcel() {
    const rows = data.sessions.map((session) => ({
      CourseName: session.courseName || '',
      Room: session.room || '',
      Date: session.date || '',
      Start: session.startTime || '',
      End: session.endTime || '',
      TANeeded: session.taNeeded || 0,
      DoctorNeeded: session.doctorNeeded || 0,
      InvigilatorsNeeded: session.totalNeeded || ((session.taNeeded || 0) + (session.doctorNeeded || 0)),
      Notes: session.notes || ''
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'ControlSessions');
    XLSX.writeFile(workbook, 'control_sessions_export.xlsx');
    showToast('Control sessions exported to Excel.', 'success');
  }

  function downloadTemplate() {
    const workbook = XLSX.utils.book_new();
    const rows = [
      {
        CourseName: 'Control Session',
        Room: 'Control',
        Date: '2026-06-15',
        Start: '09:00',
        End: '17:00',
        TANeeded: 2,
        DoctorNeeded: 1,
        InvigilatorsNeeded: 3,
        Notes: 'Example control session row'
      }
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'ControlSessions');
    XLSX.writeFile(workbook, 'control_sessions_template.xlsx');
    showToast('Control sessions template downloaded.', 'success');
  }

  const taInvigilators = data.invigilators.filter((item) => item.role === 'TA');
  const doctorInvigilators = data.invigilators.filter((item) => item.role === 'Doctor');

  return (
    <div className="page-grid">
      <section className="panel form-panel">
        <div className="panel-head">
          <h2>CONTROL Session Setup</h2>
          <p>Create control sessions with the same structure used in the main Sessions tab.</p>
        </div>
        <form className="stack-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              <span>Title</span>
              <input name="courseName" value={form.courseName} onChange={handleChange} placeholder="Control Session" />
            </label>
            <label>
              <span>Room</span>
              <input name="room" value={form.room} onChange={handleChange} placeholder="Control" />
            </label>
            <label>
              <span>Date</span>
              <input type="date" name="date" value={form.date} onChange={handleChange} />
            </label>
            <label>
              <span>Start</span>
              <input type="time" name="startTime" value={form.startTime} onChange={handleChange} />
            </label>
            <label>
              <span>End</span>
              <input type="time" name="endTime" value={form.endTime} onChange={handleChange} />
            </label>
            <label>
              <span>TA Need</span>
              <input type="number" min="0" name="taNeeded" value={form.taNeeded} onChange={handleChange} />
            </label>
            <label>
              <span>Doctor Need</span>
              <input type="number" min="0" name="doctorNeeded" value={form.doctorNeeded} onChange={handleChange} />
            </label>
            <label className="wide">
              <span>Notes</span>
              <input name="notes" value={form.notes} onChange={handleChange} placeholder="Any control-room note" />
            </label>
          </div>
          <div className="action-row">
            <button type="submit" className="primary-btn">{editingId ? 'Update Control Session' : 'Add Control Session'}</button>
            {editingId ? (
              <button type="button" className="ghost-btn" onClick={() => { setEditingId(''); setForm(emptyForm); }}>
                Cancel Edit
              </button>
            ) : null}
          </div>
        </form>
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>All Control Sessions</h2>
          <div className="action-row">
            <p>{data.sessions.length} records</p>
            <button type="button" className="ghost-btn" onClick={downloadTemplate}>Template</button>
            <label className="ghost-btn">
              Import Excel
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importExcel} />
            </label>
            <button type="button" className="ghost-btn" onClick={exportExcel}>Export Excel</button>
            <button type="button" className="danger-btn" onClick={removeAll}>Remove All</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Date</th>
                <th>Time</th>
                <th>Room</th>
                <th>TA Need</th>
                <th>Doctor Need</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((session) => (
                <tr key={session.id}>
                  <td>{session.courseName || 'Control Session'}</td>
                  <td>{session.date}</td>
                  <td>{session.startTime} - {session.endTime}</td>
                  <td>{session.room || 'Control'}</td>
                  <td>{session.taNeeded}</td>
                  <td>{session.doctorNeeded}</td>
                  <td className="row-actions">
                    <button type="button" className="ghost-btn" onClick={() => startEdit(session)}>Edit</button>
                    <button type="button" className="danger-btn" onClick={() => removeSession(session.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!data.sessions.length ? (
                <tr>
                  <td colSpan="7" className="empty-cell">No control sessions yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Control Assignments</h2>
          <p>Assign TAs and doctors against each control session record.</p>
        </div>
        <div className="schedule-stack">
          {data.sessions.map((session) => (
            <article className="session-card" key={session.id}>
              <div className="session-header">
                <div>
                  <h3>{session.courseName || 'Control Session'}</h3>
                  <p>{session.date} | {session.startTime} - {session.endTime} | {session.room || 'Control'}</p>
                </div>
                <div className="need-badges">
                  <span>TA {session.taAssignments.length}/{session.taNeeded}</span>
                  <span>Doctor {session.doctorAssignments.length}/{session.doctorNeeded}</span>
                </div>
              </div>

              <div className="duo-grid">
                <div className="duty-column">
                  <h4>TA Assignments</h4>
                  <div className="picker-row">
                    <select value={selection[`${session.id}_TA`] || ''} onChange={(event) => setSelection((current) => ({ ...current, [`${session.id}_TA`]: event.target.value }))}>
                      <option value="">Select TA</option>
                      {taInvigilators.map((person) => (
                        <option key={person.id} value={person.id}>{person.name}</option>
                      ))}
                    </select>
                    <button type="button" className="primary-btn" onClick={() => assign(session.id, 'TA')}>Assign TA</button>
                  </div>
                  <ul className="assignment-list">
                    {session.taAssignments.map((assignment) => (
                      <li key={assignment.id}>
                        <span>{assignment.invigilator?.name || 'Unknown'}</span>
                        <button type="button" className="ghost-btn" onClick={() => removeAssignment(assignment.id)}>Remove</button>
                      </li>
                    ))}
                    {!session.taAssignments.length ? <li className="empty-li">No TA assigned yet.</li> : null}
                  </ul>
                </div>

                <div className="duty-column">
                  <h4>Doctor Assignments</h4>
                  <div className="picker-row">
                    <select value={selection[`${session.id}_Doctor`] || ''} onChange={(event) => setSelection((current) => ({ ...current, [`${session.id}_Doctor`]: event.target.value }))}>
                      <option value="">Select Doctor</option>
                      {doctorInvigilators.map((person) => (
                        <option key={person.id} value={person.id}>{person.name}</option>
                      ))}
                    </select>
                    <button type="button" className="primary-btn" onClick={() => assign(session.id, 'Doctor')}>Assign Doctor</button>
                  </div>
                  <ul className="assignment-list">
                    {session.doctorAssignments.map((assignment) => (
                      <li key={assignment.id}>
                        <span>{assignment.invigilator?.name || 'Unknown'}</span>
                        <button type="button" className="ghost-btn" onClick={() => removeAssignment(assignment.id)}>Remove</button>
                      </li>
                    ))}
                    {!session.doctorAssignments.length ? <li className="empty-li">No doctor assigned yet.</li> : null}
                  </ul>
                </div>
              </div>
            </article>
          ))}
          {!data.sessions.length ? <div className="empty-state">Create a control session first.</div> : null}
        </div>
      </section>
    </div>
  );
}
