import { useEffect, useMemo, useState } from 'react';
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

function resultTone(status) {
  if (status === 'Assigned') return 'success';
  if (status === 'AssignedWithBackup') return 'warning';
  if (status === 'CapacityShortage') return 'shortage';
  return 'danger';
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
  const [qualityLoading, setQualityLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [manualMode, setManualMode] = useState('Major');
  const [manualRooms, setManualRooms] = useState([]);
  const [resultsPage, setResultsPage] = useState(1);
  const [roomRowsPage, setRoomRowsPage] = useState(1);
  const [shortagePage, setShortagePage] = useState(1);

  async function loadState() {
    setLoading(true);
    setQualityLoading(true);
    try {
      const response = await api.getCourseRoomAssignment();
      setState({ ...defaultState, ...response });
      setLoading(false);
      try {
        const qualityResponse = await api.getCourseRoomQuality().catch(() => defaultQuality);
        setQuality({ ...defaultQuality, ...(qualityResponse || {}) });
      } finally {
        setQualityLoading(false);
      }
    } catch (error) {
      showToast(error.message, 'error');
      setLoading(false);
      setQualityLoading(false);
    }
  }

  useEffect(() => {
    loadState();
  }, []);

  async function importFile(event, parser, importer, label) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const rows = parser(await readRows(file));
      const response = await importer(rows);
      setState({ ...defaultState, ...(response.state || defaultState) });
      setQuality(defaultQuality);
      setResultsPage(1);
      setRoomRowsPage(1);
      setShortagePage(1);
      const count = response.imported ?? rows.length;
      const errorCount = response.errors?.length || 0;
      showToast(`${label} imported: ${count} valid rows${errorCount ? `, ${errorCount} validation errors` : ''}.`, errorCount ? 'warning' : 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
    event.target.value = '';
  }

  async function runAssignment() {
    setRunning(true);
    try {
      const response = await api.runCourseRoomAssignment(settings);
      setState({ ...defaultState, ...response });
      setResultsPage(1);
      setRoomRowsPage(1);
      setShortagePage(1);
      setQualityLoading(true);
      const qualityResponse = await api.getCourseRoomQuality().catch(() => defaultQuality);
      setQuality({ ...defaultQuality, ...(qualityResponse || {}) });
      setQualityLoading(false);
      showToast('Course Room Assignment completed.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
      setQualityLoading(false);
    } finally {
      setRunning(false);
    }
  }

  async function clearResults() {
    try {
      const response = await api.clearCourseRoomResults();
      setState({ ...defaultState, ...response });
      setQuality(defaultQuality);
      setSelectedGroupId('');
      setManualRooms([]);
      setResultsPage(1);
      setRoomRowsPage(1);
      setShortagePage(1);
      showToast('Course Room Assignment results cleared.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function exportResults() {
    try {
      const response = await api.exportCourseRoomAssignment();
      exportWorkbook('course_room_assignment_results.xlsx', response.sheets || []);
      showToast('Course Room Assignment workbook exported.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function exportUnassigned() {
    try {
      const response = await api.exportCourseRoomUnassigned();
      exportWorkbook('course_room_assignment_unassigned.xlsx', response.sheets || []);
      showToast('Unassigned / shortage workbook exported.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function submitManualAssignment() {
    if (!selectedGroupId) return;
    try {
      const response = await api.manualAssignCourseRoom({
        placementGroupId: selectedGroupId,
        capacityMode: manualMode,
        rooms: manualRooms,
        settings,
      });
      setState({ ...defaultState, ...response });
      setQualityLoading(true);
      const qualityResponse = await api.getCourseRoomQuality().catch(() => defaultQuality);
      setQuality({ ...defaultQuality, ...(qualityResponse || {}) });
      setQualityLoading(false);
      showToast('Manual room assignment saved.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
      setQualityLoading(false);
    }
  }

  function toggleManualRoom(room) {
    setManualRooms((current) => (
      current.includes(room)
        ? current.filter((item) => item !== room)
        : [...current, room]
    ));
  }

  function openManual(row) {
    setSelectedGroupId((current) => current === row.placementGroupId ? '' : row.placementGroupId);
    setManualMode(row.capacityMode || 'Major');
    setManualRooms(row.assignedRooms ? row.assignedRooms.split(',').map((item) => item.trim()).filter(Boolean) : []);
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
        { Section: 'AutoAvailable', Instruction: 'Use Yes for backup/overflow-capable rooms and No otherwise.' },
      ],
    }]);
  }

  const selectedResult = useMemo(
    () => state.results.find((item) => item.placementGroupId === selectedGroupId) || null,
    [state.results, selectedGroupId]
  );

  const groupedRoomView = useMemo(() => {
    const map = new Map();
    state.roomRows.forEach((row) => {
      const key = `${row.date}|${row.start}|${row.end}`;
      if (!map.has(key)) {
        map.set(key, { date: row.date, start: row.start, end: row.end, rooms: [] });
      }
      map.get(key).rooms.push(row);
    });
    return Array.from(map.values()).sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  }, [state.roomRows]);

  const pagedResults = useMemo(
    () => paginate(state.results, resultsPage, 25),
    [state.results, resultsPage]
  );
  const pagedRoomPeriods = useMemo(
    () => paginate(groupedRoomView, roomRowsPage, 12),
    [groupedRoomView, roomRowsPage]
  );
  const pagedShortageDiagnostics = useMemo(
    () => paginate(quality.shortageDiagnostics || [], shortagePage, 25),
    [quality.shortageDiagnostics, shortagePage]
  );

  const solverOutcomeCards = useMemo(() => ([
    { label: 'Final Strategy', value: quality.stageSummaries?.strategy || 'Not run', tone: 'blue' },
    { label: 'Why Chosen', value: quality.stageSummaries?.reason || 'No comparison yet', tone: 'purple' },
    { label: 'Backup Groups', value: quality.autoAvailableUsage?.totalGroupsUsingAutoAvailable ?? 0, tone: 'warning' },
    { label: 'Backup Students', value: quality.autoAvailableUsage?.totalStudentsAssignedThroughAutoAvailable ?? 0, tone: 'warning' },
  ]), [quality]);

  const causeRows = useMemo(() => {
    const rows = [];
    if (quality.stageSummaries?.finalChosen) {
      rows.push({
        title: 'Final chosen strategy',
        description: `${quality.stageSummaries.strategy || 'Unknown'} because ${quality.stageSummaries.reason || 'no reason recorded'}.`,
        tone: 'blue',
      });
    }
    if (quality.autoAvailableUsage?.totalGroupsUsingAutoAvailable) {
      rows.push({
        title: 'Backup assumption',
        description: `${quality.autoAvailableUsage.totalGroupsUsingAutoAvailable} groups used AutoAvailable rooms after the normal-room stage could not finish them.`,
        tone: 'warning',
      });
    }
    if (quality.shortageDiagnostics?.length) {
      const counts = quality.shortageDiagnostics.reduce((acc, row) => {
        acc[row.shortageReason] = (acc[row.shortageReason] || 0) + 1;
        return acc;
      }, {});
      Object.entries(counts).forEach(([reason, count]) => {
        rows.push({
          title: reason,
          description: `${count} groups were flagged with this assignment cause.`,
          tone: reason.includes('Packing') ? 'danger' : reason.includes('AutoAvailable') ? 'warning' : 'purple',
        });
      });
    }
    return rows;
  }, [quality]);

  const markers = [
    { label: 'Course schedule', count: state.courses.length, ready: state.courses.length > 0 },
    { label: 'Room sessions', count: state.availability.length, ready: state.availability.length > 0 },
    { label: 'Room capacity', count: state.capacities.length, ready: state.capacities.length > 0 },
    { label: 'Placement results', count: state.results.length, ready: state.results.length > 0 },
  ];

  return (
    <div className="page-grid course-room-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Course Room Assignment</h2>
            <p>Excel-driven course-to-room solver with linked groups, single-mode Major or Minor placement, strict LAB and DH rules, and optional AutoAvailable backup rooms.</p>
          </div>
          <div className="action-row">
            <button type="button" className="primary-btn" onClick={runAssignment} disabled={running || loading}>
              {running ? 'Running...' : 'Run Auto Room Assignment'}
            </button>
            <button type="button" className="ghost-btn" onClick={clearResults}>Clear Results</button>
            <button type="button" className="ghost-btn" onClick={exportResults}>Export Results Excel</button>
            <button type="button" className="ghost-btn" onClick={exportUnassigned}>Export Unassigned / Shortage</button>
          </div>
        </div>

        <div className="upload-marker-grid">
          {markers.map((marker) => (
            <div key={marker.label} className={`upload-marker ${marker.ready ? 'ready' : 'waiting'}`}>
              <div className="upload-marker-dot" />
              <div>
                <strong>{marker.label}</strong>
                <span>{marker.ready ? `${marker.count} loaded` : 'Waiting for data'}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="capability-import-grid course-room-import-grid">
          <div className="capability-import-card">
            <div className="capability-card-head">
              <strong>Course Schedule</strong>
              <span>{state.courses.length} rows</span>
            </div>
            <small>Columns: CourseCode, Students, Date, Start, End, RoomPlacementType, LinkedGroup, LinkedCourses.</small>
            <div className="action-row">
              <label className="ghost-btn course-room-upload-btn">
                Import Excel
                <input hidden type="file" accept=".xlsx,.xls" onChange={(event) => importFile(event, parseScheduleRows, api.importCourseRoomScheduleRows, 'Course schedule')} />
              </label>
              <button type="button" className="ghost-btn" onClick={() => downloadTemplate('schedule')}>Template</button>
            </div>
          </div>

          <div className="capability-import-card">
            <div className="capability-card-head">
              <strong>Room Sessions</strong>
              <span>{state.availability.length} rows</span>
            </div>
            <small>Columns: Room, Date, Start, End. Availability must fully cover the exam interval.</small>
            <div className="action-row">
              <label className="ghost-btn course-room-upload-btn">
                Import Excel
                <input hidden type="file" accept=".xlsx,.xls" onChange={(event) => importFile(event, parseSessionRows, api.importCourseRoomSessionRows, 'Room sessions')} />
              </label>
              <button type="button" className="ghost-btn" onClick={() => downloadTemplate('sessions')}>Template</button>
            </div>
          </div>

          <div className="capability-import-card">
            <div className="capability-card-head">
              <strong>Room Capacity</strong>
              <span>{state.capacities.length} rows</span>
            </div>
            <small>Columns: Room, MinorCap, MajorCap, RoomType, AutoAvailable.</small>
            <div className="action-row">
              <label className="ghost-btn course-room-upload-btn">
                Import Excel
                <input hidden type="file" accept=".xlsx,.xls" onChange={(event) => importFile(event, parseCapacityRows, api.importCourseRoomCapacityRows, 'Room capacity')} />
              </label>
              <button type="button" className="ghost-btn" onClick={() => downloadTemplate('capacity')}>Template</button>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Settings</h2>
            <p>These settings affect only the Course Room Assignment solver.</p>
          </div>
          <div className="chips-wrap">
            <span className="info-chip">No 10% overflow</span>
            <span className="info-chip">Large groups first</span>
            <span className="info-chip">No Major / Minor mixing</span>
          </div>
        </div>
        <div className="form-grid">
          <label>
            <span>Use AutoAvailable backup rooms</span>
            <select value={settings.useAutoAvailableBackup ? 'yes' : 'no'} onChange={(event) => setSettings((current) => ({ ...current, useAutoAvailableBackup: event.target.value === 'yes' }))}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            <span>Group linked courses</span>
            <select value={settings.groupLinkedCourses ? 'yes' : 'no'} onChange={(event) => setSettings((current) => ({ ...current, groupLinkedCourses: event.target.value === 'yes' }))}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            <span>Allow TH fallback to LAB / DH</span>
            <select value={settings.allowThFallback ? 'yes' : 'no'} onChange={(event) => setSettings((current) => ({ ...current, allowThFallback: event.target.value === 'yes' }))}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            <span>Capacity selection strategy</span>
            <select value={settings.capacityStrategy} onChange={(event) => setSettings((current) => ({ ...current, capacityStrategy: event.target.value }))}>
              <option value="best">Test Major and Minor and choose best</option>
              <option value="major">Major only</option>
              <option value="minor">Minor only</option>
            </select>
          </label>
        </div>
      </section>

      <section className="summary-grid">
        {[
          { label: 'Total Courses', value: state.summary.totalCourses, tone: 'blue' },
          { label: 'Placement Groups', value: state.summary.totalPlacementGroups, tone: 'purple' },
          { label: 'Assigned Groups', value: state.summary.assignedGroups, tone: 'success' },
          { label: 'Assigned With Backup', value: state.summary.assignedWithBackup, tone: 'warning' },
          { label: 'Unassigned Groups', value: state.summary.unassignedGroups, tone: 'danger' },
          { label: 'Capacity Shortage', value: state.summary.capacityShortage, tone: 'warning' },
          { label: 'Waste Capacity', value: state.summary.totalWasteCapacity, tone: 'blue' },
          { label: 'Backup Rooms Used', value: state.summary.backupRoomsUsed, tone: 'purple' },
        ].map((card) => (
          <div key={card.label} className={`summary-card ${card.tone}`}>
            <div className="summary-card-value">{loading ? '...' : card.value}</div>
            <div className="summary-card-label">{card.label}</div>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Solver Visualization</h2>
            <p>Visual summary of the final solver choice, backup usage, room packing, and assignment causes for this module.</p>
          </div>
        </div>

        <div className="summary-grid course-room-visual-grid">
          {solverOutcomeCards.map((card) => (
            <div key={card.label} className={`summary-card ${card.tone}`}>
              <div className="summary-card-value course-room-summary-text">{card.value}</div>
              <div className="summary-card-label">{card.label}</div>
            </div>
          ))}
        </div>
        {qualityLoading ? <div className="empty-state small">Loading quality analysis...</div> : null}

        <div className="course-room-visual-layout">
          <div className="course-room-visual-panel">
            <div className="course-room-visual-title">Assignment Causes</div>
            <div className="course-room-cause-list">
              {causeRows.map((item) => (
                <div key={item.title} className={`course-room-cause-card ${item.tone}`}>
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </div>
              ))}
              {!causeRows.length ? <div className="empty-state">No solver cause data yet.</div> : null}
            </div>
          </div>

          <div className="course-room-visual-panel">
            <div className="course-room-visual-title">Top Room Usage</div>
            <div className="course-room-visual-room-list">
              {(quality.largerRoomBehavior || []).slice(0, 8).map((row) => (
                <div key={`${row.room}|${row.date}|${row.start}`} className="course-room-visual-room-card">
                  <div className="course-room-visual-room-head">
                    <strong>{row.room}</strong>
                    <span className={`report-badge ${row.autoAvailable ? 'warning' : 'success'}`}>{row.autoAvailable ? 'Backup' : 'Normal'}</span>
                  </div>
                  <span>{row.date} | {row.start}</span>
                  <span>Major: {row.majorUsed}/{row.majorCap}</span>
                  <span>Minor: {row.minorUsed}/{row.minorCap}</span>
                  <span>{row.courseCodes || '-'}</span>
                </div>
              ))}
              {!quality.largerRoomBehavior?.length ? <div className="empty-state">No room usage data yet.</div> : null}
            </div>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Courses</th>
                <th>Students</th>
                <th>Assigned</th>
                <th>Shortage</th>
                <th>Date</th>
                <th>Time</th>
                <th>Candidate Rooms</th>
                <th>Normal Capacity</th>
                <th>Backup Capacity</th>
                <th>Theoretical</th>
                <th>Cause</th>
              </tr>
            </thead>
            <tbody>
              {pagedShortageDiagnostics.items.map((row) => (
                <tr key={`${row.placementGroupId}|${row.periodInstance}`}>
                  <td>{row.placementGroupId}</td>
                  <td>{row.courseCodes}</td>
                  <td>{row.totalStudents}</td>
                  <td>{row.assignedStudents}</td>
                  <td>{row.shortage}</td>
                  <td>{row.date}</td>
                  <td>{row.start} - {row.end}</td>
                  <td>{row.candidateRooms}</td>
                  <td>{row.totalCompatibleNormalCapacity}</td>
                  <td>{row.compatibleAutoAvailableCapacity}</td>
                  <td><span className={`report-badge ${row.theoreticallyPlaceable ? 'warning' : 'danger'}`}>{row.theoreticallyPlaceable ? 'Placeable' : 'Not enough'}</span></td>
                  <td>{row.shortageReason}</td>
                </tr>
              ))}
              {!pagedShortageDiagnostics.items.length ? <tr><td colSpan="12" className="empty-cell">{qualityLoading ? 'Loading shortage diagnostics...' : 'No shortage diagnostics. Current results are fully placed or no report is available yet.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {(quality.shortageDiagnostics || []).length > 25 ? (
          <div className="action-row">
            <button type="button" className="ghost-btn" disabled={pagedShortageDiagnostics.page <= 1} onClick={() => setShortagePage((current) => Math.max(1, current - 1))}>Previous</button>
            <span className="info-chip">Shortages page {pagedShortageDiagnostics.page} / {pagedShortageDiagnostics.totalPages}</span>
            <button type="button" className="ghost-btn" disabled={pagedShortageDiagnostics.page >= pagedShortageDiagnostics.totalPages} onClick={() => setShortagePage((current) => Math.min(pagedShortageDiagnostics.totalPages, current + 1))}>Next</button>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Placement Results</h2>
            <p>Each placement group is solved in one capacity mode only, with no Major and Minor mixing across rooms.</p>
          </div>
          <div className="chips-wrap">
            <span className="info-chip">{loading ? 'Loading...' : `${state.results.length} groups`}</span>
            {!loading ? <span className="info-chip">Page {pagedResults.page} / {pagedResults.totalPages}</span> : null}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Group / Course</th>
                <th>Students</th>
                <th>Date</th>
                <th>Time</th>
                <th>Type</th>
                <th>Capacity Mode</th>
                <th>Assigned Rooms</th>
                <th>Assigned Capacity</th>
                <th>Waste</th>
                <th>Shortage</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Manual</th>
              </tr>
            </thead>
            <tbody>
              {pagedResults.items.map((row) => (
                <tr key={row.placementGroupId}>
                  <td>
                    <strong>{row.placementGroupId}</strong>
                    <span className="cell-subtext">{row.courseCodes}</span>
                  </td>
                  <td>{row.totalStudents}</td>
                  <td>{row.date}</td>
                  <td>{row.start} - {row.end}</td>
                  <td>{row.roomPlacementType}</td>
                  <td>{row.capacityMode || '-'}</td>
                  <td>{row.assignedRooms || '-'}</td>
                  <td>{row.assignedCapacity}</td>
                  <td>{row.wasteCapacity}</td>
                  <td>{row.shortage}</td>
                  <td><span className={`report-badge ${resultTone(row.status)}`}>{row.status}</span></td>
                  <td>{row.notes || '-'}</td>
                  <td>
                    <button type="button" className="ghost-btn" onClick={() => openManual(row)}>
                      {selectedGroupId === row.placementGroupId ? 'Close' : 'Manual'}
                    </button>
                  </td>
                </tr>
              ))}
              {!pagedResults.items.length ? <tr><td colSpan="13" className="empty-cell">{loading ? 'Loading placement results...' : 'No placement results yet.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {state.results.length > 25 ? (
          <div className="action-row">
            <button type="button" className="ghost-btn" disabled={pagedResults.page <= 1} onClick={() => setResultsPage((current) => Math.max(1, current - 1))}>Previous</button>
            <span className="info-chip">Results page {pagedResults.page} / {pagedResults.totalPages}</span>
            <button type="button" className="ghost-btn" disabled={pagedResults.page >= pagedResults.totalPages} onClick={() => setResultsPage((current) => Math.min(pagedResults.totalPages, current + 1))}>Next</button>
          </div>
        ) : null}
      </section>

      {selectedResult ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Manual Assignment</h2>
              <p>Editing {selectedResult.placementGroupId} for {selectedResult.courseCodes}. Validation checks room availability, type rules, time conflicts, and single-mode consistency.</p>
            </div>
            <div className="action-row">
              <button type="button" className="primary-btn" onClick={submitManualAssignment}>Save Manual Assignment</button>
              <button type="button" className="ghost-btn" onClick={() => { setSelectedGroupId(''); setManualRooms([]); }}>Cancel</button>
            </div>
          </div>

          <div className="course-room-manual-head">
            <label className="course-room-mode-picker">
              <span>Capacity mode</span>
              <select value={manualMode} onChange={(event) => setManualMode(event.target.value)}>
                <option value="Major">Major</option>
                <option value="Minor">Minor</option>
              </select>
            </label>
            <div className="chips-wrap">
              <span className="info-chip">{selectedResult.date}</span>
              <span className="info-chip">{selectedResult.start} - {selectedResult.end}</span>
              <span className="info-chip">{selectedResult.roomPlacementType}</span>
            </div>
          </div>

          <div className="course-room-room-grid">
            {state.capacities.map((room) => {
              const checked = manualRooms.includes(room.room);
              const capacityValue = manualMode === 'Major' ? room.majorCap : room.minorCap;
              return (
                <label key={room.room} className={`course-room-room-card${checked ? ' selected' : ''}`}>
                  <div className="course-room-room-card-head">
                    <strong>{room.room}</strong>
                    <input type="checkbox" checked={checked} onChange={() => toggleManualRoom(room.room)} />
                  </div>
                  <span>Type: {room.roomType}</span>
                  <span>{manualMode} capacity: {capacityValue}</span>
                  <span>AutoAvailable: {truthy(room.autoAvailable) ? 'Yes' : 'No'}</span>
                </label>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Room Rows By Period</h2>
            <p>Expanded room rows for each solved date and period.</p>
          </div>
        </div>
        <div className="course-room-period-list">
          {pagedRoomPeriods.items.map((period) => (
            <div key={`${period.date}|${period.start}|${period.end}`} className="course-room-period-card">
              <div className="course-room-period-title">{period.date} | {period.start} - {period.end}</div>
              <div className="course-room-period-grid">
                {period.rooms.map((room) => (
                  <div key={`${room.placementGroupId}|${room.room}`} className="course-room-period-room">
                    <strong>{room.room}</strong>
                    <span>{room.placementGroupId}</span>
                    <span>{room.capacityMode} | {room.roomCapacity} seats</span>
                    <span>Assigned here: {room.studentsAssignedToThisRoom}</span>
                    <span>Room total: {room.roomTotalAssignedStudentsAtThisTime}</span>
                    <span>Remaining: {room.roomRemainingCapacityAtThisTime}</span>
                    <span>AutoAvailable: {truthy(room.autoAvailable) ? 'Yes' : 'No'}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!pagedRoomPeriods.items.length ? <div className="empty-state">{loading ? 'Loading room rows...' : 'No room rows yet.'}</div> : null}
        </div>
        {groupedRoomView.length > 12 ? (
          <div className="action-row">
            <button type="button" className="ghost-btn" disabled={pagedRoomPeriods.page <= 1} onClick={() => setRoomRowsPage((current) => Math.max(1, current - 1))}>Previous</button>
            <span className="info-chip">Room periods page {pagedRoomPeriods.page} / {pagedRoomPeriods.totalPages}</span>
            <button type="button" className="ghost-btn" disabled={pagedRoomPeriods.page >= pagedRoomPeriods.totalPages} onClick={() => setRoomRowsPage((current) => Math.min(pagedRoomPeriods.totalPages, current + 1))}>Next</button>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Validation Errors</h2>
            <p>Import and solver validation messages for this module only.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Row</th>
                <th>Field</th>
                <th>Error message</th>
              </tr>
            </thead>
            <tbody>
              {state.validationErrors.map((row, index) => (
                <tr key={`${row.source}-${row.row}-${index}`}>
                  <td>{row.source}</td>
                  <td>{row.row || '-'}</td>
                  <td>{row.field || '-'}</td>
                  <td>{row.errorMessage}</td>
                </tr>
              ))}
              {!state.validationErrors.length ? <tr><td colSpan="4" className="empty-cell">No validation errors.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
