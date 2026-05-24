import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';

const defaultFilters = {
  startDate: '',
  endDate: '',
  role: 'All',
  department: '',
  day: '',
  staffId: '',
};

const emptyReports = {
  summary: { cards: {} },
  workload: { summary: {}, rows: [] },
  fairness: { ta: {}, doctor: {} },
  dailyCoverage: { rows: [] },
  roomShortage: { summary: {}, rows: [] },
  onCall: { periods: [], assignments: [], config: {} },
  detailedLoad: { summary: {}, rows: [] },
  conflicts: { rows: [] },
  sessionCoverage: { rows: [] },
  utilization: { rows: [] },
  quality: { breakdown: {} },
  staffReport: null,
};

const initialSectionLoading = {
  summary: true,
  workload: true,
  fairness: true,
  dailyCoverage: true,
  roomShortage: true,
  onCall: true,
  detailedLoad: true,
  conflicts: true,
  sessionCoverage: true,
  utilization: true,
  quality: true,
  staffReport: false,
};

function downloadCsv(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => JSON.stringify(row[header] ?? '')).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadWorkbook(filename, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(sheet.rows.length ? sheet.rows : [{ Notice: 'No data' }]),
      sheet.name
    );
  });
  XLSX.writeFile(workbook, filename);
}

function scoreTone(score) {
  if (score >= 85) return 'success';
  if (score >= 65) return 'warning';
  return 'danger';
}

