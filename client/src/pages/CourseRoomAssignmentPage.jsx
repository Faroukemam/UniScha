import { useEffect, useMemo, useRef, useState } from 'react';
import CourseRoomDetails, { AllocatedRoomCard, CourseRoomPager, PlacementBadge } from '../components/CourseRoomDetails';
import { filterCourseRoomRows, groupRoomPeriods, isBackupRoom, placementStatusLabels, summarizeCourseRooms } from '../courseRoomView.mjs';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useToast } from '../App';

const defaultState = {
  courses: [],
  availability: [],
  capacities: [],
  results: [],
  roomRows: [],
  validationErrors: [],
  summary: {
    totalCourses: 0,
    totalPlacementGroups: 0,
    assignedGroups: 0,
    assignedWithBackup: 0,
    unassignedGroups: 0,
    capacityShortage: 0,
    totalWasteCapacity: 0,
    backupRoomsUsed: 0,
  },
};

const defaultQuality = {
  autoAvailableUsage: {
    totalAutoAvailableRoomBlocksUsed: 0,
    totalGroupsUsingAutoAvailable: 0,
    autoAvailableRoomsUsed: [],
    usagePerAutoAvailableRoom: [],
    usageByDateStart: [],
    totalStudentsAssignedThroughAutoAvailable: 0,
  },
  backupNecessity: [],
  stageSummaries: {
    normalOnly: null,
    backupEnabled: null,
    finalChosen: null,
    strategy: '',
    reason: '',
    improvedField: '',
  },
  finalAutoAvailableOnly: {
    groups: [],
    students: 0,
  },
  shortages: [],
  shortageDiagnostics: [],
  largerRoomBehavior: [],
};

const defaultSettings = {
  useAutoAvailableBackup: true,
  groupLinkedCourses: true,
  allowThFallback: true,
  capacityStrategy: 'best',
  timeLimitSeconds: 60,
};

function normalizeDate(value) {
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parts = raw.split(/[./-]/).map((item) => item.trim()).filter(Boolean);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
    }
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    const year = Number(parts[2]);
    if (raw.includes('/') && first <= 12) {
      return `${year}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`;
    }
    return `${year}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`;
  }
  return raw;
}

function normalizeTime(value) {
  if (typeof value === 'number' && value > 0 && value < 1) {
    const totalMinutes = Math.round(value * 24 * 60);
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  }
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.includes(':')) {
    const [hours, minutes] = raw.split(':');
    return `${String(hours).padStart(2, '0')}:${String(minutes || 0).padStart(2, '0')}`;
  }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) return raw;
  return `${String(Math.floor(numeric / 100)).padStart(2, '0')}:${String(numeric % 100).padStart(2, '0')}`;
}

function normalizeType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ['TH', 'DH', 'LAB'].includes(normalized) ? normalized : '';
}

function truthy(value) {
  return ['1', 'true', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());
}

async function readRows(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstDataSheet = workbook.SheetNames.find((name) => String(name).trim().toLowerCase() !== 'instructions');
  return firstDataSheet ? XLSX.utils.sheet_to_json(workbook.Sheets[firstDataSheet]) : [];
}

function parseScheduleRows(rows) {
  return rows.map((row) => ({
    CourseCode: String(row.CourseCode ?? row.courseCode ?? '').trim().toUpperCase(),
    Students: Number(row.Students ?? row.students ?? 0),
    Date: normalizeDate(row.Date ?? row.date),
    Start: normalizeTime(row.Start ?? row.start),
    End: normalizeTime(row.End ?? row.end),
    RoomPlacementType: normalizeType(row.RoomPlacementType ?? row.roomPlacementType ?? row.RoomType ?? row.roomType),
    LinkedGroup: String(row.LinkedGroup ?? row.linkedGroup ?? '').trim().toUpperCase(),
    LinkedCourses: String(row.LinkedCourses ?? row.linkedCourses ?? '').trim(),
  }));
}

