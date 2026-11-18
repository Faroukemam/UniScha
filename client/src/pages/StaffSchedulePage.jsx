import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';
import { buildStaffSchedule, dutyLabels, staffScheduleExportRows } from '../staffSchedule.mjs';

function formatDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

export default function StaffSchedulePage() {
  const showToast = useToast();
  const [people, setPeople] = useState([]);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleError, setPeopleError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [filters, setFilters] = useState({ startDate: '', endDate: '', dutyType: '' });
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => { api.clearCache(); setRefreshKey((value) => value + 1); }, []);

  useEffect(() => {
    window.addEventListener('scheduler:data-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('scheduler:data-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    setPeopleLoading(true);
    setPeopleError('');
    api.getInvigilators().then((rows) => {
      if (!active) return;
      setPeople([...rows].sort((a, b) => a.name.localeCompare(b.name) || String(a.staffId).localeCompare(String(b.staffId))));
    }).catch((error) => { if (active) { setPeople([]); setPeopleError(error.message); } })
      .finally(() => { if (active) setPeopleLoading(false); });
    return () => { active = false; };
  }, [refreshKey]);

  const visiblePeople = useMemo(() => {
    const term = search.trim().toLowerCase();
    return people.filter((person) => (!role || person.role === role)
      && (!term || [person.name, person.staffId, person.department].some((value) => String(value || '').toLowerCase().includes(term))));
  }, [people, role, search]);
  const selected = visiblePeople.find((person) => person.id === selectedId) || visiblePeople[0];
  const staffId = selected?.id || '';

  useEffect(() => {
    let active = true;
    setReport(null);
    setReportError('');
    if (!staffId) { setReportLoading(false); return () => { active = false; }; }
    setReportLoading(true);
    api.getStaffSchedule(staffId).then((value) => { if (active) setReport(value); })
      .catch((error) => { if (active) setReportError(error.message); })
      .finally(() => { if (active) setReportLoading(false); });
    return () => { active = false; };
  }, [staffId, refreshKey]);

  const current = report?.person?.id === staffId ? report : null;
  const schedule = useMemo(() => buildStaffSchedule(current?.sessions || [], filters), [current, filters]);
  const loading = peopleLoading || reportLoading || Boolean(staffId && !current && !reportError);
  const updateFilter = (key, value) => setFilters((previous) => ({ ...previous, [key]: value }));

  function exportSchedule() {
    if (!current || loading || !schedule.rows.length) return;
    try {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(staffScheduleExportRows(current.person, schedule.rows)), 'StaffSchedule');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
        StaffID: current.person.staffId, Name: current.person.name, Role: current.person.role,
        From: filters.startDate || 'All dates', To: filters.endDate || 'All dates', DutyType: dutyLabels[filters.dutyType] || 'All duties',
        Duties: schedule.dutyCount, Hours: Number((schedule.totalMinutes / 60).toFixed(2)), WorkingDays: schedule.workedDays,
        DaysOffBetweenDates: schedule.workingDayGaps, IdleMinutes: schedule.idleMinutes,
        PreferConsecutiveDuties: current.policy?.preferConsecutiveDuties ? 'Yes' : 'No',
        PreferConsecutiveDays: current.policy?.preferConsecutiveDays ? 'Yes' : 'No',
        AllowEngagementOverride: current.policy?.allowEngagementOverride === false ? 'No' : 'Yes',
      }]), 'Summary');
      const safeId = String(current.person.staffId || current.person.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      XLSX.writeFile(workbook, `staff_schedule_${safeId}.xlsx`);
      showToast('Staff schedule exported.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
  }

  return (
    <div className="page-grid staff-schedule-page">
      <section className="panel">
        <div className="panel-head">
          <div><h2>Individual staff schedule</h2><p>Saved sessions, on-call, control and super duties, grouped by date.</p></div>
          <div className="action-row">
            <button type="button" className="ghost-btn" onClick={refresh} disabled={loading}>Refresh</button>
            <button type="button" className="primary-btn" onClick={exportSchedule} disabled={loading || !current || !schedule.rows.length}>Export Excel</button>
          </div>
        </div>
        <div className="form-grid staff-schedule-filters">
          <label><span>Search staff</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, staff ID or department" /></label>
          <label><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value)}><option value="">All roles</option><option value="TA">TA</option><option value="Doctor">Doctor</option></select></label>
          <label className="staff-schedule-person-select"><span>Staff member</span><select value={staffId} disabled={peopleLoading || !visiblePeople.length} onChange={(event) => setSelectedId(event.target.value)}>
            {!visiblePeople.length ? <option value="">{peopleLoading ? 'Loading staff…' : 'No matching staff'}</option> : null}
            {visiblePeople.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.staffId || person.id} · {person.role}</option>)}
          </select></label>
          <label><span>From date</span><input type="date" value={filters.startDate} onChange={(event) => updateFilter('startDate', event.target.value)} /></label>
          <label><span>To date</span><input type="date" value={filters.endDate} onChange={(event) => updateFilter('endDate', event.target.value)} /></label>
          <label><span>Duty type</span><select value={filters.dutyType} onChange={(event) => updateFilter('dutyType', event.target.value)}><option value="">All duties</option>{Object.entries(dutyLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        </div>
        {filters.startDate || filters.endDate || filters.dutyType ? <button type="button" className="ghost-btn staff-schedule-clear" onClick={() => setFilters({ startDate: '', endDate: '', dutyType: '' })}>Clear schedule filters</button> : null}
        {schedule.invalidRange ? <p className="staff-schedule-error" role="alert">The end date must be on or after the start date.</p> : null}
      </section>

      {peopleError || reportError ? <section className="panel"><p role="alert">Could not load the staff schedule: {peopleError || reportError}</p><button type="button" className="ghost-btn" onClick={refresh}>Try again</button></section> : null}
      {loading ? <div className="empty-state" role="status">Loading staff schedule…</div> : null}
      {!peopleLoading && !peopleError && !selected ? <section className="panel empty-state">{people.length ? 'No staff match your search and role filters.' : <span>No staff have been added yet. <Link to="/invigilators">Manage invigilators</Link></span>}</section> : null}

      {!loading && current ? <>
        <section className="panel staff-schedule-overview">
          <div className="panel-head"><div><h2>{current.person.name}</h2><p>{current.person.staffId || current.person.id} · {current.person.role}{current.person.department ? ` · ${current.person.department}` : ''}</p></div><Link className="ghost-btn" to="/staff-hour-policy">Staff policies</Link></div>
          <div className="chips-wrap staff-schedule-preferences">
            <span className="info-chip">Consecutive duties: {current.policy?.preferConsecutiveDuties ? 'preferred' : 'off'}</span>
            <span className="info-chip">Consecutive days: {current.policy?.preferConsecutiveDays ? 'preferred' : 'off'}</span>
          </div>
          <div className="staff-schedule-stats" aria-live="polite">
            <div><span>Duties</span><strong>{schedule.dutyCount}</strong></div>
            <div><span>Total hours</span><strong>{(schedule.totalMinutes / 60).toFixed(2)}</strong></div>
            <div><span>Working days</span><strong>{schedule.workedDays}</strong></div>
            <div><span>Days off between dates</span><strong>{schedule.workingDayGaps}</strong></div>
            <div><span>Idle minutes within days</span><strong>{schedule.idleMinutes}</strong></div>
          </div>
          <p className="muted">Totals and gaps reflect the current date and duty filters. Days off includes calendar days between working dates.</p>
        </section>
        {!schedule.rows.length ? <section className="panel empty-state">{schedule.invalidRange ? 'Choose a valid date range to view duties.' : current.sessions.length ? 'No saved duties match these filters.' : 'This staff member has no saved duties yet.'}</section> : null}
        {schedule.days.map((day) => <section className="panel table-panel staff-schedule-day" key={day.date} aria-label={`Duties on ${day.date}`}>
          <div className="panel-head"><div><h3>{formatDate(day.date)}</h3><p>{day.duties.length} duties · {(day.minutes / 60).toFixed(2)} hours{day.idleMinutes ? ` · ${day.idleMinutes} idle minutes` : ''}</p></div></div>
          <div className="table-wrap"><table><thead><tr><th scope="col">Time</th><th scope="col">Duty</th><th scope="col">Course / details</th><th scope="col">Room</th><th scope="col">Hours</th></tr></thead><tbody>
            {day.duties.map((duty, index) => <tr key={`${duty.dutyType}-${duty.id || index}`}>
              <td className="staff-schedule-time">{duty.startTime && duty.endTime ? `${duty.startTime} – ${duty.endTime}` : 'Time unavailable'}</td>
              <td><span className={`staff-duty-badge staff-duty-${duty.dutyType}`}>{dutyLabels[duty.dutyType] || duty.dutyType}</span></td>
              <td>{duty.courseCode || duty.course || '—'}</td><td>{duty.room || '—'}</td>
              <td>{((duty.durationMinutes ?? Number(duty.durationHours || 0) * 60) / 60).toFixed(2)}</td>
            </tr>)}
          </tbody></table></div>
        </section>)}
      </> : null}
    </div>
  );
}
