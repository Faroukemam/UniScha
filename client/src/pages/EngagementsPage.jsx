import { useEffect, useState } from 'react';
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

  async function load() {
    const [engRows, invRows] = await Promise.all([api.getEngagements(), api.getInvigilators()]);
    setEngagements(engRows);
    setInvigilators(invRows);
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
        await api.updateEngagement(editingId, form);
        showToast('Engagement updated.', 'success');
      } else {
        await api.createEngagement(form);
        showToast('Engagement added.', 'success');
      }
      setForm(emptyForm);
      setEditingId('');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function remove(id) {
    try {
      await api.deleteEngagement(id);
      showToast('Engagement deleted.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function edit(item) {
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
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = getPrimaryImportRows(workbook);
      await api.importEngagementRows(rows);
      showToast('Engagements imported from Excel.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
  }

  function exportExcel() {
    const rows = engagements.map((item) => ({
      StaffID: item.staffId || '',
      Date: item.date || '',
      Start: item.startTime || '',
      End: item.endTime || '',
      Engagement: item.engagement ?? 1,
      Notes: item.notes || ''
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Engagements');
    XLSX.writeFile(workbook, 'engagements_export.xlsx');
    showToast('Engagements exported to Excel.', 'success');
  }

  function downloadTemplate() {
    const workbook = XLSX.utils.book_new();
    const instructions = [
      { Section: 'Purpose', Instruction: 'Use this template to import engagement rows that block staff during specific time periods.' },
      { Section: 'Scope', Instruction: 'Engagements affect availability only. They do not assign staff to sessions.' },
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
    try {
      await api.deleteAllEngagements();
      setEditingId('');
      setForm(emptyForm);
      showToast('All engagements removed.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  const invigilatorMap = new Map(invigilators.map((item) => [item.staffId || item.id, item]));

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-head">
          <h2>Staff Engagement</h2>
          <p>Block invigilators from being assigned during unavailable periods.</p>
        </div>
        <form className="stack-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              <span>Staff</span>
              <select name="staffId" value={form.staffId} onChange={handleChange}>
                <option value="">Select staff</option>
                {invigilators.map((person) => (
                  <option key={person.id} value={person.staffId || person.id}>{person.name} ({person.role})</option>
                ))}
              </select>
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
              <span>Engagement Flag</span>
              <select name="engagement" value={form.engagement} onChange={handleChange}>
                <option value="1">Blocked</option>
                <option value="0">Not Blocked</option>
              </select>
            </label>
            <label className="wide">
              <span>Notes</span>
              <input name="notes" value={form.notes} onChange={handleChange} />
            </label>
          </div>
          <div className="action-row">
            <button type="submit" className="primary-btn">{editingId ? 'Update Engagement' : 'Add Engagement'}</button>
            {editingId ? <button type="button" className="ghost-btn" onClick={() => { setEditingId(''); setForm(emptyForm); }}>Cancel</button> : null}
          </div>
        </form>
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>Blocked Periods</h2>
          <div className="action-row">
            <p>{engagements.length} rows</p>
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
                <th>Staff</th>
                <th>Date</th>
                <th>Time</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {engagements.map((item) => (
                <tr key={item.id}>
                  <td>{invigilatorMap.get(item.staffId)?.name || item.staffId}</td>
                  <td>{item.date}</td>
                  <td>{item.startTime} - {item.endTime}</td>
                  <td>{Number(item.engagement) === 1 ? 'Blocked' : 'Open'}</td>
                  <td className="row-actions">
                    <button type="button" className="ghost-btn" onClick={() => edit(item)}>Edit</button>
                    <button type="button" className="danger-btn" onClick={() => remove(item.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {!engagements.length ? <tr><td colSpan="5" className="empty-cell">No engagement rows yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