function parseSessionRows(rows) {
  return rows.map((row) => ({
    Room: String(row.Room ?? row.room ?? '').trim(),
    Date: normalizeDate(row.Date ?? row.date),
    Start: normalizeTime(row.Start ?? row.start),
    End: normalizeTime(row.End ?? row.end),
  }));
}

function parseCapacityRows(rows) {
  return rows.map((row) => ({
    Room: String(row.Room ?? row.room ?? '').trim(),
    MinorCap: Number(row.MinorCap ?? row.minorCap ?? 0),
    MajorCap: Number(row.MajorCap ?? row.majorCap ?? 0),
    RoomType: normalizeType(row.RoomType ?? row.roomType),
    AutoAvailable: truthy(row.AutoAvailable ?? row.autoAvailable) ? 'Yes' : 'No',
  }));
}

function exportWorkbook(fileName, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sheet.rows), sheet.name);
  });
  XLSX.writeFile(workbook, fileName);
}

function clampPage(page, totalItems, pageSize) {
  return Math.max(1, Math.min(page, Math.max(1, Math.ceil(totalItems / pageSize))));
}

function paginate(items, page, pageSize) {
  const currentPage = clampPage(page, items.length, pageSize);
  const start = (currentPage - 1) * pageSize;
  return {
    page: currentPage,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
    items: items.slice(start, start + pageSize),
  };
}

