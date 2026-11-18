import { useEffect, useState } from 'react';
import CollectionToolbar from '../components/CollectionToolbar';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';
import { readSessionNeedsWorkbook } from '../sessionNeedsWorkbook.mjs';

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

function getPrimaryImportRows(workbook, preferredSheets = []) {
  const preferred = preferredSheets.find((name) => workbook.Sheets[name]);
  if (preferred) {
    return XLSX.utils.sheet_to_json(workbook.Sheets[preferred]);
  }
  const firstDataSheet = workbook.SheetNames.find((name) => String(name).trim().toLowerCase() !== 'instructions');
  if (!firstDataSheet) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstDataSheet]);
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState('');
  const showToast = useToast();
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await api.getSessions();
      setSessions(response);
    } finally {
      setLoading(false);
    }
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
    setFormOpen(true);
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

  async function readExcelRows(file, preferredSheets = []) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    return getPrimaryImportRows(workbook, preferredSheets);
  }

  async function importSessionsExcel(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const rows = await readExcelRows(file, ['Sessions']);
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
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = readSessionNeedsWorkbook(workbook);
      const result = await api.importSessionNeedsRows(rows);
      const missed = result.unmatched?.length ? ` ${result.unmatched.length} unmatched rows.` : '';
      const rejected = result.rejected?.length ? ` ${result.rejected.length} invalid rows.` : '';
      const firstIssue = result.rejected?.[0] || result.unmatched?.[0];
      const issueReason = String(firstIssue?.reason || (result.rejected?.length ? 'invalid needs row' : 'session not found')).replace(/_/g, ' ');
      const detail = firstIssue ? ` First issue: row ${firstIssue.row ?? 'unknown'}, ${issueReason}.` : '';
      showToast(`Session needs updated: ${result.updated || 0}.${missed}${rejected}${detail}`, firstIssue ? 'warning' : 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
  }

  function exportSessionsExcel() {
    const rows = sessions.map((session) => ({
      Room: session.room || '',
      CourseCode: getSessionCourses(session) || '',
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
    const instructions = [
      { Section: 'Purpose', Instruction: 'Use this template to import session master rows only.' },
      { Section: 'Scope', Instruction: 'This import creates or updates Scheduling sessions. It does not assign invigilators.' },
      { Section: 'Columns', Instruction: 'Required columns: Room, CourseCode, Date, Start, End.' },
      { Section: 'CourseCode', Instruction: 'Use one course code per row or a semicolon-separated list when a room block contains multiple courses.' },
      { Section: 'DateTime', Instruction: 'Preferred formats: Date = YYYY-MM-DD, Start/End = HH:MM.' },
    ];
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
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(instructions), 'Instructions');
    XLSX.writeFile(workbook, 'sessions_template.xlsx');
    showToast('Sessions template downloaded.', 'success');
  }

  function downloadNeedsTemplate() {
    const workbook = XLSX.utils.book_new();
    const instructions = [
      { Section: 'Purpose', Instruction: 'Use this template to update TA/Doctor staffing needs for existing or matched sessions.' },
      { Section: 'Matching', Instruction: 'SessionID is preferred. If omitted, matching falls back to Room + Date + Start (+ End/CourseCode when needed).' },
      { Section: 'Columns', Instruction: 'Recommended columns: SessionID, Room, Date, Start, End, TANeeded, DoctorNeeded, InvigilatorsNeeded.' },
      { Section: 'Needs', Instruction: 'Use non-negative whole numbers for TANeeded and DoctorNeeded. Blank cells preserve existing needs; totals are calculated from the two roles.' },
      { Section: 'DateTime', Instruction: 'Preferred formats: Date = YYYY-MM-DD, Start/End = HH:MM.' },
    ];
    const rows = sessions.length ? sessions.map((session) => ({
      SessionID: session.id,
      Room: session.room || '',
      CourseCode: getSessionCourses(session),
      Date: session.date || '',
      Start: session.startTime || '',
      End: session.endTime || '',
      TANeeded: session.taNeeded || 0,
      DoctorNeeded: session.doctorNeeded || 0,
      InvigilatorsNeeded: (session.taNeeded || 0) + (session.doctorNeeded || 0)
    })) : [
      {
        SessionID: '',
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
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(instructions), 'Instructions');
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

  const filteredRows = sessions.filter((row) => (!dateFilter || row.date === dateFilter) && `${row.room} ${row.date} ${getSessionCourses(row)} ${row.notes || ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <div className="page-grid rules-page collection-page">
      <section className="rules-intro"><div><span className="rules-eyebrow">EXAM OPERATIONS</span><h2>Exam sessions</h2><p>Build the exam timetable and set staffing needs.</p></div><button type="button" className="primary-btn" onClick={() => { setEditingId(''); setForm(emptyForm); setFormOpen(true); }}>Add record</button></section>
      <details className="panel form-panel ops-tools" open={formOpen || Boolean(editingId)} onToggle={(event) => setFormOpen(event.currentTarget.open)}><summary>{editingId ? 'Edit selected record' : 'Add a new record'}</summary>
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
      </details>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>All Sessions</h2>
          <div className="action-row">
            <p>{loading ? 'Loading...' : `${sessions.length} records`}</p>
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
        <CollectionToolbar search={search} onSearch={setSearch} count={filteredRows.length} date={dateFilter} onDate={setDateFilter} />
        <div className="table-wrap ops-bounded-table">
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
              {filteredRows.map((session) => (
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
              {loading && !filteredRows.length ? (
                <tr>
                  <td colSpan="7" className="empty-cell">Loading sessions...</td>
                </tr>
              ) : null}
              {!loading && !filteredRows.length ? (
                <tr>
                  <td colSpan="7" className="empty-cell">{sessions.length ? 'No sessions match these filters.' : 'No sessions yet.'}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
