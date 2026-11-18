import { useEffect, useState } from 'react';
import CollectionToolbar from '../components/CollectionToolbar';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';
import { readInvigilatorsWorkbook } from '../invigilatorsWorkbook.mjs';

const emptyForm = {
  staffId: '',
  name: '',
  email: '',
  role: 'TA',
  loadType: 'full',
  department: '',
  maxHours: 0,
  notes: ''
};

export default function InvigilatorsPage() {
  const [invigilators, setInvigilators] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState('');
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const showToast = useToast();
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  async function load() {
    const response = await api.getInvigilators();
    setInvigilators(response);
  }

  useEffect(() => {
    load().catch((error) => showToast(error.message, 'error'));
  }, []);

  const taList = invigilators.filter((item) => item.role === 'TA');
  const doctorList = invigilators.filter((item) => item.role === 'Doctor');

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    try {
      if (editingId) {
        await api.updateInvigilator(editingId, form);
        showToast('Invigilator updated.', 'success');
      } else {
        await api.createInvigilator(form);
        showToast('Invigilator added.', 'success');
      }
      setForm(emptyForm);
      setEditingId('');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function startEdit(person) {
    setFormOpen(true);
    setEditingId(person.id);
    setForm({
      name: person.name,
      staffId: person.staffId || '',
      email: person.email || '',
      role: person.role,
      loadType: person.loadType || 'full',
      department: person.department || '',
      maxHours: person.maxHours || 0,
      notes: person.notes || ''
    });
  }

  async function remove(id) {
    try {
      await api.deleteInvigilator(id);
      showToast('Invigilator removed.', 'success');
      if (editingId === id) {
        setEditingId('');
        setForm(emptyForm);
      }
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function importExcel(event) {
    const input = event.target;
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportErrors([]);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = readInvigilatorsWorkbook(workbook);
      const result = await api.importInvigilatorsRows(rows);
      showToast(`Staff import: ${result.created || 0} added, ${result.updated || 0} updated, ${result.unchanged || 0} unchanged.`, 'success');
      await load();
    } catch (error) {
      setImportErrors(error.payload?.errors || []);
      showToast(error.message, 'error');
    } finally {
      setImporting(false);
      input.value = '';
    }
  }

  function exportExcel() {
    const rows = invigilators.map((person) => ({
      StaffID: person.staffId || '',
      Name: person.name || '',
      Email: person.email || '',
      Role: person.role || 'TA',
      LoadType: person.loadType || 'full',
      MaxHours: person.maxHours || 0,
      Department: person.department || '',
      Notes: person.notes || ''
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Invigilators');
    XLSX.writeFile(workbook, 'invigilators_export.xlsx');
    showToast('Invigilators exported to Excel.', 'success');
  }

  function downloadTemplate() {
    const workbook = XLSX.utils.book_new();
    const instructions = [
      { Section: 'Purpose', Instruction: 'Use this template to import invigilator master data.' },
      { Section: 'Scope', Instruction: 'This import creates or updates staff records only. It does not create assignments.' },
      { Section: 'Columns', Instruction: 'Recommended columns: StaffID, Name, Email, Role, LoadType, MaxHours, Department, Notes.' },
      { Section: 'Role', Instruction: 'Allowed values: TA or Doctor.' },
      { Section: 'LoadType', Instruction: 'Allowed values: full or half.' },
      { Section: 'Identifiers', Instruction: 'StaffID and Name are required. Each person needs a unique StaffID. Keep identifiers as text to preserve leading zeros.' },
      { Section: 'Updates', Instruction: 'Import updates matching StaffIDs and adds new staff. Unlisted staff, assignments, availability and hour policies are preserved. If any row is invalid, no rows are saved.' },
    ];
    const rows = [
      {
        StaffID: '1001',
        Name: 'Dr. Ahmed Ali',
        Email: 'ahmed.ali@university.edu',
        Role: 'Doctor',
        LoadType: 'full',
        MaxHours: 12,
        Department: 'Civil Engineering',
        Notes: 'Example row'
      },
      {
        StaffID: '2001',
        Name: 'Mona Hassan',
        Email: 'mona.hassan@university.edu',
        Role: 'TA',
        LoadType: 'full',
        MaxHours: 8,
        Department: 'Civil Engineering',
        Notes: 'Example row'
      }
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Invigilators');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(instructions), 'Instructions');
    XLSX.writeFile(workbook, 'invigilators_template.xlsx');
    showToast('Invigilators template downloaded.', 'success');
  }

  async function removeAll() {
    if (!window.confirm('Remove all invigilators, engagements, and related assignments?')) return;
    try {
      await api.deleteAllInvigilators();
      setEditingId('');
      setForm(emptyForm);
      showToast('All invigilators removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  const filteredRows = invigilators.filter((row) => (!roleFilter || row.role === roleFilter) && `${row.name} ${row.staffId} ${row.department || ''} ${row.email || ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <div className="page-grid rules-page collection-page">
      <section className="rules-intro"><div><span className="rules-eyebrow">EXAM OPERATIONS</span><h2>Invigilator directory</h2><p>Manage staff identity, roles, departments, and maximum hours.</p></div><button type="button" className="primary-btn" onClick={() => { setEditingId(''); setForm(emptyForm); setFormOpen(true); }}>Add record</button></section>
      <details className="panel form-panel ops-tools" open={formOpen || Boolean(editingId)} onToggle={(event) => setFormOpen(event.currentTarget.open)}><summary>{editingId ? 'Edit selected record' : 'Add a new record'}</summary>
        <div className="panel-head">
          <h2>Invigilators</h2>
          <p>Split staff into TA and Doctor pools for all later scheduling tabs.</p>
        </div>
        <form className="stack-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              <span>Staff ID</span>
              <input name="staffId" value={form.staffId} onChange={handleChange} placeholder="1001" />
            </label>
            <label>
              <span>Name</span>
              <input name="name" value={form.name} onChange={handleChange} placeholder="Dr. Ahmed Ali" />
            </label>
            <label>
              <span>Email</span>
              <input type="email" name="email" value={form.email} onChange={handleChange} placeholder="name@university.edu" />
            </label>
            <label>
              <span>Role</span>
              <select name="role" value={form.role} onChange={handleChange}>
                <option value="TA">TA</option>
                <option value="Doctor">Doctor</option>
              </select>
            </label>
            <label>
              <span>Load Type</span>
              <select name="loadType" value={form.loadType} onChange={handleChange}>
                <option value="full">full</option>
                <option value="half">half</option>
              </select>
            </label>
            <label>
              <span>Department</span>
              <input name="department" value={form.department} onChange={handleChange} placeholder="Civil Engineering" />
            </label>
            <label>
              <span>Max Hours</span>
              <input type="number" min="0" name="maxHours" value={form.maxHours} onChange={handleChange} />
            </label>
            <label className="wide">
              <span>Notes</span>
              <input name="notes" value={form.notes} onChange={handleChange} placeholder="Any internal note" />
            </label>
          </div>
          <div className="action-row">
            <button type="submit" className="primary-btn">{editingId ? 'Update Invigilator' : 'Add Invigilator'}</button>
            {editingId ? (
              <button type="button" className="ghost-btn" onClick={() => { setEditingId(''); setForm(emptyForm); }}>
                Cancel Edit
              </button>
            ) : null}
          </div>
        </form>
      </details>

      <section className="panel split-panel">
        <div className="panel-head">
          <h2>TA And Doctor Pools</h2>
          <div className="action-row">
            <p>{taList.length} TA, {doctorList.length} Doctor</p>
            <button type="button" className="ghost-btn" onClick={downloadTemplate}>Template</button>
            <label className="ghost-btn">
              {importing ? 'Importing…' : 'Import Excel'}
              <input type="file" accept=".xlsx,.xls" disabled={importing} style={{ display: 'none' }} onChange={importExcel} />
            </label>
            <button type="button" className="ghost-btn" onClick={exportExcel}>Export Excel</button>
            <button type="button" className="danger-btn" onClick={removeAll}>Remove All</button>
          </div>
        </div>
        {importErrors.length ? <div role="alert">
          <p>No staff were imported. Correct these rows in Excel and import again.</p>
          <div className="table-wrap"><table><thead><tr><th>Excel row</th><th>StaffID</th><th>Reason</th></tr></thead><tbody>{importErrors.map((error, index) => <tr key={index}><td>{error.row}</td><td>{error.staffId || '—'}</td><td>{error.error}</td></tr>)}</tbody></table></div>
        </div> : null}
        <CollectionToolbar search={search} onSearch={setSearch} count={filteredRows.length} role={roleFilter} onRole={setRoleFilter} />
        <div className="duo-grid">
          <StaffTable title="TA Invigilators" rows={filteredRows.filter((row) => row.role === 'TA')} onEdit={startEdit} onDelete={remove} />
          <StaffTable title="Doctor Invigilators" rows={filteredRows.filter((row) => row.role === 'Doctor')} onEdit={startEdit} onDelete={remove} />
        </div>
      </section>
    </div>
  );
}

function StaffTable({ title, rows, onEdit, onDelete }) {
  return (
    <div className="mini-table">
      <h3>{title}</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Staff ID</th>
              <th>Dept</th>
              <th>Load</th>
              <th>Max H</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((person) => (
              <tr key={person.id}>
                <td>{person.name}</td>
                <td>{person.email || '-'}</td>
                <td>{person.staffId || '-'}</td>
                <td>{person.department || '-'}</td>
                <td>{person.loadType || 'full'}</td>
                <td>{person.maxHours || 0}</td>
                <td className="row-actions">
                  <button type="button" className="ghost-btn" onClick={() => onEdit(person)}>Edit</button>
                  <button type="button" className="danger-btn" onClick={() => onDelete(person.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan="7" className="empty-cell">No staff in this group yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
