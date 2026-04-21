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
  const [reports, setReports] = useState({
    summary: { cards: {} },
    workload: { summary: {}, rows: [] },
    fairness: { ta: {}, doctor: {} },
    dailyCoverage: { rows: [] },
    conflicts: { rows: [] },
    sessionCoverage: { rows: [] },
    utilization: { rows: [] },
    quality: { breakdown: {} },
    staffReport: null,
  });
  const showToast = useToast();

  useEffect(() => {
    api.getInvigilators()
      .then(setInvigilators)
      .catch((error) => showToast(error.message, 'error'));
  }, []);

  useEffect(() => {
    Promise.all([
      api.getReportsSummary(filters),
      api.getReportsWorkload(filters),
      api.getReportsFairness(filters),
      api.getReportsDailyCoverage(filters),
      api.getReportsConflicts(filters),
      api.getReportsSessionCoverage(filters),
      api.getReportsUtilization(filters),
      api.getReportsQualityScore(filters),
      filters.staffId ? api.getReportsStaff(filters.staffId, filters) : Promise.resolve(null),
    ])
      .then(([summary, workload, fairness, dailyCoverage, conflicts, sessionCoverage, utilization, quality, staffReport]) => {
        setReports({ summary, workload, fairness, dailyCoverage, conflicts, sessionCoverage, utilization, quality, staffReport });
      })
      .catch((error) => showToast(error.message, 'error'));
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
    downloadWorkbook('reports_workbook.xlsx', [
      { name: 'Summary', rows: [reports.summary.cards] },
      { name: 'Workload', rows: reports.workload.rows },
      { name: 'Fairness', rows: [{ Role: 'TA', ...reports.fairness.ta }, { Role: 'Doctor', ...reports.fairness.doctor }] },
      { name: 'DailyCoverage', rows: reports.dailyCoverage.rows },
      { name: 'Conflicts', rows: reports.conflicts.rows },
      { name: 'SessionCoverage', rows: reports.sessionCoverage.rows },
      { name: 'Utilization', rows: reports.utilization.rows },
      { name: 'Quality', rows: [reports.quality.breakdown] },
      { name: 'StaffReport', rows: reports.staffReport?.sessions || [] },
    ]);
    showToast('Full reports workbook exported.', 'success');
  }

  const topCards = [
    { label: 'Staff', value: reports.summary.cards.totalStaff || 0, tone: 'blue' },
    { label: 'Assigned Hours', value: reports.summary.cards.totalAssignedHours || 0, tone: 'purple' },
    { label: 'Avg Hours', value: reports.summary.cards.averageAssignedHours || 0, tone: 'success' },
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
            <button type="button" className="primary-btn" onClick={exportFullWorkbook}>Export Full Workbook</button>
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
        <div className="summary-grid">
          {topCards.map((card) => (
            <div className={`summary-card ${card.tone}`} key={card.label}>
              <div className="summary-card-value">{card.value}</div>
              <div className="summary-card-label">{card.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Workload Report</h2>
            <p>Assigned load, remaining capacity, and utilization for each staff member.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={() => exportReportCsv('workload_report', reports.workload.rows)}>Export CSV</button>
            <button type="button" className="ghost-btn" onClick={() => exportReportExcel('workload_report', reports.workload.rows)}>Export Excel</button>
          </div>
        </div>
        <div className="chips-wrap">
          <div className="info-chip"><strong>Total Staff</strong><span>{reports.workload.summary.totalStaff || 0}</span></div>
          <div className="info-chip"><strong>Total Assigned H</strong><span>{reports.workload.summary.totalAssignedHours || 0}</span></div>
          <div className="info-chip"><strong>Avg Assigned H</strong><span>{reports.workload.summary.averageAssignedHours || 0}</span></div>
          <div className="info-chip"><strong>Max H</strong><span>{reports.workload.summary.maxAssignedHours || 0}</span></div>
          <div className="info-chip"><strong>Min H</strong><span>{reports.workload.summary.minAssignedHours || 0}</span></div>
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
                  <td>{row.utilizationPercent}%</td>
                  <td><span className={`report-badge ${row.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.status}</span></td>
                </tr>
              ))}
              {!reports.workload.rows.length ? <tr><td colSpan="10" className="empty-cell">No workload data for the current filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Fairness Report</h2>
            <p>Separate fairness analysis for TAs and Doctors based on workload spread and standard deviation.</p>
          </div>
          <div className="action-row">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => exportReportExcel('fairness_report', [{ Role: 'TA', ...reports.fairness.ta }, { Role: 'Doctor', ...reports.fairness.doctor }])}
            >
              Export Excel
            </button>
          </div>
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
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Daily Coverage Report</h2>
            <p>Required versus assigned staffing for each exam day.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={() => exportReportCsv('daily_coverage_report', reports.dailyCoverage.rows)}>Export CSV</button>
            <button type="button" className="ghost-btn" onClick={() => exportReportExcel('daily_coverage_report', reports.dailyCoverage.rows)}>Export Excel</button>
          </div>
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
              {!reports.dailyCoverage.rows.length ? <tr><td colSpan="10" className="empty-cell">No daily coverage data for the current filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Conflict Report</h2>
            <p>Overlap, engagement, max-hours, and duplicate assignment checks.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={() => exportReportExcel('conflict_report', reports.conflicts.rows)}>Export Excel</button>
          </div>
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
          <div className="empty-state">No conflicts found.</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Staff Individual Report</h2>
            <p>Select a staff member in the filters to inspect their assignment history.</p>
          </div>
          {reports.staffReport?.person ? (
            <div className="action-row">
              <button type="button" className="ghost-btn" onClick={() => exportReportExcel('staff_report', reports.staffReport.sessions)}>Export Excel</button>
            </div>
          ) : null}
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
          <div className="empty-state">Select a staff member to view the individual report.</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Session Coverage Report</h2>
            <p>Coverage quality at session level.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={() => exportReportCsv('session_coverage_report', reports.sessionCoverage.rows)}>Export CSV</button>
            <button type="button" className="ghost-btn" onClick={() => exportReportExcel('session_coverage_report', reports.sessionCoverage.rows)}>Export Excel</button>
          </div>
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
              {!reports.sessionCoverage.rows.length ? <tr><td colSpan="10" className="empty-cell">No session coverage data for the current filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Utilization Report</h2>
            <p>Capacity usage by utilization band.</p>
          </div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={() => exportReportExcel('utilization_report', reports.utilization.rows)}>Export Excel</button>
          </div>
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
              {!reports.utilization.rows.length ? <tr><td colSpan="6" className="empty-cell">No utilization data for the current filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Schedule Quality Score</h2>
            <p>Coverage, fairness, conflict, and overload combined into one readiness score.</p>
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
      </section>
    </div>
  );
}
