import { useEffect, useState } from 'react';
import CollectionToolbar from '../components/CollectionToolbar';
import OperationsOverview from '../components/OperationsOverview';
import { api, downloadFile } from '../api';
import { useToast } from '../App';

export default function SuperInvigilatorsPage() {
  const [data, setData] = useState({ dayWindows: [], doctors: [], assignments: [] });
  const [selectedDoctorByDate, setSelectedDoctorByDate] = useState({});
  const showToast = useToast();
  const [dateFilter, setDateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try { const response = await api.getSuperInvigilators(); setData(response); }
    catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
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
    setPending(true);
    try {
      await api.assignSuperInvigilator({ date, invigilatorId });
      showToast('Doctor assigned as super invigilator.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPending(false); }
  }

  async function remove(id) {
    setPending(true);
    try {
      await api.removeSuperInvigilator(id);
      showToast('Super invigilator removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPending(false); }
  }

  async function removeAll() {
    if (!window.confirm('Remove all super invigilator assignments?')) return;
    setPending(true);
    try {
      await api.removeAllSuperInvigilators();
      showToast('All super invigilator assignments removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPending(false); }
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

  const busy = loading || pending;
  const assignedDates = new Set(data.assignments.map((row) => row.date));
  const visible = data.dayWindows.filter((window) => (!dateFilter || window.date === dateFilter) && (!statusFilter || (statusFilter === 'open' ? !assignedDates.has(window.date) : assignedDates.has(window.date))) && (!search.trim() || data.assignments.some((assignment) => assignment.date === window.date && `${assignment.invigilator?.name || ''} ${assignment.invigilator?.staffId || ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) || window.date.includes(search.trim())));
  return <div className="page-grid rules-page supervision-page"><OperationsOverview eyebrow="DAILY SUPERVISION" title="Super invigilators" description="Assign Doctors to the full daily exam window. Other duties, engagements, and hour policies are checked before saving." loading={loading} metrics={[["Exam days", data.dayWindows.length], ["Doctors", data.doctors.length], ["Assignments", data.assignments.length], ["Days without a supervisor", data.dayWindows.filter((window) => !assignedDates.has(window.date)).length]]}><button type="button" className="ghost-btn" onClick={load} disabled={busy}>Refresh</button><button type="button" className="ghost-btn" onClick={exportAssignments} disabled={busy}>Export assignments</button></OperationsOverview>
    {error ? <p className="rules-feedback is-error" role="alert">Unable to refresh supervision: {error}. Displayed data may be out of date.</p> : null}
    <section className="panel"><div className="panel-head"><div><h2>Daily supervision</h2><p>{visible.length} matching days. Full-day hours count toward staff workload.</p></div></div><CollectionToolbar search={search} onSearch={setSearch} date={dateFilter} onDate={setDateFilter} count={visible.length}><label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All days</option><option value="open">No supervisor</option><option value="assigned">Has assignments</option></select></label></CollectionToolbar>
      <div className="day-grid supervision-grid">{visible.map((window) => {
        const assignments = data.assignments.filter((row) => row.date === window.date);
        return <article className="day-card" key={window.date}><div className="panel-head"><h3>{window.date}</h3><span className={`ops-badge ${assignments.length ? 'tone-success' : 'tone-warning'}`}>{assignments.length ? `${assignments.length} assigned` : 'Unassigned'}</span></div><strong>{window.startTime} - {window.endTime}</strong><p className="ops-help">{(Number(window.durationMinutes || 0) / 60).toFixed(2)} full-day hours</p><label className="engagement-field"><span>Doctor</span><select aria-label={`Doctor for ${window.date}`} disabled={busy} value={selectedDoctorByDate[window.date] || ''} onChange={(event) => setSelectedDoctorByDate((current) => ({ ...current, [window.date]: event.target.value }))}><option value="">Choose a doctor</option>{data.doctors.map((doctor) => <option value={doctor.id} key={doctor.id}>{doctor.name} / {doctor.staffId || doctor.id}</option>)}</select></label><button type="button" className="primary-btn" onClick={() => assign(window.date)} disabled={busy || !selectedDoctorByDate[window.date]}>Assign supervisor</button><ul className="assignment-list">{assignments.map((assignment) => <li key={assignment.id}><span dir="auto">{assignment.invigilator?.name || 'Unknown Doctor'}</span><button type="button" className="ghost-btn" disabled={busy} onClick={() => remove(assignment.id)}>Remove</button></li>)}{!assignments.length ? <li className="empty-li">No supervisor assigned.</li> : null}</ul></article>;
      })}{!visible.length ? <div className="empty-state">{loading ? 'Loading supervision...' : data.dayWindows.length ? 'No days match these filters.' : 'Add exam sessions to create daily supervision windows.'}</div> : null}</div>
      <div className="rules-save-bar"><p>Assignment changes are saved immediately.</p><button type="button" className="ghost-btn ops-danger" onClick={removeAll} disabled={busy || !data.assignments.length}>Remove all supervision assignments</button></div>
    </section>
  </div>;
}