export default function CourseRoomAssignmentPage() {
  const showToast = useToast();
  const [state, setState] = useState(defaultState);
  const [quality, setQuality] = useState(defaultQuality);
  const [settings, setSettings] = useState(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [qualityError, setQualityError] = useState('');
  const [view, setView] = useState('placements');
  const [filters, setFilters] = useState({ search: '', date: '', type: '', status: '', roomSource: '' });
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [resultsPage, setResultsPage] = useState(1);
  const [roomRowsPage, setRoomRowsPage] = useState(1);
  const [shortagePage, setShortagePage] = useState(1);
  const sequence = useRef(0);
  const detailsRef = useRef(null);
  const busy = loading || Boolean(action);
  const summary = useMemo(() => summarizeCourseRooms(state), [state]);
  const ready = state.courses.length > 0 && state.capacities.length > 0;
  const validBudget = Number.isFinite(Number(settings.timeLimitSeconds)) && Number(settings.timeLimitSeconds) >= 1 && Number(settings.timeLimitSeconds) <= 600;

  function replaceState(response) {
    setState({ ...defaultState, ...response, summary: { ...defaultState.summary, ...response?.summary } });
    setSelectedGroupId('');
    setResultsPage(1); setRoomRowsPage(1); setShortagePage(1);
  }

  async function loadState() {
    const request = ++sequence.current;
    setLoading(true); setError(''); setQualityError(''); api.clearCache();
    const [saved, analysis] = await Promise.allSettled([api.getCourseRoomAssignment(), api.getCourseRoomQuality()]);
    if (request !== sequence.current) return;
    if (saved.status === 'fulfilled') {
      setState({ ...defaultState, ...saved.value, summary: { ...defaultState.summary, ...saved.value.summary } });
    } else setError(saved.reason.message);
    if (analysis.status === 'fulfilled') setQuality({ ...defaultQuality, ...analysis.value });
    else { setQuality(defaultQuality); setQualityError(analysis.reason.message); }
    setLoading(false);
  }

  useEffect(() => { loadState(); return () => { sequence.current += 1; }; }, []);
  useEffect(() => { if (selectedGroupId) detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [selectedGroupId]);

  async function loadQuality() {
    try { setQuality({ ...defaultQuality, ...await api.getCourseRoomQuality() }); setQualityError(''); }
    catch (failure) { setQuality(defaultQuality); setQualityError(failure.message); }
  }

  async function importFile(event, parser, importer, label, existingCount) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file || busy) return;
    if ((existingCount || state.results.length) && !window.confirm(`Replace ${label.toLowerCase()}? Current room placement results will be cleared.`)) { input.value = ''; return; }
    setAction('import'); setError('');
    try {
      const rows = parser(await readRows(file));
      const response = await importer(rows);
      replaceState(response.state || defaultState); setQuality(defaultQuality); setQualityError('');
      const errorCount = response.errors?.length || 0;
      showToast(`${label}: ${response.imported ?? rows.length} rows imported${errorCount ? `, ${errorCount} validation errors` : ''}.`, errorCount ? 'warning' : 'success');
    } catch (failure) { setError(failure.message); showToast(failure.message, 'error'); }
    finally { setAction(''); input.value = ''; }
  }

  async function runAssignment() {
    if (busy || !ready || !validBudget) return;
    setAction('run'); setError('');
    try {
      replaceState(await api.runCourseRoomAssignment({ ...settings, timeLimitSeconds: Number(settings.timeLimitSeconds) }));
      await loadQuality(); setView('placements');
      showToast('Course room allocation saved.', 'success');
    } catch (failure) { setError(failure.message); showToast(failure.message, 'error'); }
    finally { setAction(''); }
  }

  async function clearResults() {
    if (busy || !window.confirm('Clear all saved room placements? Course schedule and room inputs will be kept.')) return;
    setAction('clear'); setError('');
    try { replaceState(await api.clearCourseRoomResults()); setQuality(defaultQuality); setQualityError(''); showToast('Room placements cleared.', 'success'); }
    catch (failure) { setError(failure.message); showToast(failure.message, 'error'); }
    finally { setAction(''); }
  }

  async function exportResults(shortagesOnly = false) {
    if (busy) return;
    setAction('export');
    try {
      const response = await (shortagesOnly ? api.exportCourseRoomUnassigned() : api.exportCourseRoomAssignment());
      exportWorkbook(shortagesOnly ? 'course_room_assignment_unassigned.xlsx' : 'course_room_assignment_results.xlsx', response.sheets || []);
      showToast('Workbook exported.', 'success');
    } catch (failure) { showToast(failure.message, 'error'); }
    finally { setAction(''); }
  }

  function downloadTemplate(type) {
    if (type === 'schedule') {
      exportWorkbook('course_room_schedule_template.xlsx', [{
        name: 'CourseSchedule',
        rows: [
          {
            CourseCode: 'BME407',
            Students: 140,
            Date: '2026-01-06',
            Start: '09:30',
            End: '11:30',
            RoomPlacementType: 'TH',
            LinkedGroup: 'G1',
            LinkedCourses: 'BME407N',
          },
          {
            CourseCode: 'BME407N',
            Students: 60,
            Date: '2026-01-06',
            Start: '09:30',
            End: '11:30',
            RoomPlacementType: 'TH',
            LinkedGroup: 'G1',
            LinkedCourses: 'BME407',
          },
        ],
      }, {
        name: 'Instructions',
        rows: [
          { Section: 'Purpose', Instruction: 'Import course schedule demand rows for Course Room Assignment.' },
          { Section: 'Columns', Instruction: 'Required columns: CourseCode, Students, Date, Start, End, RoomPlacementType.' },
          { Section: 'RoomPlacementType', Instruction: 'Allowed values: TH, DH, LAB.' },
          { Section: 'LinkedCourses', Instruction: 'Use LinkedGroup and LinkedCourses when courses must be placed together.' },
        ],
      }]);
      return;
    }
    if (type === 'sessions') {
      exportWorkbook('course_room_sessions_template.xlsx', [{
        name: 'RoomSessions',
        rows: [
          { Room: '324 R PH', Date: '2026-01-06', Start: '09:00', End: '12:00' },
          { Room: '325 R PH', Date: '2026-01-06', Start: '09:00', End: '12:00' },
        ],
      }, {
        name: 'Instructions',
        rows: [
          { Section: 'Purpose', Instruction: 'Import room-session availability rows for Course Room Assignment.' },
          { Section: 'Columns', Instruction: 'Required columns: Room, Date, Start, End.' },
          { Section: 'DateTime', Instruction: 'Preferred formats: Date = YYYY-MM-DD, Start/End = HH:MM.' },
        ],
      }]);
      return;
    }
    exportWorkbook('course_room_capacity_template.xlsx', [{
      name: 'RoomCapacity',
      rows: [
        { Room: '324 R PH', MinorCap: 60, MajorCap: 80, RoomType: 'TH', AutoAvailable: 'No' },
        { Room: 'Lab 3', MinorCap: 25, MajorCap: 30, RoomType: 'LAB', AutoAvailable: 'Yes' },
      ],
    }, {
      name: 'Instructions',
      rows: [
        { Section: 'Purpose', Instruction: 'Import room capacities for Course Room Assignment.' },
        { Section: 'Columns', Instruction: 'Required columns: Room, MinorCap, MajorCap, RoomType, AutoAvailable.' },
        { Section: 'RoomType', Instruction: 'Allowed values: TH, DH, LAB.' },
        { Section: 'AutoAvailable', Instruction: 'Use Yes for backup rooms and No otherwise. Imported capacities remain strict limits.' },
      ],
    }]);
  }

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
    setResultsPage(1); setRoomRowsPage(1); setShortagePage(1); setSelectedGroupId('');
  }
  function clearFilters() {
    setFilters({ search: '', date: '', type: '', status: '', roomSource: '' });
    setResultsPage(1); setRoomRowsPage(1); setShortagePage(1); setSelectedGroupId('');
  }

  const results = useMemo(() => filterCourseRoomRows(state.results, filters), [state.results, filters]);
  const roomRows = useMemo(() => filterCourseRoomRows(state.roomRows, filters, 'rooms'), [state.roomRows, filters]);
  const periods = useMemo(() => groupRoomPeriods(roomRows), [roomRows]);
  const diagnostics = useMemo(() => {
    const groups = new Map(state.results.map((row) => [row.placementGroupId, row]));
    const rows = (quality.shortageDiagnostics || []).map((row) => ({ ...row, roomPlacementType: groups.get(row.placementGroupId)?.roomPlacementType }));
    return filterCourseRoomRows(rows, filters, 'diagnostics');
  }, [quality.shortageDiagnostics, state.results, filters]);
  const pagedResults = paginate(results, resultsPage, 25);
  const pagedPeriods = paginate(periods, roomRowsPage, 8);
  const pagedDiagnostics = paginate(diagnostics, shortagePage, 20);
  const selectedResult = state.results.find((row) => row.placementGroupId === selectedGroupId);
  const selectedRooms = state.roomRows.filter((row) => row.placementGroupId === selectedGroupId);
  const normalRooms = state.capacities.filter((row) => !isBackupRoom(row)).length;
  const setupCards = [
    { title: 'Course schedule', count: state.courses.length, text: 'Courses, student counts, exam times, and linked groups.', columns: 'CourseCode, Students, Date, Start, End, RoomPlacementType, LinkedGroup, LinkedCourses', template: 'schedule', parser: parseScheduleRows, importer: api.importCourseRoomScheduleRows },
    { title: 'Room availability', count: state.availability.length, text: 'Time windows for normal rooms. Backup rooms can be used without a room-session entry.', columns: 'Room, Date, Start, End', template: 'sessions', parser: parseSessionRows, importer: api.importCourseRoomSessionRows },
    { title: 'Room capacity', count: state.capacities.length, text: 'Major and Minor seats, room types, and backup-room flags.', columns: 'Room, MinorCap, MajorCap, RoomType, AutoAvailable', template: 'capacity', parser: parseCapacityRows, importer: api.importCourseRoomCapacityRows },
  ];
  const navigation = [
    ['setup', 'Setup', state.courses.length ? 'Inputs loaded' : 'Start here'],
    ['placements', 'Placements', `${state.results.length} groups`],
    ['rooms', 'Room allocations', `${state.roomRows.length} allocations`],
    ['diagnostics', 'Diagnostics', `${(quality.shortageDiagnostics || []).length} shortages`],
  ];

  return <div className="page-grid rules-page course-room-page cr-workspace" aria-busy={busy}>
    <section className="rules-intro cr-intro"><div><span className="rules-eyebrow">EXAM ROOM PLANNING</span><h2>A place for every course</h2><p>Prepare your rooms, allocate linked course groups, and inspect where every student will sit.</p></div><div className="action-row"><button type="button" className="ghost-btn" onClick={loadState} disabled={busy}>Refresh</button><button type="button" className="primary-btn" onClick={runAssignment} disabled={busy || !ready || !validBudget}>{action === 'run' ? 'Allocating rooms…' : 'Run room assignment'}</button></div></section>
    {error ? <div className="rules-feedback is-error" role="alert">{error} Saved results shown below may be out of date.</div> : null}
    {qualityError ? <div className="rules-feedback is-error" role="alert">Diagnostics could not be loaded: {qualityError}. Refresh to try again.</div> : null}
    {action === 'run' ? <div className="cr-running" role="status"><span className="cr-activity-dot" />Allocating rooms and comparing normal-room and backup options. The result will be saved when complete.</div> : null}

    <section className="ops-metrics cr-metrics" aria-label="Room assignment summary">
      {[
        ['Groups fully placed', `${summary.placedGroups} / ${summary.groups}`, 'Linked courses are counted together'],
        ['Students without seats', summary.shortage === null ? '—' : summary.shortage, summary.groups ? `${summary.seatedStudents.toLocaleString()} of ${summary.totalStudents.toLocaleString()} students seated` : 'Run an assignment to calculate coverage'],
        ['Rooms used', summary.usedRooms, 'Distinct physical rooms across all periods'],
        ['Backup rooms used', summary.backupRooms, `${summary.backupGroups} groups use backup rooms`],
      ].map(([label, value, note]) => <article className="ops-metric" key={label}><span>{label}</span><strong>{loading ? '…' : value}</strong><small>{note}</small></article>)}
    </section>

    <nav className="cr-navigation" aria-label="Course room workspace">{navigation.map(([key, label, note], index) => <button key={key} type="button" aria-pressed={view === key} className={view === key ? 'is-active' : ''} onClick={() => { setView(key); setSelectedGroupId(''); }}><span className="cr-nav-number">0{index + 1}</span><span><strong>{label}</strong><small>{loading ? 'Loading…' : note}</small></span></button>)}</nav>

    {view === 'setup' ? <>
      <section className="panel"><div className="panel-head"><div><h2>Prepare the allocation inputs</h2><p>Each import replaces that input list and clears the saved placement results.</p></div><span className={`ops-badge ${ready ? 'tone-success' : 'tone-warning'}`}>{loading ? 'Loading inputs' : ready ? 'Course and capacity inputs loaded' : 'Course schedule and room capacity needed'}</span></div>
        <div className="cr-import-grid">{setupCards.map((card, index) => <article className="cr-import-card" key={card.title}><div className="panel-head"><span className="cr-import-number">0{index + 1}</span><span className={`ops-badge ${card.count ? 'tone-success' : 'tone-neutral'}`}>{card.count} rows</span></div><h3>{card.title}</h3><p>{card.text}</p><details className="cr-column-help"><summary>Workbook columns</summary><p>{card.columns}</p></details><div className="action-row"><label className={`ghost-btn cr-file-button ${busy ? 'is-disabled' : ''}`}><span>Import Excel</span><input type="file" accept=".xlsx,.xls" aria-label={`Import ${card.title.toLowerCase()}`} disabled={busy} onChange={(event) => importFile(event, card.parser, card.importer, card.title, card.count)} /></label><button type="button" className="ghost-btn" disabled={busy} onClick={() => downloadTemplate(card.template)}>Template</button></div></article>)}</div>
        <p className="ops-help">{state.capacities.length} rooms in the capacity list · {normalRooms} normal · {state.capacities.length - normalRooms} backup. Availability must cover the exam window; DH rooms also follow the start-time rule.</p>
      </section>
      <section className="panel"><div className="panel-head"><div><h2>Allocation preferences</h2><p>Choose the options for your next run. Existing results stay saved until a new run completes.</p></div><div className="chips-wrap"><span className="ops-badge">Imported capacities are strict limits</span><span className="ops-badge">One block per group per room</span></div></div>
        <fieldset className="cr-settings" disabled={busy}><legend className="sr-only">Room allocation preferences</legend><div className="cr-setting-toggles">
          <label><input type="checkbox" checked={settings.useAutoAvailableBackup} onChange={(event) => setSettings((current) => ({ ...current, useAutoAvailableBackup: event.target.checked }))} /><span><strong>Use backup rooms</strong><small>Compare an allocation with AutoAvailable rooms when normal rooms leave shortages.</small></span></label>
          <label><input type="checkbox" checked={settings.groupLinkedCourses} onChange={(event) => setSettings((current) => ({ ...current, groupLinkedCourses: event.target.checked }))} /><span><strong>Keep linked courses together</strong><small>Place linked courses as a single student group.</small></span></label>
          <label><input type="checkbox" checked={settings.allowThFallback} onChange={(event) => setSettings((current) => ({ ...current, allowThFallback: event.target.checked }))} /><span><strong>Allow TH fallback</strong><small>TH courses may use LAB or DH rooms when compatible. LAB and DH course restrictions remain enforced.</small></span></label>
        </div><div className="form-grid cr-setting-fields"><label><span>Capacity selection</span><select value={settings.capacityStrategy} onChange={(event) => setSettings((current) => ({ ...current, capacityStrategy: event.target.value }))}><option value="best">Choose Major or Minor in each room</option><option value="major">Major only</option><option value="minor">Minor only</option></select></label><label><span>Solve budget per stage (seconds)</span><input type="number" min="1" max="600" value={settings.timeLimitSeconds} onChange={(event) => setSettings((current) => ({ ...current, timeLimitSeconds: event.target.value }))} aria-invalid={!validBudget} /><small>1–600 seconds. A backup comparison can require another stage.</small></label></div></fieldset>
        {!validBudget ? <p className="rules-feedback is-error" role="alert">Enter a solve budget between 1 and 600 seconds.</p> : null}
        {!state.availability.length && normalRooms > 0 ? <p className="ops-help">Normal rooms need availability windows. Add room availability to make these rooms candidates.</p> : null}
      </section>
    </> : null}

    {view !== 'setup' ? <section className="panel cr-register">
      <div className="panel-head"><div><h2>{view === 'placements' ? 'Course placements' : view === 'rooms' ? 'Room allocations by period' : 'Allocation diagnostics'}</h2><p>{view === 'placements' ? 'Inspect course groups, coverage, and assigned rooms.' : view === 'rooms' ? 'See how Major and Minor blocks are used in each exam window.' : 'Review shortages and compare the normal-room and backup results.'}</p></div><div className="action-row"><button type="button" className="ghost-btn" disabled={busy || !state.results.length} onClick={() => exportResults(false)}>Export full workbook</button><button type="button" className="ghost-btn" disabled={busy || !state.results.length} onClick={() => exportResults(true)}>Export shortages</button></div></div>
      <div className="form-grid cr-filters"><label><span>Search</span><input type="search" placeholder="Course, group, or room" value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} /></label><label><span>Exam date</span><input type="date" value={filters.date} onChange={(event) => updateFilter('date', event.target.value)} /></label><label><span>Room type</span><select value={filters.type} onChange={(event) => updateFilter('type', event.target.value)}><option value="">All types</option>{['TH', 'DH', 'LAB'].map((type) => <option key={type}>{type}</option>)}</select></label>
        {view === 'placements' ? <label><span>Placement status</span><select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}><option value="">All statuses</option>{Object.entries(placementStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : view === 'rooms' ? <label><span>Room source</span><select value={filters.roomSource} onChange={(event) => updateFilter('roomSource', event.target.value)}><option value="">Normal and backup</option><option value="normal">Normal only</option><option value="backup">Backup only</option></select></label> : null}
        <button type="button" className="ghost-btn cr-clear-filters" onClick={clearFilters}>Clear filters</button>
      </div><p className="ops-help">Filters apply to this view. Exports include the full saved allocation.</p>

      {view === 'placements' ? <>
        <div className="cr-result-count" role="status">{loading ? 'Loading placements…' : `${results.length} matching groups / ${state.results.length} saved groups`}</div>
        {selectedResult ? <div ref={detailsRef}><CourseRoomDetails result={selectedResult} rooms={selectedRooms} onClose={() => setSelectedGroupId('')} /></div> : null}
        <div className="table-wrap ops-bounded-table cr-placement-table"><table><thead><tr><th>Course group</th><th>Exam window</th><th>Students</th><th>Assigned rooms</th><th>Coverage</th><th>Status</th><th>Details</th></tr></thead><tbody>{pagedResults.items.map((row) => <tr key={row.placementGroupId} className={selectedGroupId === row.placementGroupId ? 'is-selected' : ''}><td><strong>{row.courseCodes}</strong><small className="ops-cell-note">{row.placementGroupId} · {row.roomPlacementType}</small></td><td>{row.date}<small className="ops-cell-note">{row.start} – {row.end}</small></td><td><strong>{row.totalStudents}</strong></td><td className="cr-assigned-rooms">{row.assignedRooms || 'No room allocated'}<small className="ops-cell-note">{row.capacityMode || 'No block selected'}</small></td><td><strong>{Math.max(0, Number(row.totalStudents || 0) - Number(row.shortage || 0))} seated</strong><small className={`ops-cell-note ${Number(row.shortage) > 0 ? 'cr-shortage' : ''}`}>{row.shortage || 0} without seats</small></td><td><PlacementBadge status={row.status} /></td><td><button type="button" className="ghost-btn" aria-label={`View allocation for ${row.courseCodes}`} aria-expanded={selectedGroupId === row.placementGroupId} onClick={() => setSelectedGroupId((current) => current === row.placementGroupId ? '' : row.placementGroupId)}>{selectedGroupId === row.placementGroupId ? 'Close' : 'View'}</button></td></tr>)}{!results.length ? <tr><td colSpan="7" className="empty-cell">{loading ? 'Loading placements…' : state.results.length ? 'No placements match these filters.' : 'No saved placements. Open Setup to prepare inputs and run an allocation.'}</td></tr> : null}</tbody></table></div>
        <CourseRoomPager page={pagedResults.page} totalPages={pagedResults.totalPages} total={results.length} onPage={setResultsPage} label="Groups" />
      </> : null}

      {view === 'rooms' ? <>
        <div className="cr-result-count" role="status">{roomRows.length} matching allocations across {periods.length} periods</div>
        <div className="course-room-period-list">{pagedPeriods.items.map((period) => <article className="cr-period" key={`${period.date}|${period.start}|${period.end}`}><div className="panel-head"><div><h3>{period.date}</h3><p>{period.start} – {period.end}</p></div><span className="ops-badge">{new Set(period.rooms.map((room) => room.room)).size} rooms · {period.rooms.length} allocations</span></div><div className="cr-room-grid">{period.rooms.map((room, index) => <AllocatedRoomCard key={`${room.placementGroupId}|${room.room}|${room.capacityMode}|${index}`} room={room} />)}</div></article>)}</div>
        {!periods.length ? <div className="empty-state">{loading ? 'Loading room allocations…' : state.roomRows.length ? 'No room allocations match these filters.' : 'Run room assignment to see room allocations.'}</div> : null}
        <CourseRoomPager page={pagedPeriods.page} totalPages={pagedPeriods.totalPages} total={periods.length} onPage={setRoomRowsPage} label="Periods" />
      </> : null}

      {view === 'diagnostics' ? <>
        <div className="cr-strategy"><span className="rules-eyebrow">SAVED ALLOCATION</span><h3>{quality.stageSummaries?.strategy === 'BackupEnhanced' ? 'Backup rooms improved the allocation' : quality.stageSummaries?.strategy === 'NormalOnly' ? 'Normal-room allocation selected' : 'No comparison available'}</h3><p>{quality.stageSummaries?.reason || 'Run room assignment to generate a comparison.'}</p><div className="cr-comparison">{[['Normal rooms', quality.stageSummaries?.normalOnly], ['With backup', quality.stageSummaries?.backupEnabled]].map(([label, stage]) => <div key={label}><strong>{label}</strong><span>{stage ? `${stage.totalShortageStudents} students without seats` : 'No saved comparison'}</span></div>)}</div></div>
        <div className="panel-head cr-subheading"><div><h3>Shortage diagnostics</h3><p>Candidate capacity is a bound before competition with other groups; it does not guarantee a placement.</p></div><span className="ops-badge">{diagnostics.length} matching groups</span></div>
        <div className="table-wrap ops-bounded-table"><table><thead><tr><th>Course group</th><th>Exam window</th><th>Students without seats</th><th>Candidate rooms</th><th>Normal / backup capacity</th><th>Cause</th></tr></thead><tbody>{pagedDiagnostics.items.map((row) => <tr key={`${row.placementGroupId}|${row.periodInstance}`}><td><strong>{row.courseCodes}</strong><small className="ops-cell-note">{row.placementGroupId}</small></td><td>{row.date}<small className="ops-cell-note">{row.start} – {row.end}</small></td><td><strong className="cr-shortage">{row.shortage}</strong><small className="ops-cell-note">{row.assignedStudents} of {row.totalStudents} seated</small></td><td>{row.candidateRooms}</td><td>{row.totalCompatibleNormalCapacity} / {row.compatibleAutoAvailableCapacity}<small className="ops-cell-note">{row.theoreticallyPlaceable ? 'Capacity covers group before competition' : 'Below group size'}</small></td><td>{row.shortageReason}</td></tr>)}{!diagnostics.length ? <tr><td colSpan="6" className="empty-cell">{loading ? 'Loading diagnostics…' : qualityError ? 'Diagnostics are unavailable. Refresh to try again.' : quality.shortageDiagnostics?.length ? 'No shortage groups match these filters.' : state.results.length && summary.shortage === 0 ? 'All saved groups are fully placed. No student shortages to report.' : 'No shortage diagnostics available. Run an allocation to generate a report.'}</td></tr> : null}</tbody></table></div>
        <CourseRoomPager page={pagedDiagnostics.page} totalPages={pagedDiagnostics.totalPages} total={diagnostics.length} onPage={setShortagePage} label="Shortages" />
        <details className="cr-validation" open={state.validationErrors.length > 0}><summary>Input validation · {state.validationErrors.length} messages</summary><div className="table-wrap ops-bounded-table"><table><thead><tr><th>Source</th><th>Row</th><th>Field</th><th>Message</th></tr></thead><tbody>{state.validationErrors.map((row, index) => <tr key={index}><td>{row.source}</td><td>{row.row || '—'}</td><td>{row.field || '—'}</td><td>{row.errorMessage}</td></tr>)}{!state.validationErrors.length ? <tr><td colSpan="4" className="empty-cell">No validation messages in the saved allocation.</td></tr> : null}</tbody></table></div></details>
      </> : null}
    </section> : null}

    <footer className="cr-footer"><p>{state.results.length ? 'You are viewing saved course room placements.' : 'Prepare your inputs in Setup, then run room assignment.'} {state.validationErrors.length ? `${state.validationErrors.length} validation messages are available in Diagnostics.` : ''}</p><button type="button" className="ghost-btn ops-danger" disabled={busy || !state.results.length} onClick={clearResults}>{action === 'clear' ? 'Clearing…' : 'Clear saved placements'}</button></footer>
  </div>;
}
