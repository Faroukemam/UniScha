const API_BASE = '/api';
const getCache = new Map();

function cloneApiData(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function clearApiGetCache() {
  getCache.clear();
}

function withQuery(path, query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, value);
    }
  });
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function sanitizeFetchOptions(options = {}) {
  const {
    skipCache,
    useCache,
    ...fetchOptions
  } = options;
  return fetchOptions;
}

export function downloadFile(url, filename = '') {
  if (!url) {
    throw new Error('Download URL is missing.');
  }
  const link = document.createElement('a');
  link.href = url;
  if (filename) {
    link.download = filename;
  }
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function apiFetch(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const shouldUseAppCache = method === 'GET' && options.skipCache !== true && options.useCache !== false;
  const cacheKey = `${method}:${path}`;
  if (shouldUseAppCache && getCache.has(cacheKey)) {
    return cloneApiData(getCache.get(cacheKey));
  }

  const fetchOptions = sanitizeFetchOptions(options);
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {})
    },
    ...fetchOptions
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  const payload = await response.json();
  if (shouldUseAppCache) {
    getCache.set(cacheKey, payload);
  } else if (method !== 'GET') {
    clearApiGetCache();
  }

  return cloneApiData(payload);
}

export const api = {
  getDashboard: () => apiFetch('/dashboard'),
  getStorageStatus: () => apiFetch('/system/storage-status'),
  getSessions: () => apiFetch('/sessions'),
  createSession: (payload) => apiFetch('/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  updateSession: (id, payload) => apiFetch(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteSession: (id) => apiFetch(`/sessions/${id}`, { method: 'DELETE' }),
  deleteAllSessions: () => apiFetch('/sessions', { method: 'DELETE' }),

  getInvigilators: () => apiFetch('/invigilators'),
  createInvigilator: (payload) => apiFetch('/invigilators', { method: 'POST', body: JSON.stringify(payload) }),
  updateInvigilator: (id, payload) => apiFetch(`/invigilators/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteInvigilator: (id) => apiFetch(`/invigilators/${id}`, { method: 'DELETE' }),
  deleteAllInvigilators: () => apiFetch('/invigilators', { method: 'DELETE' }),

  getEngagements: () => apiFetch('/engagements'),
  createEngagement: (payload) => apiFetch('/engagements', { method: 'POST', body: JSON.stringify(payload) }),
  updateEngagement: (id, payload) => apiFetch(`/engagements/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteEngagement: (id) => apiFetch(`/engagements/${id}`, { method: 'DELETE' }),
  deleteAllEngagements: () => apiFetch('/engagements', { method: 'DELETE' }),

  getStaffHourPolicies: () => apiFetch('/staff-hour-policies'),
  saveStaffHourPolicy: (payload) => apiFetch('/staff-hour-policies', { method: 'POST', body: JSON.stringify(payload) }),
  deleteStaffHourPolicy: (id) => apiFetch(`/staff-hour-policies/${id}`, { method: 'DELETE' }),
  deleteAllStaffHourPolicies: () => apiFetch('/staff-hour-policies', { method: 'DELETE' }),
  importStaffHourPoliciesRows: (rows) => apiFetch('/import/staff-hour-policies', { method: 'POST', body: JSON.stringify({ rows }) }),
  exportStaffHourPolicies: () => apiFetch('/export/staff-hour-policies', { skipCache: true }),

  getScheduling: () => apiFetch('/scheduling'),
  getSchedulingEligible: (sessionId) => apiFetch(`/scheduling/session/${encodeURIComponent(sessionId)}/eligible`),
  assignToSession: (payload) => apiFetch('/scheduling/assign', { method: 'POST', body: JSON.stringify(payload) }),
  setSessionAssignmentLock: (id, locked) => apiFetch(`/scheduling/assign/${id}/lock`, { method: 'PATCH', body: JSON.stringify({ locked }) }),
  bulkSetSessionAssignmentLock: (assignmentIds, locked) => apiFetch('/scheduling/assign/bulk-lock', { method: 'PATCH', body: JSON.stringify({ assignmentIds, locked }) }),
  setSessionAssignmentLockByFilter: (payload) => apiFetch('/scheduling/assign/lock-by-filter', { method: 'PATCH', body: JSON.stringify(payload) }),
  exportSchedulingCurrent: () => apiFetch('/scheduling/export/current', { skipCache: true }),
  exportSchedulingAssignmentTemplate: () => apiFetch('/scheduling/export/assignment-template', { skipCache: true }),
  exportCommitteeAssignmentTemplate: () => apiFetch('/scheduling/export/committee-assignment-template', { skipCache: true }),
  importSchedulingAssignmentActions: (rows, dryRun = true, confirmText = '') => apiFetch(withQuery('/scheduling/import/assignment-actions', { dryRun: dryRun ? 'true' : '' }), {
    method: 'POST',
    body: JSON.stringify({ rows, confirmText }),
  }),
  importCommitteeAssignments: (rows, mode = 'append', dryRun = true, confirmationText = '') => apiFetch(withQuery('/scheduling/import/committee-assignments', { dryRun: dryRun ? 'true' : '' }), {
    method: 'POST',
    body: JSON.stringify({ rows, mode, dryRun, confirmationText }),
  }),
  exportAssignmentLockPlan: () => apiFetch('/scheduling/assign/lock-plan/export', { skipCache: true }),
  importAssignmentLockPlan: (rows) => apiFetch('/scheduling/assign/lock-plan/import', { method: 'POST', body: JSON.stringify({ rows }) }),
  removeSessionAssignment: (id) => apiFetch(`/scheduling/assign/${id}`, { method: 'DELETE' }),
  removeAllSessionAssignments: () => apiFetch('/scheduling/assign', { method: 'DELETE' }),
  autoSchedulePreview: (mode = 'preserve_all', roleScope = 'both') => apiFetch('/scheduling/auto-schedule-preview', { method: 'POST', body: JSON.stringify({ mode, roleScope }) }),
  exportAutoSchedulePreview: (mode = 'preserve_all', roleScope = 'both') => apiFetch('/scheduling/auto-schedule-preview/export', { method: 'POST', body: JSON.stringify({ mode, roleScope }), skipCache: true }),
  autoSchedule: (mode = 'preserve_manual_only', roleScope = 'both') => apiFetch('/scheduling/auto-schedule', { method: 'POST', body: JSON.stringify({ mode, roleScope }) }),

  getOnCall: () => apiFetch('/on-call'),
  saveOnCallConfig: (payload) => apiFetch('/on-call/config', { method: 'PATCH', body: JSON.stringify(payload) }),
  getOnCallEligible: (date, startTime, endTime) => apiFetch(withQuery('/on-call/eligible', { date, startTime, endTime })),
  autoAssignOnCall: (dryRun = false) => apiFetch('/on-call/auto-assign', { method: 'POST', body: JSON.stringify({ dryRun }) }),
  assignOnCall: (payload) => apiFetch('/on-call/assign', { method: 'POST', body: JSON.stringify(payload) }),
  removeOnCallAssignment: (id) => apiFetch(`/on-call/assign/${id}`, { method: 'DELETE' }),
  removeAllOnCallAssignments: () => apiFetch('/on-call/assign', { method: 'DELETE' }),

  getSuperInvigilators: () => apiFetch('/super-invigilators'),
  exportSuperInvigilators: () => apiFetch('/super-invigilators/export', { skipCache: true }),
  assignSuperInvigilator: (payload) => apiFetch('/super-invigilators/assign', { method: 'POST', body: JSON.stringify(payload) }),
  removeSuperInvigilator: (id) => apiFetch(`/super-invigilators/${id}`, { method: 'DELETE' }),
  removeAllSuperInvigilators: () => apiFetch('/super-invigilators', { method: 'DELETE' }),

  getControlSessions: () => apiFetch('/control-sessions'),
  exportControlSessions: () => apiFetch('/control-sessions/export', { skipCache: true }),
  exportControlSessionTemplate: () => apiFetch('/control-sessions/template/export', { skipCache: true }),
  createControlSession: (payload) => apiFetch('/control-sessions', { method: 'POST', body: JSON.stringify(payload) }),
  updateControlSession: (id, payload) => apiFetch(`/control-sessions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteControlSession: (id) => apiFetch(`/control-sessions/${id}`, { method: 'DELETE' }),
  assignControlSession: (payload) => apiFetch('/control-sessions/assign', { method: 'POST', body: JSON.stringify(payload) }),
  removeControlSessionAssignment: (id) => apiFetch(`/control-sessions/assign/${id}`, { method: 'DELETE' }),
  removeAllControlSessions: () => apiFetch('/control-sessions', { method: 'DELETE' }),
  importControlSessionLoadRows: (rows) => apiFetch('/import/control-session-loads', { method: 'POST', body: JSON.stringify({ rows }) }),

  getWorkload: () => apiFetch('/workload'),
  getDayCoverage: () => apiFetch('/day-coverage'),
  exportData: () => apiFetch('/data/export'),
  importData: (data) => apiFetch('/data/import', { method: 'POST', body: JSON.stringify({ data }) }),
  resetData: () => apiFetch('/data/reset', { method: 'DELETE' }),
  importSessionsRows: (rows) => apiFetch('/import/sessions', { method: 'POST', body: JSON.stringify({ rows }) }),
  importSessionNeedsRows: (rows) => apiFetch('/import/session-needs', { method: 'POST', body: JSON.stringify({ rows }) }),
  importControlSessionsRows: (rows) => apiFetch('/import/control-sessions', { method: 'POST', body: JSON.stringify({ rows }) }),
  importInvigilatorsRows: (rows) => apiFetch('/import/invigilators', { method: 'POST', body: JSON.stringify({ rows }) }),
  importEngagementRows: (rows) => apiFetch('/import/engagements', { method: 'POST', body: JSON.stringify({ rows }) }),
  loadSampleData: () => apiFetch('/data/load-sample', { method: 'POST' }),
  exportWorkbook: () => apiFetch('/export/workbook', { skipCache: true }),
  optimizeRoomCapability: (payload) => apiFetch('/room-capability/optimize', { method: 'POST', body: JSON.stringify(payload) }),

  getReportsSummary: (query) => apiFetch(withQuery('/reports/summary', query)),
  getReportsWorkload: (query) => apiFetch(withQuery('/reports/workload', query)),
  getReportsFairness: (query) => apiFetch(withQuery('/reports/fairness', query)),
  getReportsDailyCoverage: (query) => apiFetch(withQuery('/reports/daily-coverage', query)),
  getReportsRoomShortage: (query) => apiFetch(withQuery('/reports/room-shortage', query)),
  getReportsConflicts: (query) => apiFetch(withQuery('/reports/conflicts', query)),
  getReportsDetailedLoad: (query) => apiFetch(withQuery('/reports/detailed-load', query)),
  getReportsStaff: (staffId, query) => apiFetch(withQuery(`/reports/staff/${staffId}`, query)),
  getReportsSessionCoverage: (query) => apiFetch(withQuery('/reports/session-coverage', query)),
  getReportsUtilization: (query) => apiFetch(withQuery('/reports/utilization', query)),
  getReportsQualityScore: (query) => apiFetch(withQuery('/reports/quality-score', query)),

  getCourseRoomAssignment: () => apiFetch('/course-room-assignment'),
  getCourseRoomQuality: () => apiFetch('/course-room-assignment/quality'),
  importCourseRoomScheduleRows: (rows) => apiFetch('/course-room-assignment/import-schedule', { method: 'POST', body: JSON.stringify({ rows }) }),
  importCourseRoomSessionRows: (rows) => apiFetch('/course-room-assignment/import-room-sessions', { method: 'POST', body: JSON.stringify({ rows }) }),
  importCourseRoomCapacityRows: (rows) => apiFetch('/course-room-assignment/import-room-capacity', { method: 'POST', body: JSON.stringify({ rows }) }),
  runCourseRoomAssignment: (settings) => apiFetch('/course-room-assignment/run', { method: 'POST', body: JSON.stringify(settings) }),
  manualAssignCourseRoom: (payload) => apiFetch('/course-room-assignment/manual-assign', { method: 'POST', body: JSON.stringify(payload) }),
  clearCourseRoomResults: () => apiFetch('/course-room-assignment/results', { method: 'DELETE' }),
  exportCourseRoomAssignment: () => apiFetch('/course-room-assignment/export'),
  exportCourseRoomUnassigned: () => apiFetch('/course-room-assignment/export-unassigned'),
  clearCache: clearApiGetCache,
};
