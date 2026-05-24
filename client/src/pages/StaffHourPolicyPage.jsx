import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api, downloadFile } from '../api';
import { useToast } from '../App';

const DEFAULT_DRAFT = {
  mode: 'default',
  hoursValue: 0,
  excludeFromAutoSchedule: false,
  notes: '',
};

function formatHours(value) {
  return Number(value || 0).toFixed(2);
}

function makeDraft(row) {
  const policy = row.policy || null;
  return {
    id: policy?.id || '',
    invigilatorId: row.id,
    staffId: row.staffId,
    role: row.role,
    mode: policy?.mode || 'default',
    hoursValue: Number(policy?.hoursValue || 0),
    excludeFromAutoSchedule: Boolean(policy?.excludeFromAutoSchedule || policy?.mode === 'exclude'),
    notes: policy?.notes || '',
  };
}

export default function StaffHourPolicyPage() {
  const showToast = useToast();
  const [data, setData] = useState({
    rows: [],
    warnings: [],
    averagesByRole: { TA: 0, Doctor: 0 },
    totalRequiredHoursByRole: { TA: 0, Doctor: 0 },
    availableStaffCountByRole: { TA: 0, Doctor: 0 },
  });
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');

  async function load() {
    setLoading(true);
    try {
      const response = await api.getStaffHourPolicies();
      setData(response);
      setDrafts(() => {
        const next = {};
        (response.rows || []).forEach((row) => {
          next[row.id] = makeDraft(row);
        });
        return next;
      });
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const summary = useMemo(() => {
    const rows = data.rows || [];
    return {
      totalStaff: rows.length,
      customPolicies: rows.filter((row) => row.policy).length,
      excluded: rows.filter((row) => row.effectivePolicy?.excluded).length,
      overLimit: rows.filter((row) => (row.effectivePolicy?.hardLimitHours || 0) > 0 && Number(row.currentAssignedHours || 0) > Number(row.effectivePolicy?.hardLimitHours || 0)).length,
    };
  }, [data.rows]);

  function updateDraft(invigilatorId, field, value) {
    setDrafts((current) => ({
      ...current,
      [invigilatorId]: {
        ...(current[invigilatorId] || DEFAULT_DRAFT),
        [field]: value,
      },
    }));
  }

  async function saveRow(row) {
    const draft = drafts[row.id] || makeDraft(row);
    setSavingId(row.id);
    try {
      await api.saveStaffHourPolicy({
        id: draft.id || undefined,
        invigilatorId: row.id,
        staffId: row.staffId,
        role: row.role,
        mode: draft.mode,
        hoursValue: Number(draft.hoursValue || 0),
        excludeFromAutoSchedule: Boolean(draft.excludeFromAutoSchedule || draft.mode === 'exclude'),
        notes: draft.notes || '',
      });
      showToast('Staff hour policy saved.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setSavingId('');
    }
  }

  async function resetRow(row) {
    const draft = drafts[row.id] || makeDraft(row);
    try {
      if (draft.id) {
        await api.deleteStaffHourPolicy(draft.id);
        showToast('Staff hour policy removed.', 'success');
        await load();
        return;
      }
      setDrafts((current) => ({ ...current, [row.id]: makeDraft({ ...row, policy: null }) }));
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function clearAll() {
    if (!window.confirm('Clear all staff hour policies?')) return;
    try {
      await api.deleteAllStaffHourPolicies();
      showToast('All staff hour policies cleared.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets.StaffHourPolicies || workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      const result = await api.importStaffHourPoliciesRows(rows);
      showToast(`Policies imported: ${result.imported || 0}, rejected: ${result.rejected || 0}.`, result.rejected ? 'warning' : 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
  }

  async function exportPolicies() {
    try {
      const file = await api.exportStaffHourPolicies();
      downloadFile(file.url, file.fileName || '');
      showToast('Staff hour policy workbook exported.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Staff Hour Policy</h2>
            <p>Engagements block specific date/time windows. Staff Hour Policy controls total workload targets, hard limits, or exclusion from auto-schedule.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={exportPolicies}>Export Policies</button>
            <label className="ghost-btn" style={{ cursor: 'pointer' }}>
              Import Policies
              <input type="file" accept=".xlsx,.xls" onChange={handleImport} style={{ display: 'none' }} />
            </label>
            <button type="button" className="ghost-btn" onClick={load}>Refresh</button>
            <button type="button" className="ghost-btn" onClick={clearAll}>Clear All</button>
          </div>
        </div>
        <div className="summary-grid">
          <div className="summary-card blue"><div className="summary-card-value">{loading ? '...' : summary.totalStaff}</div><div className="summary-card-label">Staff</div></div>
          <div className="summary-card purple"><div className="summary-card-value">{loading ? '...' : formatHours(data.averagesByRole?.TA)}</div><div className="summary-card-label">TA Avg H</div></div>
          <div className="summary-card success"><div className="summary-card-value">{loading ? '...' : formatHours(data.averagesByRole?.Doctor)}</div><div className="summary-card-label">Doctor Avg H</div></div>
          <div className="summary-card warning"><div className="summary-card-value">{loading ? '...' : summary.customPolicies}</div><div className="summary-card-label">Custom Policies</div></div>
          <div className="summary-card danger"><div className="summary-card-value">{loading ? '...' : summary.excluded}</div><div className="summary-card-label">Excluded Staff</div></div>
          <div className="summary-card danger"><div className="summary-card-value">{loading ? '...' : summary.overLimit}</div><div className="summary-card-label">Over Limit</div></div>
        </div>
        <div className="chips-wrap">
          <div className="info-chip"><strong>TA Required H</strong><span>{formatHours(data.totalRequiredHoursByRole?.TA)}</span></div>
          <div className="info-chip"><strong>Doctor Required H</strong><span>{formatHours(data.totalRequiredHoursByRole?.Doctor)}</span></div>
          <div className="info-chip"><strong>Available TAs</strong><span>{data.availableStaffCountByRole?.TA || 0}</span></div>
          <div className="info-chip"><strong>Available Doctors</strong><span>{data.availableStaffCountByRole?.Doctor || 0}</span></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Warnings</h2>
          <p>These warnings do not change data. They highlight excluded or over-limit staff based on current assignments.</p>
        </div>
        <div className="chips-wrap">
          {(data.warnings || []).map((warning, index) => (
            <div className="info-chip" key={`${warning.staffId || 'warning'}_${index}`}>
              <strong>{warning.staffId || 'Policy warning'}</strong>
              <span>{warning.message}</span>
            </div>
          ))}
          {!loading && !(data.warnings || []).length ? <div className="empty-state small">No policy warnings.</div> : null}
          {loading ? <div className="empty-state small">Loading policy warnings...</div> : null}
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>Policies By Staff</h2>
          <p>Default uses the role average. Exact/add/reduce change the allowed target hours. Exclude blocks auto-schedule and manual assignment.</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>StaffID</th>
                <th>Name</th>
                <th>Role</th>
                <th>Current H</th>
                <th>Role Avg H</th>
                <th>Mode</th>
                <th>Hours Value</th>
                <th>Allowed H</th>
                <th>Exclude</th>
                <th>Notes</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data.rows || []).map((row) => {
                const draft = drafts[row.id] || makeDraft(row);
                return (
                  <tr key={row.id}>
                    <td>{row.staffId}</td>
                    <td>{row.name}</td>
                    <td>{row.role}</td>
                    <td>{formatHours(row.currentAssignedHours)}</td>
                    <td>{formatHours(row.effectivePolicy?.rawAverageHours)}</td>
                    <td>
                      <select value={draft.mode} onChange={(event) => updateDraft(row.id, 'mode', event.target.value)}>
                        <option value="default">default</option>
                        <option value="exact">exact</option>
                        <option value="add">add</option>
                        <option value="reduce">reduce</option>
                        <option value="exclude">exclude</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={draft.hoursValue}
                        onChange={(event) => updateDraft(row.id, 'hoursValue', event.target.value)}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td>{formatHours(row.effectivePolicy?.allowedHours)}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={Boolean(draft.excludeFromAutoSchedule || draft.mode === 'exclude')}
                        onChange={(event) => updateDraft(row.id, 'excludeFromAutoSchedule', event.target.checked)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={draft.notes}
                        onChange={(event) => updateDraft(row.id, 'notes', event.target.value)}
                        style={{ minWidth: 160 }}
                      />
                    </td>
                    <td>{row.effectivePolicy?.excluded ? 'excluded' : (row.effectivePolicy?.mode || 'default')}</td>
                    <td>
                      <div className="action-row">
                        <button type="button" className="primary-btn" onClick={() => saveRow(row)} disabled={savingId === row.id}>
                          {savingId === row.id ? 'Saving...' : 'Save'}
                        </button>
                        <button type="button" className="ghost-btn" onClick={() => resetRow(row)}>Reset</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && !(data.rows || []).length ? (
                <tr><td colSpan="12" className="empty-cell">No invigilators available yet.</td></tr>
              ) : null}
              {loading ? (
                <tr><td colSpan="12" className="empty-cell">Loading staff hour policies...</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