export default function ReportsPage() {
  const [filters, setFilters] = useState(defaultFilters);
  const [invigilators, setInvigilators] = useState([]);
  const [reports, setReports] = useState(emptyReports);
  const [sectionLoading, setSectionLoading] = useState(initialSectionLoading);
  const [sectionErrors, setSectionErrors] = useState({});
  const showToast = useToast();

  useEffect(() => {
    api.getInvigilators()
      .then(setInvigilators)
      .catch((error) => showToast(error.message, 'error'));
  }, []);

  useEffect(() => {
    let active = true;

    async function loadReports() {
      setSectionLoading({
        summary: true,
        workload: true,
        fairness: true,
        dailyCoverage: true,
        roomShortage: true,
        onCall: true,
        detailedLoad: true,
        conflicts: true,
        sessionCoverage: true,
        utilization: true,
        quality: true,
        staffReport: Boolean(filters.staffId),
      });
      setSectionErrors({});

      if (!filters.staffId) {
        setReports((current) => ({ ...current, staffReport: null }));
      }

      try {
        const summary = await api.getReportsSummary(filters);
        if (!active) return;
        setReports((current) => ({ ...current, summary }));
      } catch (error) {
        if (!active) return;
        setSectionErrors((current) => ({ ...current, summary: error.message }));
        showToast(error.message, 'error');
      } finally {
        if (active) {
          setSectionLoading((current) => ({ ...current, summary: false }));
        }
      }

      const detailRequests = [
        ['workload', () => api.getReportsWorkload(filters)],
        ['fairness', () => api.getReportsFairness(filters)],
        ['dailyCoverage', () => api.getReportsDailyCoverage(filters)],
        ['roomShortage', () => api.getReportsRoomShortage(filters)],
        ['onCall', () => api.getOnCall()],
        ['detailedLoad', () => api.getReportsDetailedLoad(filters)],
        ['conflicts', () => api.getReportsConflicts(filters)],
        ['sessionCoverage', () => api.getReportsSessionCoverage(filters)],
        ['utilization', () => api.getReportsUtilization(filters)],
        ['quality', () => api.getReportsQualityScore(filters)],
      ];

      if (filters.staffId) {
        detailRequests.push(['staffReport', () => api.getReportsStaff(filters.staffId, filters)]);
      }

      detailRequests.forEach(([key, loader]) => {
        loader()
          .then((value) => {
            if (!active) return;
            setReports((current) => ({ ...current, [key]: value }));
          })
          .catch((error) => {
            if (!active) return;
            setSectionErrors((current) => ({ ...current, [key]: error.message }));
            showToast(error.message, 'error');
          })
          .finally(() => {
            if (!active) return;
            setSectionLoading((current) => ({ ...current, [key]: false }));
          });
      });
    }

    loadReports();
    return () => {
      active = false;
    };
  }, [filters]);

  const departments = useMemo(
    () => [...new Set(invigilators.map((item) => item.department).filter(Boolean))].sort(),
    [invigilators]
  );

  function updateFilter(event) {
    const { name, value } = event.target;
    setFilters((current) => ({ ...current, [name]: value }));
  }

  function clearFilters() {
    setFilters(defaultFilters);
  }

  function exportReportExcel(name, rows) {
    downloadWorkbook(`${name}.xlsx`, [{ name: 'Report', rows }]);
    showToast('Report exported to Excel.', 'success');
  }

  function exportReportCsv(name, rows) {
    downloadCsv(`${name}.csv`, rows);
    showToast('Report exported to CSV.', 'success');
  }

  function exportFullWorkbook() {
    const scheduleLoadRows = reports.workload.rows.map((row) => ({
      StaffID: row.staffId,
      Name: row.name,
      Role: row.role,
      Department: row.department,
      SessionCount: row.sessionCount,
      SessionHours: row.sessionHours,
      AssignedHours: row.assignedHours,
      RoleAverageHours: row.roleAverageHours,
      EffectiveAllowedHours: row.effectiveAllowedHours,
      PolicyMode: row.policyMode,
      PolicyStatus: row.policyStatus,
    }));
    const superLoadRows = reports.workload.rows
      .filter((row) => Number(row.superCount || 0) > 0 || Number(row.superHours || 0) > 0)
      .map((row) => ({
        StaffID: row.staffId,
        Name: row.name,
        Role: row.role,
        SuperCount: row.superCount,
        SuperHours: row.superHours,
        AssignedHours: row.assignedHours,
      }));
    const controlLoadRows = reports.workload.rows
      .filter((row) => Number(row.controlCount || 0) > 0 || Number(row.controlHours || 0) > 0)
      .map((row) => ({
        StaffID: row.staffId,
        Name: row.name,
        Role: row.role,
        ControlCount: row.controlCount,
        ControlHours: row.controlHours,
        AssignedHours: row.assignedHours,
      }));
    downloadWorkbook('reports_workbook.xlsx', [
      { name: 'Summary', rows: [reports.summary.cards] },
      { name: 'Workload', rows: reports.workload.rows },
      { name: 'ScheduleLoad', rows: scheduleLoadRows },
      { name: 'SuperLoad', rows: superLoadRows },
      { name: 'ControlLoad', rows: controlLoadRows },
      { name: 'DetailedLoad', rows: reports.detailedLoad.rows },
      { name: 'Fairness', rows: [{ Role: 'TA', ...reports.fairness.ta }, { Role: 'Doctor', ...reports.fairness.doctor }] },
      { name: 'DailyCoverage', rows: reports.dailyCoverage.rows },
      { name: 'RoomShortage', rows: reports.roomShortage.rows },
      { name: 'Conflicts', rows: reports.conflicts.rows },
      { name: 'SessionCoverage', rows: reports.sessionCoverage.rows },
      { name: 'Utilization', rows: reports.utilization.rows },
        { name: 'Quality', rows: [reports.quality.breakdown] },
        { name: 'StaffReport', rows: reports.staffReport?.sessions || [] },
      ]);
    showToast('Reports workbook exported with schedule, super, control, detailed load, and room shortage.', 'success');
  }

  function exportOperationalWorkbook() {
    const scheduleLoadRows = reports.workload.rows.map((row) => ({
      StaffID: row.staffId,
      Name: row.name,
      Role: row.role,
      Department: row.department,
      SessionCount: row.sessionCount,
      SessionHours: row.sessionHours,
      AssignedHours: row.assignedHours,
      RoleAverageHours: row.roleAverageHours,
      EffectiveAllowedHours: row.effectiveAllowedHours,
      PolicyMode: row.policyMode,
      PolicyStatus: row.policyStatus,
    }));
    const superLoadRows = reports.workload.rows
      .filter((row) => Number(row.superCount || 0) > 0 || Number(row.superHours || 0) > 0)
      .map((row) => ({
        StaffID: row.staffId,
        Name: row.name,
        Role: row.role,
        SuperCount: row.superCount,
        SuperHours: row.superHours,
        AssignedHours: row.assignedHours,
      }));
    const controlLoadRows = reports.workload.rows
      .filter((row) => Number(row.controlCount || 0) > 0 || Number(row.controlHours || 0) > 0)
      .map((row) => ({
        StaffID: row.staffId,
        Name: row.name,
        Role: row.role,
        ControlCount: row.controlCount,
        ControlHours: row.controlHours,
        AssignedHours: row.assignedHours,
      }));
    const onCallLoadRows = reports.workload.rows
      .filter((row) => Number(row.onCallCount || 0) > 0 || Number(row.onCallHours || 0) > 0)
      .map((row) => ({
        StaffID: row.staffId,
        Name: row.name,
        Role: row.role,
        OnCallCount: row.onCallCount,
        OnCallHours: row.onCallHours,
        AssignedHours: row.assignedHours,
      }));
    const onCallShortageRows = (reports.onCall.periods || [])
      .filter((row) => Number(row.onCallTARemaining || 0) > 0 || Number(row.onCallDoctorRemaining || 0) > 0)
      .map((row) => ({
        Date: row.date,
        Start: row.startTime,
        End: row.endTime,
        ActiveRooms: row.activeRoomCount,
        Rooms: Array.isArray(row.rooms) ? row.rooms.join('; ') : '',
        TANeeded: row.onCallTANeeded,
        DoctorNeeded: row.onCallDoctorNeeded,
        TAAssigned: row.assignedTACount,
        DoctorAssigned: row.assignedDoctorCount,
        TARemaining: row.onCallTARemaining,
        DoctorRemaining: row.onCallDoctorRemaining,
        TotalRemaining: Number(row.onCallTARemaining || 0) + Number(row.onCallDoctorRemaining || 0),
      }));
    downloadWorkbook('reports_operational_workbook.xlsx', [
      { name: 'Summary', rows: [reports.summary.cards] },
      { name: 'Workload', rows: reports.workload.rows },
      { name: 'ScheduleLoad', rows: scheduleLoadRows },
      { name: 'SuperLoad', rows: superLoadRows },
      { name: 'ControlLoad', rows: controlLoadRows },
      { name: 'OnCallLoad', rows: onCallLoadRows },
      { name: 'OnCallShortage', rows: onCallShortageRows },
      { name: 'DetailedLoad', rows: reports.detailedLoad.rows },
      { name: 'RoomShortage', rows: reports.roomShortage.rows },
    ]);
    showToast('Operational reports workbook exported with workload, on-call load, and on-call shortage.', 'success');
  }

  function renderSectionStatus(key) {
    if (sectionErrors[key]) {
      return <span className="report-badge danger">Error</span>;
    }
    if (sectionLoading[key]) {
      return <span className="report-badge warning">Loading...</span>;
    }
    return null;
  }

  const topCards = [
    { label: 'Staff', value: reports.summary.cards.totalStaff || 0, tone: 'blue' },
    { label: 'Assigned Hours', value: reports.summary.cards.totalAssignedHours || 0, tone: 'purple' },
    { label: 'Session Duties', value: reports.summary.cards.sessionAssignments || 0, tone: 'blue' },
    { label: 'Session Hours', value: reports.summary.cards.sessionHours || 0, tone: 'blue' },
    { label: 'Avg Hours', value: reports.summary.cards.averageAssignedHours || 0, tone: 'success' },
    { label: 'TA Avg H', value: reports.summary.cards.taAverageHours || 0, tone: 'blue' },
    { label: 'Doctor Avg H', value: reports.summary.cards.doctorAverageHours || 0, tone: 'purple' },
    { label: 'Super Duties', value: reports.summary.cards.superAssignments || 0, tone: 'success' },
    { label: 'Super Hours', value: reports.summary.cards.superHours || 0, tone: 'success' },
    { label: 'Control Duties', value: reports.summary.cards.controlAssignments || 0, tone: 'warning' },
    { label: 'Control Hours', value: reports.summary.cards.controlHours || 0, tone: 'warning' },
    { label: 'On-Call Count', value: reports.summary.cards.onCallAssignments || 0, tone: 'blue' },
    { label: 'On-Call Hours', value: reports.summary.cards.onCallHours || 0, tone: 'purple' },
    { label: 'On-Call Shortage', value: reports.summary.cards.onCallShortage || 0, tone: 'danger' },
    { label: 'Rooms With Shortage', value: reports.summary.cards.roomsWithShortage || 0, tone: 'danger' },
    { label: 'Room Shortage Total', value: reports.summary.cards.roomShortageTotal || 0, tone: 'danger' },
    { label: 'Over Policy', value: reports.summary.cards.overPolicyCount || 0, tone: 'danger' },
    { label: 'Under Target', value: reports.summary.cards.underTargetCount || 0, tone: 'warning' },
    { label: 'Excluded Staff', value: reports.summary.cards.excludedStaffCount || 0, tone: 'danger' },
    { label: 'Conflicts', value: reports.summary.cards.conflictCount || 0, tone: 'danger' },
    { label: 'Quality Score', value: reports.summary.cards.qualityScore || 0, tone: scoreTone(reports.summary.cards.qualityScore || 0) },
    { label: 'Fully Covered', value: reports.summary.cards.fullyCoveredSessions || 0, tone: 'warning' },
  ];

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Reporting Center</h2>
            <p>Evaluate workload fairness, coverage quality, conflicts, and operational readiness.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={clearFilters}>Clear Filters</button>
          </div>
        </div>

        <div className="form-grid">
          <label>
            <span>Start Date</span>
            <input type="date" name="startDate" value={filters.startDate} onChange={updateFilter} />
          </label>
          <label>
            <span>End Date</span>
            <input type="date" name="endDate" value={filters.endDate} onChange={updateFilter} />
          </label>
          <label>
            <span>Role</span>
            <select name="role" value={filters.role} onChange={updateFilter}>
              <option value="All">All</option>
              <option value="TA">TA</option>
              <option value="Doctor">Doctor</option>
            </select>
          </label>
          <label>
            <span>Department</span>
            <select name="department" value={filters.department} onChange={updateFilter}>
              <option value="">All Departments</option>
              {departments.map((department) => (
                <option key={department} value={department}>{department}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Specific Day</span>
            <input type="date" name="day" value={filters.day} onChange={updateFilter} />
          </label>
          <label>
            <span>Staff Member</span>
            <select name="staffId" value={filters.staffId} onChange={updateFilter}>
              <option value="">All Staff</option>
              {invigilators.map((person) => (
                <option key={person.id} value={person.id}>{person.name} ({person.role})</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Export Center</h2>
            <p>All report exports are grouped here for faster review and cleaner navigation.</p>
          </div>
        </div>
        <div className="report-export-grid">
          <div className="duty-column">
            <h4>Workbook Exports</h4>
            <div className="action-row">
              <button type="button" className="ghost-btn" onClick={exportOperationalWorkbook}>Operational Workbook</button>
              <button type="button" className="primary-btn" onClick={exportFullWorkbook}>Full Reports Workbook</button>
            </div>
          </div>
          <div className="duty-column">
            <h4>Excel Exports</h4>
            <div className="action-row">
              <button type="button" className="ghost-btn" onClick={() => exportReportExcel('workload_report', reports.workload.rows)}>Workload</button>
              <button type="button" className="ghost-btn" onClick={() => exportReportExcel('detailed_load_report', reports.detailedLoad.rows)}>Detailed Load</button>
              <button type="button" className="ghost-btn" onClick={() => exportReportExcel('room_shortage_report', reports.roomShortage.rows)}>Room Shortage</button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => exportReportExcel('fairness_report', [{ Role: 'TA', ...reports.fairness.ta }, { Role: 'Doctor', ...reports.fairness.doctor }])}
              >
                Fairness
              </button>
              <button type="button" className="ghost-btn" onClick={() => exportReportExcel('daily_coverage_report', reports.dailyCoverage.rows)}>Daily Coverage</button>
              <button type="button" className="ghost-btn" onClick={() => exportReportExcel('conflict_report', reports.conflicts.rows)}>Conflicts</button>
              <button type="button" className="ghost-btn" onClick={() => exportReportExcel('session_coverage_report', reports.sessionCoverage.rows)}>Session Coverage</button>
              <button type="button" className="ghost-btn" onClick={() => exportReportExcel('utilization_report', reports.utilization.rows)}>Utilization</button>
              {reports.staffReport?.person ? (
                <button type="button" className="ghost-btn" onClick={() => exportReportExcel('staff_report', reports.staffReport.sessions)}>Staff Report</button>
              ) : null}
            </div>
          </div>
          <div className="duty-column">
            <h4>CSV Exports</h4>
            <div className="action-row">
              <button type="button" className="ghost-btn" onClick={() => exportReportCsv('workload_report', reports.workload.rows)}>Workload</button>
              <button type="button" className="ghost-btn" onClick={() => exportReportCsv('daily_coverage_report', reports.dailyCoverage.rows)}>Daily Coverage</button>
              <button type="button" className="ghost-btn" onClick={() => exportReportCsv('room_shortage_report', reports.roomShortage.rows)}>Room Shortage</button>
              <button type="button" className="ghost-btn" onClick={() => exportReportCsv('session_coverage_report', reports.sessionCoverage.rows)}>Session Coverage</button>
            </div>
          </div>
        </div>
        <div className="chips-wrap">
          <div className="info-chip"><strong>Workload Rows</strong><span>{reports.workload.rows.length}</span></div>
          <div className="info-chip"><strong>On-Call Shortage Rows</strong><span>{(reports.onCall.periods || []).filter((row) => Number(row.onCallTARemaining || 0) + Number(row.onCallDoctorRemaining || 0) > 0).length}</span></div>
          <div className="info-chip"><strong>Detailed Load Rows</strong><span>{reports.detailedLoad.rows.length}</span></div>
          <div className="info-chip"><strong>Room Shortage Rows</strong><span>{reports.roomShortage.rows.length}</span></div>
          <div className="info-chip"><strong>Conflict Rows</strong><span>{reports.conflicts.rows.length}</span></div>
          <div className="info-chip"><strong>Session Coverage Rows</strong><span>{reports.sessionCoverage.rows.length}</span></div>
        </div>
      </section>

      <section className="panel">
        <div className="summary-grid">
          {topCards.map((card) => (
            <div className={`summary-card ${card.tone}`} key={card.label}>
              <div className="summary-card-value">{sectionLoading.summary ? '...' : card.value}</div>
              <div className="summary-card-label">{card.label}</div>
            </div>
          ))}
        </div>
        {sectionErrors.summary ? <div className="empty-state">Summary failed to load: {sectionErrors.summary}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Detailed Load Report</h2>
            <p>All duties in one timeline, including schedule, super invigilator, control, and on-call load.</p>
          </div>
          <div className="action-row">{renderSectionStatus('detailedLoad')}</div>
        </div>
        <div className="chips-wrap">
          <div className="info-chip"><strong>Total Duties</strong><span>{reports.detailedLoad.summary.totalDuties || 0}</span></div>
          <div className="info-chip"><strong>Session Duties</strong><span>{reports.detailedLoad.summary.sessionDuties || 0}</span></div>
          <div className="info-chip"><strong>Super Duties</strong><span>{reports.detailedLoad.summary.superDuties || 0}</span></div>
          <div className="info-chip"><strong>Control Duties</strong><span>{reports.detailedLoad.summary.controlDuties || 0}</span></div>
          <div className="info-chip"><strong>On-Call Duties</strong><span>{reports.detailedLoad.summary.onCallDuties || 0}</span></div>
          <div className="info-chip"><strong>Total Hours</strong><span>{reports.detailedLoad.summary.totalHours || 0}</span></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Duty Type</th>
                <th>Staff ID</th>
                <th>Name</th>
                <th>Role</th>
                <th>Date</th>
                <th>Start</th>
                <th>End</th>
                <th>Hours</th>
                <th>Course Code</th>
                <th>Room</th>
                <th>Label</th>
              </tr>
            </thead>
            <tbody>
              {reports.detailedLoad.rows.map((row, index) => (
                <tr key={`${row.DutyType}_${row.StaffID}_${row.Date}_${row.Start}_${index}`}>
                  <td>{row.DutyType}</td>
                  <td>{row.StaffID}</td>
                  <td>{row.StaffName}</td>
                  <td>{row.Role}</td>
                  <td>{row.Date}</td>
                  <td>{row.Start}</td>
                  <td>{row.End}</td>
                  <td>{row.DurationHours}</td>
                  <td>{row.CourseCode}</td>
                  <td>{row.Room}</td>
                  <td>{row.Label}</td>
                </tr>
              ))}
              {!reports.detailedLoad.rows.length ? <tr><td colSpan="11" className="empty-cell">{sectionLoading.detailedLoad ? 'Loading detailed load...' : 'No detailed load data for the current filters.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {sectionErrors.detailedLoad ? <div className="empty-state">Detailed load failed to load: {sectionErrors.detailedLoad}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Workload Report</h2>
            <p>Assigned load, remaining capacity, and utilization for each staff member.</p>
          </div>
          <div className="action-row">{renderSectionStatus('workload')}</div>
        </div>
          <div className="chips-wrap">
            <div className="info-chip"><strong>Total Staff</strong><span>{reports.workload.summary.totalStaff || 0}</span></div>
            <div className="info-chip"><strong>Total Assigned H</strong><span>{reports.workload.summary.totalAssignedHours || 0}</span></div>
            <div className="info-chip"><strong>Avg Assigned H</strong><span>{reports.workload.summary.averageAssignedHours || 0}</span></div>
            <div className="info-chip"><strong>TA Avg H</strong><span>{reports.workload.summary.taAverageHours || 0}</span></div>
            <div className="info-chip"><strong>Doctor Avg H</strong><span>{reports.workload.summary.doctorAverageHours || 0}</span></div>
            <div className="info-chip"><strong>Max H</strong><span>{reports.workload.summary.maxAssignedHours || 0}</span></div>
            <div className="info-chip"><strong>Min H</strong><span>{reports.workload.summary.minAssignedHours || 0}</span></div>
            <div className="info-chip"><strong>Session Duties</strong><span>{reports.workload.summary.sessionAssignments || 0}</span></div>
            <div className="info-chip"><strong>Super Duties</strong><span>{reports.workload.summary.superAssignments || 0}</span></div>
            <div className="info-chip"><strong>Control Duties</strong><span>{reports.workload.summary.controlAssignments || 0}</span></div>
            <div className="info-chip"><strong>Super H</strong><span>{reports.workload.summary.superHours || 0}</span></div>
            <div className="info-chip"><strong>Control H</strong><span>{reports.workload.summary.controlHours || 0}</span></div>
            <div className="info-chip"><strong>Over Policy</strong><span>{reports.workload.summary.overPolicyCount || 0}</span></div>
            <div className="info-chip"><strong>Under Target</strong><span>{reports.workload.summary.underTargetCount || 0}</span></div>
          </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Staff ID</th>
                <th>Name</th>
                <th>Role</th>
                <th>Department</th>
                <th>Max H</th>
                <th>Assigned H</th>
                <th>Remaining H</th>
                <th>Assigned Sessions</th>
                <th>On-Call Count</th>
                <th>On-Call H</th>
                <th>Role Avg H</th>
                <th>Allowed H</th>
                <th>Diff Target H</th>
                <th>Policy Mode</th>
                <th>Policy Status</th>
                <th>Utilization %</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reports.workload.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.staffId}</td>
                  <td>{row.name}</td>
                  <td>{row.role}</td>
                  <td>{row.department || '-'}</td>
                  <td>{row.maxHours}</td>
                  <td>{row.assignedHours}</td>
                  <td>{row.remainingHours}</td>
                  <td>{row.assignedSessions}</td>
                  <td>{row.onCallCount || 0}</td>
                  <td>{row.onCallHours || 0}</td>
                  <td>{row.roleAverageHours || 0}</td>
                  <td>{row.effectiveAllowedHours || 0}</td>
                  <td>{row.differenceFromTargetHours || 0}</td>
                  <td>{row.policyMode || 'default'}</td>
                  <td>{row.policyStatus || 'default'}</td>
                  <td>{row.utilizationPercent}%</td>
                  <td><span className={`report-badge ${row.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.status}</span></td>
                </tr>
              ))}
              {!reports.workload.rows.length ? <tr><td colSpan="17" className="empty-cell">{sectionLoading.workload ? 'Loading workload...' : 'No workload data for the current filters.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {sectionErrors.workload ? <div className="empty-state">Workload failed to load: {sectionErrors.workload}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Fairness Report</h2>
            <p>Separate fairness analysis for TAs and Doctors based on workload spread and standard deviation.</p>
          </div>
          <div className="action-row">{renderSectionStatus('fairness')}</div>
        </div>
        <div className="duo-grid">
          {['ta', 'doctor'].map((key) => {
            const entry = reports.fairness[key] || {};
            return (
              <div className="duty-column" key={key}>
                <h4>{key === 'ta' ? 'TA Fairness' : 'Doctor Fairness'}</h4>
                <div className="report-score-row">
                  <strong>{entry.fairnessScore ?? 0}/100</strong>
                  <div className="report-progress">
                    <span style={{ width: `${entry.fairnessScore ?? 0}%` }} />
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      <tr><td>Average Hours</td><td>{entry.averageAssignedHours ?? 0}</td></tr>
                      <tr><td>Max Hours</td><td>{entry.maxAssignedHours ?? 0}</td></tr>
                      <tr><td>Min Hours</td><td>{entry.minAssignedHours ?? 0}</td></tr>
                      <tr><td>Gap</td><td>{entry.maxMinGap ?? 0}</td></tr>
                      <tr><td>Variance</td><td>{entry.variance ?? 0}</td></tr>
                      <tr><td>Std Dev</td><td>{entry.standardDeviation ?? 0}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
        {sectionErrors.fairness ? <div className="empty-state">Fairness failed to load: {sectionErrors.fairness}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Daily Coverage Report</h2>
            <p>Required versus assigned staffing for each exam day.</p>
          </div>
          <div className="action-row">{renderSectionStatus('dailyCoverage')}</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Total Sessions</th>
                <th>TA Required</th>
                <th>Doctor Required</th>
                <th>TA Assigned</th>
                <th>Doctor Assigned</th>
                <th>TA Gaps</th>
                <th>Doctor Gaps</th>
                <th>Coverage %</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reports.dailyCoverage.rows.map((row) => (
                <tr key={row.date}>
                  <td>{row.date}</td>
                  <td>{row.totalSessions}</td>
                  <td>{row.taRequired}</td>
                  <td>{row.doctorRequired}</td>
                  <td>{row.taAssigned}</td>
                  <td>{row.doctorAssigned}</td>
                  <td>{row.taGaps}</td>
                  <td>{row.doctorGaps}</td>
                  <td>{row.coveragePercent}%</td>
                  <td><span className={`report-badge ${row.status.toLowerCase()}`}>{row.status}</span></td>
                </tr>
              ))}
              {!reports.dailyCoverage.rows.length ? <tr><td colSpan="10" className="empty-cell">{sectionLoading.dailyCoverage ? 'Loading daily coverage...' : 'No daily coverage data for the current filters.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {sectionErrors.dailyCoverage ? <div className="empty-state">Daily coverage failed to load: {sectionErrors.dailyCoverage}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Room Shortage Report</h2>
            <p>Shortage totals grouped by room, date, and time across the filtered sessions.</p>
          </div>
          <div className="action-row">{renderSectionStatus('roomShortage')}</div>
        </div>
        <div className="chips-wrap">
          <div className="info-chip"><strong>Total Rooms</strong><span>{reports.roomShortage.summary.totalRooms || 0}</span></div>
          <div className="info-chip"><strong>Room Periods</strong><span>{reports.roomShortage.summary.totalRoomPeriods || 0}</span></div>
          <div className="info-chip"><strong>Rooms With Shortage</strong><span>{reports.roomShortage.summary.roomsWithShortage || 0}</span></div>
          <div className="info-chip"><strong>Shortage Periods</strong><span>{reports.roomShortage.summary.roomPeriodsWithShortage || 0}</span></div>
          <div className="info-chip"><strong>TA Shortage</strong><span>{reports.roomShortage.summary.totalTAShortage || 0}</span></div>
          <div className="info-chip"><strong>Doctor Shortage</strong><span>{reports.roomShortage.summary.totalDoctorShortage || 0}</span></div>
          <div className="info-chip"><strong>Total Shortage</strong><span>{reports.roomShortage.summary.totalShortage || 0}</span></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Date</th>
                <th>Start</th>
                <th>End</th>
                <th>Total Sessions</th>
                <th>TA Needed</th>
                <th>Doctor Needed</th>
                <th>TA Assigned</th>
                <th>Doctor Assigned</th>
                <th>TA Shortage</th>
                <th>Doctor Shortage</th>
                <th>Total Shortage</th>
                <th>Coverage %</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reports.roomShortage.rows.map((row) => (
                <tr key={`${row.room}_${row.date}_${row.startTime}_${row.endTime}`}>
                  <td>{row.room}</td>
                  <td>{row.date}</td>
                  <td>{row.startTime}</td>
                  <td>{row.endTime}</td>
                  <td>{row.totalSessions}</td>
                  <td>{row.taNeeded}</td>
                  <td>{row.doctorNeeded}</td>
                  <td>{row.taAssigned}</td>
                  <td>{row.doctorAssigned}</td>
                  <td>{row.taShortage}</td>
                  <td>{row.doctorShortage}</td>
                  <td>{row.totalShortage}</td>
                  <td>{row.coveragePercent}%</td>
                  <td><span className={`report-badge ${row.status.toLowerCase()}`}>{row.status}</span></td>
                </tr>
              ))}
              {!reports.roomShortage.rows.length ? <tr><td colSpan="14" className="empty-cell">{sectionLoading.roomShortage ? 'Loading room shortage...' : 'No room shortage data for the current filters.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {sectionErrors.roomShortage ? <div className="empty-state">Room shortage failed to load: {sectionErrors.roomShortage}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Conflict Report</h2>
            <p>Overlap, engagement, max-hours, and duplicate assignment checks.</p>
          </div>
          <div className="action-row">{renderSectionStatus('conflicts')}</div>
        </div>
        {reports.conflicts.rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Staff ID</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Related Session(s)</th>
                  <th>Date</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {reports.conflicts.rows.map((row, index) => (
                  <tr key={`${row.type}_${index}`}>
                    <td>{row.type}</td>
                    <td>{row.staffId}</td>
                    <td>{row.staffName}</td>
                    <td>{row.role}</td>
                    <td>{row.relatedSessions}</td>
                    <td>{row.date || '-'}</td>
                    <td>{row.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">{sectionLoading.conflicts ? 'Loading conflicts...' : 'No conflicts found.'}</div>
        )}
        {sectionErrors.conflicts ? <div className="empty-state">Conflicts failed to load: {sectionErrors.conflicts}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Staff Individual Report</h2>
            <p>Select a staff member in the filters to inspect their assignment history.</p>
          </div>
          {reports.staffReport?.person ? (
            <div className="action-row">{renderSectionStatus('staffReport')}</div>
          ) : (
            <div className="action-row">
              {renderSectionStatus('staffReport')}
            </div>
          )}
        </div>
        {reports.staffReport?.person ? (
          <>
            <div className="chips-wrap">
              <div className="info-chip"><strong>{reports.staffReport.person.name}</strong><span>{reports.staffReport.person.role}</span></div>
              <div className="info-chip"><strong>Total H</strong><span>{reports.staffReport.summary.totalAssignedHours}</span></div>
              <div className="info-chip"><strong>Utilization</strong><span>{reports.staffReport.summary.utilizationPercent}%</span></div>
              <div className="info-chip"><strong>Worked Days</strong><span>{reports.staffReport.summary.workedDaysCount}</span></div>
              <div className="info-chip"><strong>Assigned Sessions</strong><span>{reports.staffReport.summary.assignedSessionsCount}</span></div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Room</th>
                    <th>Course Code / Duty</th>
                    <th>Role</th>
                    <th>Duty Type</th>
                    <th>Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.staffReport.sessions.map((row, index) => (
                    <tr key={`${row.date}_${row.startTime}_${index}`}>
                      <td>{row.date}</td>
                      <td>{row.startTime} - {row.endTime}</td>
                      <td>{row.room || '-'}</td>
                      <td>{row.course}</td>
                      <td>{row.role}</td>
                      <td>{row.dutyType}</td>
                      <td>{row.durationHours}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-state">
            {filters.staffId
              ? (sectionLoading.staffReport ? 'Loading staff report...' : (sectionErrors.staffReport ? `Staff report failed to load: ${sectionErrors.staffReport}` : 'No staff report available.'))
              : 'Select a staff member to view the individual report.'}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Session Coverage Report</h2>
            <p>Coverage quality at session level.</p>
          </div>
          <div className="action-row">{renderSectionStatus('sessionCoverage')}</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Course Code(s)</th>
                <th>Room</th>
                <th>Date</th>
                <th>Start</th>
                <th>End</th>
                <th>TA Needed</th>
                <th>Doctor Needed</th>
                <th>TA Assigned</th>
                <th>Doctor Assigned</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reports.sessionCoverage.rows.map((row) => (
                <tr key={row.sessionId}>
                  <td>{row.course || '-'}</td>
                  <td>{row.room || '-'}</td>
                  <td>{row.date}</td>
                  <td>{row.startTime}</td>
                  <td>{row.endTime}</td>
                  <td>{row.taNeeded}</td>
                  <td>{row.doctorNeeded}</td>
                  <td>{row.taAssigned}</td>
                  <td>{row.doctorAssigned}</td>
                  <td><span className={`report-badge ${row.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.status}</span></td>
                </tr>
              ))}
              {!reports.sessionCoverage.rows.length ? <tr><td colSpan="10" className="empty-cell">{sectionLoading.sessionCoverage ? 'Loading session coverage...' : 'No session coverage data for the current filters.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {sectionErrors.sessionCoverage ? <div className="empty-state">Session coverage failed to load: {sectionErrors.sessionCoverage}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Utilization Report</h2>
            <p>Capacity usage by utilization band.</p>
          </div>
          <div className="action-row">{renderSectionStatus('utilization')}</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Staff ID</th>
                <th>Name</th>
                <th>Role</th>
                <th>Assigned / Max</th>
                <th>Utilization %</th>
                <th>Band</th>
              </tr>
            </thead>
            <tbody>
              {reports.utilization.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.staffId}</td>
                  <td>{row.name}</td>
                  <td>{row.role}</td>
                  <td>{row.assignedHours} / {row.maxHours}</td>
                  <td>{row.utilizationPercent}%</td>
                  <td><span className={`report-badge ${row.band.toLowerCase().replace(/\s+/g, '-')}`}>{row.band}</span></td>
                </tr>
              ))}
              {!reports.utilization.rows.length ? <tr><td colSpan="6" className="empty-cell">{sectionLoading.utilization ? 'Loading utilization...' : 'No utilization data for the current filters.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {sectionErrors.utilization ? <div className="empty-state">Utilization failed to load: {sectionErrors.utilization}</div> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Schedule Quality Score</h2>
            <p>Coverage, fairness, conflict, and overload combined into one readiness score.</p>
          </div>
          <div className="action-row">
            {renderSectionStatus('quality')}
          </div>
        </div>
        <div className="report-quality-grid">
          <div className="summary-card blue">
            <div className="summary-card-value">{reports.quality.breakdown.finalScore || 0}</div>
            <div className="summary-card-label">Final Score</div>
          </div>
          <div className="duty-column">
            <div className="report-score-row">
              <span>Coverage Score</span>
              <strong>{reports.quality.breakdown.coverageScore || 0}</strong>
            </div>
            <div className="report-score-row">
              <span>Fairness Score</span>
              <strong>{reports.quality.breakdown.fairnessScore || 0}</strong>
            </div>
            <div className="report-score-row">
              <span>Conflict Penalty</span>
              <strong>{reports.quality.breakdown.conflictPenalty || 0}</strong>
            </div>
            <div className="report-score-row">
              <span>Overload Penalty</span>
              <strong>{reports.quality.breakdown.overloadPenalty || 0}</strong>
            </div>
          </div>
        </div>
        {sectionErrors.quality ? <div className="empty-state">Quality score failed to load: {sectionErrors.quality}</div> : null}
      </section>
    </div>
  );
}
