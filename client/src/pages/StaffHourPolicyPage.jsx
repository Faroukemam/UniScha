import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import StaffPolicyEditor from '../components/StaffPolicyEditor';
import * as XLSX from 'xlsx';
import { api, downloadFile } from '../api';
import { useToast } from '../App';
import { readStaffHourPolicyWorkbook } from '../staffHourPolicyWorkbook.mjs';
import { makeStaffHourPolicyDraft as makeDraft, reconcileStaffHourPolicyDrafts } from '../staffHourPolicyDrafts.mjs';

const DEFAULT_DRAFT = {
  mode: 'default',
  hoursValue: 0,
  excludeFromAutoSchedule: false,
  preferConsecutiveDuties: false,
  preferConsecutiveDays: false,
  allowEngagementOverride: true,
  notes: '',
};

function formatHours(value) {
  return Number(value || 0).toFixed(2);
}

function previewPolicy(row, draft) {
  const average = Number(row.effectivePolicy?.rawAverageMinutes || 0);
  const value = Math.round(Number(draft.hoursValue || 0) * 60);
  const excluded = draft.mode === 'exclude' || draft.excludeFromAutoSchedule;
  const allowed = excluded ? 0 : draft.mode === 'exact' ? value
    : draft.mode === 'add' ? average + value : draft.mode === 'reduce' ? Math.max(0, average - value) : average;
  const max = Math.round(Number(row.maxHours || 0) * 60);
  const custom = ['exact', 'add', 'reduce'].includes(draft.mode);
  const limit = excluded ? 0 : custom ? (max > 0 ? Math.min(max, allowed) : allowed) : max;
  return { allowedHours: allowed / 60, limitHours: limit / 60, hasLimit: excluded || custom || max > 0 };
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
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const [bulkAction, setBulkAction] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [policyFilter, setPolicyFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [loadError, setLoadError] = useState('');
  const loadSequence = useRef(0);
  const editedIds = useRef(new Set());

  async function load({ preserveEdits = false } = {}) {
    const sequence = ++loadSequence.current;
    setLoadError('');
    if (!preserveEdits) {
      editedIds.current.clear();
      setLoading(true);
    }
    try {
      const response = await api.getStaffHourPolicies();
      if (sequence !== loadSequence.current) return;
      setData(response);
      // Only explicit field edits survive background refreshes. A changed server
      // response must not turn old, untouched field values into unsaved edits.
      const editedSnapshot = new Set(editedIds.current);
      setDrafts((current) => reconcileStaffHourPolicyDrafts(response.rows || [], current, editedSnapshot));
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(error.message);
      showToast(error.message, 'error');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const refresh = () => { load({ preserveEdits: true }); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('scheduler:data-changed', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      loadSequence.current += 1;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('scheduler:data-changed', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  const summary = useMemo(() => {
    const rows = data.rows || [];
    return {
      totalStaff: rows.length,
      customPolicies: rows.filter((row) => row.policy).length,
      excluded: rows.filter((row) => row.effectivePolicy?.excluded).length,
      overLimit: rows.filter((row) => row.effectivePolicy?.hasHardLimit && Number(row.currentAssignedHours || 0) > Number(row.effectivePolicy?.hardLimitHours || 0)).length,
    };
  }, [data.rows]);

  function updateDraft(invigilatorId, field, value) {
    editedIds.current.add(invigilatorId);
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
        preferConsecutiveDuties: Boolean(draft.preferConsecutiveDuties),
        preferConsecutiveDays: Boolean(draft.preferConsecutiveDays),
        allowEngagementOverride: Boolean(draft.allowEngagementOverride),
        notes: draft.notes || '',
      });
      editedIds.current.delete(row.id);
      showToast('Staff hour policy saved.', 'success');
      await load({ preserveEdits: true });
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setSavingId('');
    }
  }

  async function resetRow(row) {
    setSavingId(row.id);
    const draft = drafts[row.id] || makeDraft(row);
    try {
      if (draft.id) {
        await api.deleteStaffHourPolicy(draft.id);
        editedIds.current.delete(row.id);
        showToast('Staff hour policy removed.', 'success');
        await load({ preserveEdits: true });
        return;
      }
      editedIds.current.delete(row.id);
      setDrafts((current) => ({ ...current, [row.id]: makeDraft({ ...row, policy: null }) }));
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setSavingId(''); }
  }

  async function clearAll() {
    if (!window.confirm('Clear all staff hour policies?')) return;
    setBulkAction(true);
    try {
      await api.deleteAllStaffHourPolicies();
      showToast('All staff hour policies cleared.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally { setBulkAction(false); }
  }

  async function handleImport(event) {
    const input = event.target;
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const rows = readStaffHourPolicyWorkbook(workbook);
      const result = await api.importStaffHourPoliciesRows(rows);
      setImportResult(result);
      showToast(`Policies imported: ${result.imported || 0}, unchanged: ${result.unchanged || 0}, rejected: ${result.rejected || 0}.`, result.rejected ? 'warning' : 'success');
      await load();
    } catch (error) {
      if (error.payload) setImportResult(error.payload);
      showToast(error.message, 'error');
    } finally {
      setImporting(false);
      input.value = '';
    }
  }

  async function downloadTemplate() {
    try {
      const file = await api.downloadStaffHourPolicyTemplate();
      downloadFile(file.url, file.fileName || '');
      showToast('Staff hour policy template downloaded.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
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

  const busy = loading || importing || bulkAction || Boolean(savingId);
  const isDirty = (row) => JSON.stringify(drafts[row.id] || makeDraft(row)) !== JSON.stringify(makeDraft(row));
  const changedCount = data.rows.filter(isDirty).length;
  const visibleRows = data.rows.filter((row) => {
    if (roleFilter && row.role !== roleFilter) return false;
    if (search.trim() && !`${row.name} ${row.staffId} ${row.department || ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
    if (policyFilter === 'custom' && !row.policy) return false;
    if (policyFilter === 'default' && row.policy) return false;
    if (policyFilter === 'excluded' && !row.effectivePolicy?.excluded) return false;
    if (policyFilter === 'unsaved' && !isDirty(row)) return false;
    if (policyFilter === 'over' && !(row.effectivePolicy?.hasHardLimit && Number(row.currentAssignedHours || 0) > Number(row.effectivePolicy.hardLimitHours || 0))) return false;
    return true;
  });
  const selected = visibleRows.find((row) => row.id === selectedId) || visibleRows[0] || null;
  const selectedDraft = selected ? drafts[selected.id] || makeDraft(selected) : null;
  return <div className="page-grid rules-page staff-policy-page">
    <section className="rules-intro"><div><span className="rules-eyebrow">STAFF WORKLOAD</span><h2>Hour limits and staff preferences</h2><p>Find a staff member, review their workload, and edit their scheduling policy.</p></div><div className="action-row"><Link className="ghost-btn" to="/scheduling-rules">Scheduling priorities</Link><button type="button" className="ghost-btn" onClick={() => load({ preserveEdits: true })} disabled={busy}>Refresh</button></div></section>
    {loadError ? <p className="rules-feedback is-error" role="alert">Unable to refresh policies: {loadError}. Displayed data may be out of date.</p> : null}
    <section className="ops-metrics" aria-label="Staff policy summary">{[
      ['Staff members', summary.totalStaff, 'In the staff pool'],
      ['TA role average', `${formatHours(data.averagesByRole?.TA)}h`, 'Includes reserve requirements'],
      ['Doctor role average', `${formatHours(data.averagesByRole?.Doctor)}h`, 'Includes reserve requirements'],
      ['Saved policies', summary.customPolicies, `${summary.excluded} staff excluded`],
      ['Over hard limit', summary.overLimit, 'Based on saved assignments'],
      ['Unsaved edits', changedCount, 'Save each person separately'],
    ].map(([label, value, note]) => <div className="ops-metric" key={label}><span>{label}</span><strong>{loading ? '...' : value}</strong><small>{note}</small></div>)}</section>
    <details className="panel ops-tools"><summary>Imports, exports, and policy guidance</summary><div className="action-row"><button type="button" className="ghost-btn" onClick={exportPolicies} disabled={busy}>Export policies</button><button type="button" className="ghost-btn" onClick={downloadTemplate} disabled={busy}>Download template</button><label className={`ghost-btn ops-upload ${busy ? 'is-disabled' : ''}`}><span>{importing ? 'Importing...' : 'Import policies'}</span><input type="file" accept=".xlsx,.xls" onChange={handleImport} disabled={busy} aria-label="Import staff policies workbook" /></label><button type="button" className="ghost-btn ops-danger" onClick={clearAll} disabled={busy}>Clear all policies</button></div><p className="ops-help">Exact, add, and reduce policies set caps. Default mode uses the role average as a target. Saving a policy does not change current assignments; generate a new schedule to apply it.</p><div className="chips-wrap"><span className="ops-badge">TA required: {formatHours(data.totalRequiredHoursByRole?.TA)}h</span><span className="ops-badge">Doctor required: {formatHours(data.totalRequiredHoursByRole?.Doctor)}h</span><span className="ops-badge">Available staff: {data.availableStaffCountByRole?.TA || 0} TAs / {data.availableStaffCountByRole?.Doctor || 0} Doctors</span></div></details>
      {importResult ? (
        <section className="panel" aria-live="polite">
          <div className="panel-head">
            <div>
              <h2>Import Results</h2>
              <p>Created: {importResult.created || 0}. Updated: {importResult.updated || 0}. Unchanged: {importResult.unchanged || 0}. Rejected: {importResult.rejected || 0}.</p>
            </div>
          </div>
          {(importResult.errors || importResult.examples || []).length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Excel Row</th><th>StaffID</th><th>Reason</th></tr></thead>
                <tbody>{(importResult.errors || importResult.examples || []).map((error, index) => (
                  <tr key={index}><td>{error.row}</td><td>{error.staffId || '—'}</td><td>{error.error || error.reason || 'Invalid policy row'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

    <details className="panel ops-notices"><summary>Policy notices <span className="ops-badge">{data.warnings?.length || 0}</span></summary><div className="ops-notice-list">{(data.warnings || []).map((warning, index) => <p key={index}>{typeof warning === 'string' ? warning : `${warning.staffId || 'Staff'}: ${warning.message}`}</p>)}{!data.warnings?.length ? <p className="ops-help">{loading ? 'Loading notices...' : 'No policy notices.'}</p> : null}</div></details>
    <div className="policy-workspace">
      <section className="panel policy-directory"><div className="panel-head"><div><h2>Staff directory</h2><p>{visibleRows.length} of {data.rows.length} staff{changedCount ? ` / ${changedCount} unsaved` : ''}</p></div></div>
        <div className="form-grid ops-filters"><label><span>Find staff</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, staff ID, or department" /></label><label><span>Role</span><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="">All roles</option><option value="TA">TA</option><option value="Doctor">Doctor</option></select></label><label><span>Policy status</span><select value={policyFilter} onChange={(event) => setPolicyFilter(event.target.value)}><option value="">All staff</option><option value="custom">Saved policies</option><option value="default">No saved policy</option><option value="excluded">Excluded</option><option value="over">Over hard limit</option><option value="unsaved">Unsaved edits</option></select></label></div>
        <div className="table-wrap policy-directory-table"><table><thead><tr><th>Staff member</th><th>Assigned</th><th>Limit</th><th>Status</th><th /></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.id} className={selected?.id === row.id ? 'is-selected' : ''}><td><button type="button" className="ops-staff-select" onClick={() => setSelectedId(row.id)} aria-pressed={selected?.id === row.id}><strong dir="auto">{row.name}</strong><small>{row.staffId} / {row.role}</small></button></td><td>{formatHours(row.currentAssignedHours)}h<small className="ops-cell-note">{formatHours(row.onCallHours)}h on-call</small></td><td>{row.effectivePolicy?.hasHardLimit ? `${formatHours(row.effectivePolicy.hardLimitHours)}h` : 'No fixed cap'}</td><td><span className={`ops-badge ${isDirty(row) ? 'tone-warning' : row.effectivePolicy?.excluded ? 'tone-danger' : 'tone-neutral'}`}>{isDirty(row) ? 'Unsaved' : row.effectivePolicy?.excluded ? 'Excluded' : row.policy ? row.policy.mode : 'Default'}</span></td><td><button type="button" className="ghost-btn ops-edit-button" onClick={() => setSelectedId(row.id)} aria-label={`Edit policy for ${row.name}`}>{selected?.id === row.id ? 'Selected' : 'Edit'}</button></td></tr>)}</tbody></table>
          {!visibleRows.length ? <div className="empty-state">{loading ? 'Loading staff policies...' : data.rows.length ? 'No staff match these filters.' : 'Add staff to start setting policies.'}</div> : null}
        </div>
      </section>
      <StaffPolicyEditor row={selected} draft={selectedDraft} preview={selected ? previewPolicy(selected, selectedDraft) : null} dirty={selected ? isDirty(selected) : false} busy={busy} onChange={(field, value) => updateDraft(selected.id, field, value)} onSave={() => saveRow(selected)} onReset={() => resetRow(selected)} />
    </div>
  </div>;
}
