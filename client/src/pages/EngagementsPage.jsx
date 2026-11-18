import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import EngagementEditor from '../components/EngagementEditor';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';

const emptyForm = {
  staffId: '',
  date: '',
  startTime: '',
  endTime: '',
  engagement: 1,
  notes: ''
};

function getPrimaryImportRows(workbook, preferredSheet = 'Engagements') {
  const sheet = workbook.Sheets[preferredSheet]
    || workbook.Sheets[workbook.SheetNames.find((name) => String(name).trim().toLowerCase() !== 'instructions')];
  return sheet ? XLSX.utils.sheet_to_json(sheet) : [];
}

export default function EngagementsPage() {
  const [engagements, setEngagements] = useState([]);
  const [invigilators, setInvigilators] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState('');
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [loadError, setLoadError] = useState('');
  const [filters, setFilters] = useState({ search: '', role: '', status: '', from: '', to: '' });
  const [staffSearch, setStaffSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [importCount, setImportCount] = useState(null);
  const loadSequence = useRef(0);
  const editorRef = useRef(null);

  async function load() {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError('');
    try {
      const [engRows, invRows] = await Promise.all([api.getEngagements(), api.getInvigilators()]);
      if (sequence !== loadSequence.current) return;
      setEngagements(engRows); setInvigilators(invRows);
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(error.message); showToast(error.message, 'error');
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => { load(); return () => { loadSequence.current += 1; }; }, []);

  function resetEditor() { setForm(emptyForm); setEditingId(''); setStaffSearch(''); }
  function focusEditor() {
    requestAnimationFrame(() => {
      editorRef.current?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 1200px)').matches) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!form.staffId || !form.date || !form.startTime || !form.endTime || form.endTime <= form.startTime || !invigilators.some((person) => String(person.staffId || person.id) === String(form.staffId))) { showToast('Choose a staff member, date, and a valid time range.', 'error'); return; }
    setPending('save');
    try {
      if (editingId) {
        await api.updateEngagement(editingId, form);
        showToast('Engagement updated.', 'success');
      } else {
        await api.createEngagement(form);
        showToast('Engagement added.', 'success');
      }
      resetEditor();
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPending(''); }
  }

  async function remove(id) {
    setPending(id);
    try {
      await api.deleteEngagement(id);
      if (editingId === id) resetEditor();
      showToast('Engagement deleted.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPending(''); }
  }

  function edit(item) {
    setStaffSearch('');
    focusEditor();
    setEditingId(item.id);
    setForm({
      staffId: item.staffId,
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      engagement: item.engagement,
      notes: item.notes || ''
    });
  }

  async function importExcel(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setPending('import');
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = getPrimaryImportRows(workbook);
      if (!rows.length) throw new Error('The selected workbook has no engagement rows.');
      const result = await api.importEngagementRows(rows);
      setImportCount(result.count); resetEditor(); setPage(1);
      showToast(`${result.count} engagement rows loaded from Excel.`, 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPending(''); input.value = ''; }
  }

  function exportExcel(source = engagements, filename = 'engagements_export.xlsx') {
    const rows = source.map((item) => ({
      StaffID: item.staffId || '',
      Date: item.date || '',
      Start: item.startTime || '',
      End: item.endTime || '',
      Engagement: item.engagement ?? 1,
      Notes: item.notes || ''
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Engagements');
    XLSX.writeFile(workbook, filename);
    showToast('Engagements exported to Excel.', 'success');
  }

  function downloadTemplate() {
    const workbook = XLSX.utils.book_new();
    const instructions = [
      { Section: 'Purpose', Instruction: 'Use this template to import engagement rows that block staff during specific time periods.' },
      { Section: 'Scope', Instruction: 'Engagements affect availability only. They do not assign staff to sessions. Scheduling may cross engagements when the staff policy permits overrides.' },
      { Section: 'Import', Instruction: 'Import replaces the entire engagement list. Export existing data before preparing a replacement workbook.' },
      { Section: 'Columns', Instruction: 'Recommended columns: StaffID, Date, Start, End, Engagement, Notes.' },
      { Section: 'Engagement', Instruction: 'Use 1 for blocked and 0 for not blocked.' },
      { Section: 'DateTime', Instruction: 'Preferred formats: Date = YYYY-MM-DD, Start/End = HH:MM.' },
    ];
    const rows = [
      {
        StaffID: '1001',
        Date: '2026-06-15',
        Start: '10:00',
        End: '12:00',
        Engagement: 1,
        Notes: 'Blocked during this period'
      }
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Engagements');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(instructions), 'Instructions');
    XLSX.writeFile(workbook, 'engagements_template.xlsx');
    showToast('Engagements template downloaded.', 'success');
  }

  async function removeAll() {
    if (!window.confirm('Remove all engagement rows?')) return;
    setPending('clear');
    try {
      await api.deleteAllEngagements();
      resetEditor();
      showToast('All engagements removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setPending(''); }
  }

  const invigilatorMap = useMemo(() => new Map(invigilators.map((item) => [String(item.staffId || item.id), item])), [invigilators]);
  const visible = useMemo(() => engagements.filter((item) => {
    const person = invigilatorMap.get(String(item.staffId));
    if (filters.role && person?.role !== filters.role) return false;
    if (filters.status !== '' && Number(item.engagement ?? 1) !== Number(filters.status)) return false;
    if (filters.from && item.date < filters.from) return false;
    if (filters.to && item.date > filters.to) return false;
    return `${item.staffId} ${person?.name || ''} ${person?.department || ''} ${item.notes || ''}`.toLocaleLowerCase().includes(filters.search.trim().toLocaleLowerCase());
  }).sort((a, b) => `${a.date}|${a.startTime}|${a.staffId}`.localeCompare(`${b.date}|${b.startTime}|${b.staffId}`)), [engagements, invigilatorMap, filters]);
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const blocked = engagements.filter((item) => Number(item.engagement ?? 1) === 1);
  const busy = loading || Boolean(pending);
  const original = engagements.find((item) => item.id === editingId);
  const baseline = original ? { staffId: original.staffId, date: original.date, startTime: original.startTime, endTime: original.endTime, engagement: Number(original.engagement ?? 1), notes: original.notes || '' } : emptyForm;
  const dirty = JSON.stringify({ ...form, engagement: Number(form.engagement) }) !== JSON.stringify(baseline);
  const timeError = form.startTime && form.endTime && form.endTime <= form.startTime ? 'End time must be later than start time.' : '';
  function updateFilter(key, value) { setFilters((current) => ({ ...current, [key]: value })); setPage(1); }
  function clearFilters() { setFilters({ search: '', role: '', status: '', from: '', to: '' }); setPage(1); }

  return <div className="page-grid rules-page engagements-page">
    <section className="rules-intro"><div><span className="rules-eyebrow">STAFF AVAILABILITY</span><h2>Engagements and unavailable periods</h2><p>Manage when staff are unavailable and review the records behind scheduling decisions.</p></div><div className="action-row"><Link className="ghost-btn" to="/conflict-dashboard">Review conflicts</Link><button type="button" className="ghost-btn" disabled={busy} onClick={() => { api.clearCache(); load(); }}>Refresh</button><button type="button" className="primary-btn" disabled={busy} onClick={() => { resetEditor(); focusEditor(); }}>New engagement</button></div></section>
    {loadError ? <p className="rules-feedback is-error" role="alert">Unable to refresh engagements: {loadError}. Displayed data may be out of date.</p> : null}
    <section className="ops-metrics" aria-label="Engagement summary">{[
      ['Total records', engagements.length, 'All saved availability records'],
      ['Blocked periods', blocked.length, `${engagements.length - blocked.length} not-blocked records`],
      ['Staff with blocked periods', new Set(blocked.map((item) => item.staffId)).size, 'Unique staff IDs'],
      ['Dates with blocked periods', new Set(blocked.map((item) => item.date)).size, 'Across the saved engagement list'],
    ].map(([label, value, note]) => <div className="ops-metric" key={label}><span>{label}</span><strong>{loading ? '...' : value}</strong><small>{note}</small></div>)}</section>
    <div className="panel engagement-policy-note"><div><strong>Engagements and scheduling permission</strong><p>Blocked periods restrict availability. Automatic scheduling may override them only when the staff policy allows it. Existing assignments stay in place until reviewed or rescheduled.</p></div><Link className="ghost-btn" to="/staff-hour-policy">Staff hour policies</Link></div>
    <details className="panel ops-tools"><summary>Excel import, export, and data tools</summary><div className="action-row"><button type="button" className="ghost-btn" onClick={downloadTemplate} disabled={busy}>Download template</button><button type="button" className="ghost-btn" onClick={() => exportExcel()} disabled={busy || !engagements.length}>Export all records</button><button type="button" className="ghost-btn" onClick={() => exportExcel(visible, 'engagements_filtered.xlsx')} disabled={busy || !visible.length}>Export filtered ({visible.length})</button><label className={`ghost-btn ops-upload ${busy ? 'is-disabled' : ''}`}><span>{pending === 'import' ? 'Importing...' : 'Replace from Excel'}</span><input type="file" accept=".xlsx,.xls" onChange={importExcel} disabled={busy} aria-label="Replace all engagements from an Excel workbook" /></label><button type="button" className="ghost-btn ops-danger" onClick={removeAll} disabled={busy || !engagements.length}>Remove all engagements</button></div><p className="ops-help">Excel import replaces the entire engagement list, including records hidden by filters. Export existing records first if you want to keep a copy.</p>{importCount !== null ? <p className="rules-feedback" role="status">{importCount} engagement records loaded from the replacement workbook.</p> : null}</details>
    <div className="engagement-workspace">
      <section className="panel engagement-directory"><div className="panel-head"><div><h2>Engagement records</h2><p>{visible.length} of {engagements.length} records match your filters.</p></div><button type="button" className="ghost-btn" onClick={clearFilters} disabled={!Object.values(filters).some(Boolean)}>Clear filters</button></div>
        <div className="form-grid engagement-filters"><label className="engagement-search"><span>Find staff or notes</span><input type="search" value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} placeholder="Name, staff ID, department, or notes" /></label><label><span>Role</span><select value={filters.role} onChange={(event) => updateFilter('role', event.target.value)}><option value="">All roles</option><option value="TA">TA</option><option value="Doctor">Doctor</option></select></label><label><span>Availability</span><select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}><option value="">All records</option><option value="1">Blocked</option><option value="0">Not blocked</option></select></label><label><span>From date</span><input type="date" value={filters.from} onChange={(event) => updateFilter('from', event.target.value)} /></label><label><span>To date</span><input type="date" min={filters.from || undefined} value={filters.to} onChange={(event) => updateFilter('to', event.target.value)} /></label></div>
        {filters.from && filters.to && filters.to < filters.from ? <p className="ops-inline-warning" role="alert">The end of the date range must be on or after the start.</p> : null}
        <div className="table-wrap engagement-record-table"><table><thead><tr><th>Staff member</th><th>Period</th><th>Availability</th><th>Notes</th><th>Actions</th></tr></thead><tbody>{pageRows.map((item) => {
          const person = invigilatorMap.get(String(item.staffId));
          return <tr key={item.id} className={editingId === item.id ? 'is-selected' : ''}><td><strong dir="auto">{person?.name || item.staffId}</strong><small className="ops-cell-note">{item.staffId}{person ? ` / ${person.role}` : ' / Staff not in current pool'}</small></td><td><strong>{item.date || 'Date not set'}</strong><small className="ops-cell-note">{item.startTime} - {item.endTime}</small></td><td><span className={`ops-badge ${Number(item.engagement ?? 1) === 1 ? 'tone-warning' : 'tone-neutral'}`}>{Number(item.engagement ?? 1) === 1 ? 'Blocked' : 'Not blocked'}</span></td><td><span className="engagement-record-note" dir="auto" title={item.notes || ''}>{item.notes || '-'}</span></td><td><div className="action-row engagement-row-actions"><button type="button" className="ghost-btn" disabled={busy} onClick={() => edit(item)} aria-label={`Edit engagement for ${person?.name || item.staffId} on ${item.date} at ${item.startTime}`}>{editingId === item.id ? 'Editing' : 'Edit'}</button><button type="button" className="ghost-btn ops-danger" disabled={busy} onClick={() => remove(item.id)} aria-label={`Delete engagement for ${person?.name || item.staffId} on ${item.date} at ${item.startTime}`}>Delete</button></div></td></tr>;
        })}</tbody></table>{!pageRows.length ? <div className="empty-state">{loading ? 'Loading engagements...' : engagements.length ? 'No records match these filters.' : 'No engagements yet. Add a period using the editor.'}</div> : null}</div>
        <div className="engagement-pagination"><label>Rows per page<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label><div className="action-row"><span>Page {currentPage} of {totalPages}</span><button type="button" className="ghost-btn" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><button type="button" className="ghost-btn" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>
      </section>
      <EngagementEditor form={form} editingId={editingId} invigilators={invigilators} staffSearch={staffSearch} setStaffSearch={setStaffSearch} onChange={handleChange} onSubmit={handleSubmit} onCancel={resetEditor} busy={busy} dirty={dirty} timeError={timeError} editorRef={editorRef} />
    </div>
  </div>;
}
