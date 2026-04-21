const API_BASE = '/api';

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

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  getDashboard: () => apiFetch('/dashboard'),
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

  getScheduling: () => apiFetch('/scheduling'),
  assignToSession: (payload) => apiFetch('/scheduling/assign', { method: 'POST', body: JSON.stringify(payload) }),
  removeSessionAssignment: (id) => apiFetch(`/scheduling/assign/${id}`, { method: 'DELETE' }),
  removeAllSessionAssignments: () => apiFetch('/scheduling/assign', { method: 'DELETE' }),
  autoSchedule: () => apiFetch('/scheduling/auto-schedule', { method: 'POST' }),

  getSuperInvigilators: () => apiFetch('/super-invigilators'),
  assignSuperInvigilator: (payload) => apiFetch('/super-invigilators/assign', { method: 'POST', body: JSON.stringify(payload) }),
  removeSuperInvigilator: (id) => apiFetch(`/super-invigilators/${id}`, { method: 'DELETE' }),
  removeAllSuperInvigilators: () => apiFetch('/super-invigilators', { method: 'DELETE' }),

  getControlSessions: () => apiFetch('/control-sessions'),
  createControlSession: (payload) => apiFetch('/control-sessions', { method: 'POST', body: JSON.stringify(payload) }),
  updateControlSession: (id, payload) => apiFetch(`/control-sessions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteControlSession: (id) => apiFetch(`/control-sessions/${id}`, { method: 'DELETE' }),
  assignControlSession: (payload) => apiFetch('/control-sessions/assign', { method: 'POST', body: JSON.stringify(payload) }),
  removeControlSessionAssignment: (id) => apiFetch(`/control-sessions/assign/${id}`, { method: 'DELETE' }),
  removeAllControlSessions: () => apiFetch('/control-sessions', { method: 'DELETE' }),

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
  exportWorkbook: () => apiFetch('/export/workbook'),
  optimizeRoomCapability: (payload) => apiFetch('/room-capability/optimize', { method: 'POST', body: JSON.stringify(payload) }),

  getReportsSummary: (query) => apiFetch(withQuery('/reports/summary', query)),
  getReportsWorkload: (query) => apiFetch(withQuery('/reports/workload', query)),
  getReportsFairness: (query) => apiFetch(withQuery('/reports/fairness', query)),
  getReportsDailyCoverage: (query) => apiFetch(withQuery('/reports/daily-coverage', query)),
  getReportsConflicts: (query) => apiFetch(withQuery('/reports/conflicts', query)),
  getReportsStaff: (staffId, query) => apiFetch(withQuery(`/reports/staff/${staffId}`, query)),
  getReportsSessionCoverage: (query) => apiFetch(withQuery('/reports/session-coverage', query)),
  getReportsUtilization: (query) => apiFetch(withQuery('/reports/utilization', query)),
  getReportsQualityScore: (query) => apiFetch(withQuery('/reports/quality-score', query)),
};
