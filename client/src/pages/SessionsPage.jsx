import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';

const emptyForm = {
  courseName: '',
  courseNames: '',
  room: '',
  date: '',
  startTime: '',
  endTime: '',
  taNeeded: 0,
  doctorNeeded: 0,
  notes: ''
};

function getSessionCourses(session) {
  if (Array.isArray(session.courseNames) && session.courseNames.length) {
    return session.courseNames.join('; ');
  }
  return session.courseName || '';
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState('');
  const showToast = useToast();

  async function load() {
    const response = await api.getSessions();
    setSessions(response);
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
        await api.updateSession(editingId, form);
        showToast('Session updated.', 'success');
      } else {
        await api.createSession(form);
        showToast('Session created.', 'success');
      }
      setForm(emptyForm);
      setEditingId('');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function handleEdit(session) {
    setEditingId(session.id);
    setForm({
      courseName: session.courseName || '',
      courseNames: Array.isArray(session.courseNames) ? session.courseNames.join('; ') : (session.courseName || ''),
      room: session.room || '',
      date: session.date || '',
      startTime: session.startTime || '',
      endTime: session.endTime || '',
      taNeeded: session.taNeeded || 0,
      doctorNeeded: session.doctorNeeded || 0,
      notes: session.notes || ''
    });
  }

  async function handleDelete(id) {
    try {
      await api.deleteSession(id);
      showToast('Session deleted.', 'success');
      if (editingId === id) {
        setEditingId('');
        setForm(emptyForm);
      }
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function readExcelRows(file) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  }

  async function importSessionsExcel(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const rows = await readExcelRows(file);
      await api.importSessionsRows(rows);
      showToast('Session records imported from Excel.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
  }

  async function importNeedsExcel(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const rows = await readExcelRows(file);
      const result = await api.importSessionNeedsRows(rows);
      const missed = result.unmatched?.length ? ` ${result.unmatched.length} unmatched rows.` : '';
      showToast(`Session needs updated: ${result.updated || 0}.${missed}`, result.unmatched?.length ? 'warning' : 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
  }

  function exportSessionsExcel() {
    const rows = sessions.map((session) => ({
      Room: session.room || '',
      CourseCode: getSessionCourses(session).split(';')[0]?.trim() || '',
      Date: session.date || '',
      Start: session.startTime || '',
      End: session.endTime || ''
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Sessions');
    XLSX.writeFile(workbook, 'sessions_export.xlsx');
    showToast('Sessions exported to Excel.', 'success');
  }

  function exportNeedsExcel() {
    const rows = sessions.map((session) => ({
      SessionID: session.id,
      Room: session.room || '',
      Date: session.date || '',
      Start: session.startTime || '',
      End: session.endTime || '',
      TANeeded: session.taNeeded || 0,
      DoctorNeeded: session.doctorNeeded || 0,
      InvigilatorsNeeded: session.totalNeeded || ((session.taNeeded || 0) + (session.doctorNeeded || 0))
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'SessionNeeds');
    XLSX.writeFile(workbook, 'session_needs_export.xlsx');
    showToast('Session needs exported to Excel.', 'success');
  }

  function downloadSessionsTemplate() {
    const workbook = XLSX.utils.book_new();
    const rows = [
      {
        Room: '324 R PH',
        CourseCode: 'BME407',
        Date: '6/1/2026',
        Start: '09:30',
        End: '11:30'
      }
      ,
      {
        Room: '325 R PH',
        CourseCode: 'CIE301',
        Date: '6/1/2026',
        Start: '12:00',
        End: '14:00'
      }
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Sessions');
    XLSX.writeFile(workbook, 'sessions_template.xlsx');
    showToast('Sessions template downloaded.', 'success');
  }

  function downloadNeedsTemplate() {
    const workbook = XLSX.utils.book_new();
    const rows = [
      {
        SessionID: 'optional-existing-session-id',
        Room: '324 R PH',
        Date: '6/1/2026',
        Start: '09:30',
        End: '11:30',
        TANeeded: 1,
        DoctorNeeded: 1,
        InvigilatorsNeeded: 2
      },
      {
        SessionID: '',
        Room: '325 R PH',
        Date: '6/1/2026',
        Start: '12:00',
        End: '14:00',
        TANeeded: 1,
        DoctorNeeded: 0,
        InvigilatorsNeeded: 1
      }
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'SessionNeeds');
    XLSX.writeFile(workbook, 'session_needs_template.xlsx');
    showToast('Session needs template downloaded.', 'success');
  }

  async function removeAll() {
    if (!window.confirm('Remove all sessions and related assignments?')) return;
    try {
      await api.deleteAllSessions();
      setEditingId('');
      setForm(emptyForm);
      showToast('All sessions removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  return (
    <div className="page-grid">
      <section className="panel form-panel">
        <div className="panel-head">
          <h2>Sessions</h2>
          <p>Create exam sessions, then manage TA and doctor needs with the separate needs import.</p>
        </div>
        <form className="stack-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label className="wide">
              <span>Course Codes</span>
              <input name="courseNames" value={form.courseNames} onChange={handleChange} placeholder="CIE301; MTH204" />
            </label>
            <label>
              <span>Room</span>
              <input name="room" value={form.room} onChange={handleChange} placeholder="Hall A2" />
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
              <input name="notes" value={form.notes} onChange={handleChange} placeholder="Special seating or handling note" />
            </label>
          </div>
          <div className="action-row">
            <button type="submit" className="primary-btn">{editingId ? 'Update Session' : 'Add Session'}</button>
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
          <h2>All Sessions</h2>
          <div className="action-row">
            <p>{sessions.length} records</p>
            <button type="button" className="ghost-btn" onClick={downloadSessionsTemplate}>Sessions Template</button>
            <label className="ghost-btn">
              Import Sessions
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importSessionsExcel} />
            </label>
            <button type="button" className="ghost-btn" onClick={exportSessionsExcel}>Export Sessions</button>
            <button type="button" className="ghost-btn" onClick={downloadNeedsTemplate}>Needs Template</button>
            <label className="ghost-btn">
              Import Needs
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importNeedsExcel} />
            </label>
            <button type="button" className="ghost-btn" onClick={exportNeedsExcel}>Export Needs</button>
            <button type="button" className="danger-btn" onClick={removeAll}>Remove All</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Course Codes</th>
                <th>Date</th>
                <th>Time</th>
                <th>Room</th>
                <th>TA Need</th>
                <th>Doctor Need</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>{getSessionCourses(session) || '-'}</td>
                  <td>{session.date}</td>
                  <td>{session.startTime} - {session.endTime}</td>
                  <td>{session.room || '-'}</td>
                  <td>{session.taNeeded}</td>
                  <td>{session.doctorNeeded}</td>
                  <td className="row-actions">
                    <button type="button" className="ghost-btn" onClick={() => handleEdit(session)}>Edit</button>
                    <button type="button" className="danger-btn" onClick={() => handleDelete(session.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!sessions.length ? (
                <tr>
                  <td colSpan="7" className="empty-cell">No sessions yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
