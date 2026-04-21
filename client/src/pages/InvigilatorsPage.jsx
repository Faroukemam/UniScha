import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';

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
  const showToast = useToast();

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
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      await api.importInvigilatorsRows(rows);
      showToast('Invigilators imported from Excel.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
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

  return (
    <div className="page-grid">
      <section className="panel form-panel">
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
      </section>

      <section className="panel split-panel">
        <div className="panel-head">
          <h2>TA And Doctor Pools</h2>
          <div className="action-row">
            <p>{taList.length} TA, {doctorList.length} Doctor</p>
            <button type="button" className="ghost-btn" onClick={downloadTemplate}>Template</button>
            <label className="ghost-btn">
              Import Excel
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={importExcel} />
            </label>
            <button type="button" className="ghost-btn" onClick={exportExcel}>Export Excel</button>
            <button type="button" className="danger-btn" onClick={removeAll}>Remove All</button>
          </div>
        </div>
        <div className="duo-grid">
          <StaffTable title="TA Invigilators" rows={taList} onEdit={startEdit} onDelete={remove} />
          <StaffTable title="Doctor Invigilators" rows={doctorList} onEdit={startEdit} onDelete={remove} />
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
