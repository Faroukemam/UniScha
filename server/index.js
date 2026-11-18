const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const { randomUUID } = require('node:crypto');

function normalizeNeedsRow(row) {
  const fields = new Map(Object.entries(row).map(([key, value]) => [
    key.trim().toLowerCase().replace(/[\s_-]+/g, ''), value,
  ]));
  const read = (...names) => names.map((name) => fields.get(name)).find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  return {
    SessionID: read('sessionid', 'id'),
    Room: read('roomplacement', 'room'),
    Date: read('date', 'examdate'),
    Day: read('day'),
    Start: read('start', 'starttime', 'roomstart'),
    End: read('end', 'endtime', 'roomend'),
    CourseCode: read('coursecode', 'coursenames', 'coursename'),
    TANeeded: read('taneeded', 'tasneeded'),
    DoctorNeeded: read('doctorneeded', 'doctorsneeded'),
    InvigilatorsNeeded: read('invigilatorsneeded', 'totalneeded', 'totalstaff'),
  };
}

function validateNeedsRow(row) {
  const counts = [row.TANeeded, row.DoctorNeeded, row.InvigilatorsNeeded];
  if (counts.every((value) => value === undefined)) return 'missing_needs_columns';
  if (counts.some((value) => value !== undefined && (!Number.isSafeInteger(Number(value)) || Number(value) < 0))) {
    return 'invalid_needs_count';
  }
  if (row.TANeeded === undefined && row.DoctorNeeded === undefined) return 'missing_role_needs';
  return '';
}
const {
  readStore,
  writeStore,
  initStoreFromPrimary,
  restoreStoreFromDbIfNeeded,
  getStorageStatus,
  getStartupStorageInfo,
  generateId,
  getDayWindows,
  getSessionRoomStartKey,
  getSessionRoomStartCourseKey,
  getSessionRoomTimeKey,
  parseTimeToMinutes,
  getDurationMinutes,
  getStoreVersion,
  getCachedDerivedView,
  getEligibilityForSession,
  getEligibilityForOnCall,
  buildSchedulingIndexes,
  buildSchedulingView,
  buildSchedulingEligibilityView,
  buildOnCallNeeds,
  buildOnCallSummary,
  buildOnCallView,
  buildOnCallEligibilityView,
  buildDutyCollections,
  buildStaffContinuityView,
  buildWorkloadView,
  buildStaffHourPolicySummary,
  normalizeStaffHourPolicyRow,
  normalizeAssignmentMetadata,
  normalizeOnCallConfig,
  normalizeSchedulingConfig,
  SCHEDULING_PREFERENCES,
} = require('./store');
const {
  buildReportsSummary,
  buildWorkloadReport,
  buildFairnessReport,
  buildDailyCoverageReport,
  buildConflictReport,
  buildEngagementOverrideReport,
  buildStaffReport,
  buildDetailedLoadReport,
  buildSessionCoverageReport,
  buildRoomShortageReport,
  buildUtilizationReport,
  buildQualityScoreReport,
} = require('./reports');
const {
  getCourseRoomAssignmentState,
  importScheduleRows: importCourseRoomScheduleRows,
  importRoomSessionRows: importCourseRoomSessionRows,
  importRoomCapacityRows: importCourseRoomCapacityRows,
  runCourseRoomAssignment,
  clearCourseRoomResults,
  manualAssignCourseRoom,
  exportCourseRoomAssignment,
  exportCourseRoomUnassigned,
  getCourseRoomQuality,
} = require('./courseRoomAssignment');

const app = express();
const PORT = process.env.PORT || 3001;
const tempDir = path.join(__dirname, 'temp');

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

app.use(cors());
// Excel files are parsed in the browser then sent as JSON rows.  A workbook can
// be small on disk but expand considerably once serialized, so keep a practical
// import limit and return a JSON error when it is exceeded.
const IMPORT_JSON_LIMIT = process.env.IMPORT_JSON_LIMIT || '50mb';
app.use(express.json({ limit: IMPORT_JSON_LIMIT }));
app.use('/temp', express.static(tempDir));
app.use('/api/temp', express.static(tempDir));

// Validate manual record changes before they reach the shared scheduling store.
// Imports have their own row validation and do not pass through this middleware.
app.use((req, res, next) => {
  const match = req.path.match(/^\/api\/(sessions|control-sessions|invigilators|engagements)(?:\/([^/]+))?$/);
  if (!match || !((req.method === 'POST' && !match[2]) || (req.method === 'PUT' && match[2]))) return next();
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return respondError(res, 'A record object is required.');
  const collection = { sessions: 'sessions', 'control-sessions': 'controlSessions', invigilators: 'invigilators', engagements: 'engagements' }[match[1]];
  const store = readStore();
  const existing = match[2] ? store[collection].find((row) => row.id === match[2]) : null;
  if (match[2] && !existing) return next(); // Preserve the route's not-found response.
  const row = { ...existing, ...req.body };
  const validNumber = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
  if (collection === 'invigilators') {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) return respondError(res, 'A staff name is required.');
    if (!['TA', 'Doctor'].includes(row.role)) return respondError(res, 'Role must be TA or Doctor.');
    if (row.maxHours !== undefined && (!validNumber(row.maxHours) || Number(row.maxHours) < 0)) return respondError(res, 'Maximum hours must be a non-negative number.');
    const staffId = String(req.body.staffId || existing?.staffId || row.name).trim();
    if (!staffId || store.invigilators.some((person) => person.id !== existing?.id && String(person.staffId).trim() === staffId)) return respondError(res, 'Staff ID must be unique.');
  } else {
    const date = normalizeDate(row.date);
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T00:00:00Z') : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return respondError(res, 'A valid calendar date is required.');
    const start = normalizeTime(row.startTime), end = normalizeTime(row.endTime);
    const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(start) || !validTime(end) || end <= start) return respondError(res, 'End time must be after start time on the same day.');
    if (collection === 'engagements') {
      const staffId = String(row.staffId || '').trim();
      if (!store.invigilators.some((person) => String(person.staffId || person.id) === staffId)) return respondError(res, 'Select an existing staff member.');
      if (![0, 1].includes(Number(row.engagement ?? 1))) return respondError(res, 'Engagement must be 0 or 1.');
    } else {
      for (const field of ['taNeeded', 'doctorNeeded', 'totalNeeded']) {
        if (row[field] !== undefined && (!validNumber(row[field]) || !Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0)) return respondError(res, 'Staffing counts must be non-negative whole numbers.');
      }
    }
  }
  return next();
});

const PERF_LOG = process.env.PERF_LOG === '1';

function perfNow() {
  return process.hrtime.bigint();
}

function perfMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function formatPerfBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function sendJsonWithPerf(req, res, payload, metrics = {}) {
  const serializeStart = perfNow();
  const body = JSON.stringify(payload);
  const serialize = perfMs(serializeStart);
  const total = metrics.totalMs ?? 0;
  if (PERF_LOG) {
    console.log(
      `[perf] ${req.method} ${req.path} total=${total.toFixed(1)}ms readStore=${(metrics.readStoreMs ?? 0).toFixed(1)}ms build=${(metrics.buildMs ?? 0).toFixed(1)}ms serialize=${serialize.toFixed(1)}ms size=${formatPerfBytes(Buffer.byteLength(body))} cache=${metrics.cacheStatus || 'n/a'}`
    );
  }
  res.type('application/json').send(body);
}

function getCachedRoutePayload(name, cacheKey, builder) {
  const version = getStoreVersion();
  const fullKey = cacheKey ? `${name}|${cacheKey}` : name;
  const value = getCachedDerivedView(fullKey, builder);
  return { version, value };
}

function respondError(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

function readImportRows(req, res, label) {
  if (!req.body || !Array.isArray(req.body.rows)) {
    respondError(res, `${label} import must contain a rows array.`);
    return null;
  }

  const rows = req.body.rows;
  if (!rows.length) {
    respondError(res, `${label} import contains no data rows. Select a worksheet with headers and at least one record.`);
    return null;
  }

  const invalidRow = rows.findIndex((row) => !row || typeof row !== 'object' || Array.isArray(row));
  if (invalidRow >= 0) {
    respondError(res, `${label} import row ${invalidRow + 2} is not a valid spreadsheet record.`);
    return null;
  }

  return rows;
}

function respondPersistenceError(res, error) {
  if (error.status === 409) return res.status(409).json({ error: error.message });
  console.error('[storage] write failed:', error);
  return res.status(500).json({
    error: 'Failed to persist data.',
    details: error.message,
  });
}

function persistStoreResponse(res, store, payload) {
  return writeStore(store)
    .then(() => (typeof payload === 'function' ? payload() : res.json(payload)))
    .catch((error) => respondPersistenceError(res, error));
}

function getPreviewAssignmentModeSupport(store) {
  const supportsPreserveManualOnly = (store.assignments || []).every((item) =>
    Object.prototype.hasOwnProperty.call(item, 'locked')
    || Object.prototype.hasOwnProperty.call(item, 'assignmentSource')
  );
  return {
    supportsPreserveManualOnly,
    reason: supportsPreserveManualOnly
      ? ''
      : 'preserve_manual_only is not supported because assignments do not currently store manual/auto/locked metadata. Recommended future field: assignmentSource or locked.',
  };
}

function shouldPreserveAssignmentForManualOnly(assignment) {
  const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
  return normalized.locked === true;
}

function buildLockedAssignmentsFromStore(store, selector) {
  const invigilatorById = new Map(store.invigilators.map((item) => [item.id, item]));
  return (store.assignments || [])
    .map((item) => normalizeAssignmentMetadata(item, { sourceFallback: 'legacy', lockedFallback: true }))
    .filter((item) => selector(item))
    .map((item) => {
      const person = invigilatorById.get(item.invigilatorId);
      return {
        staff_id: String(person?.staffId || item.invigilatorId || ''),
        session_id: item.sessionId,
        role: item.role,
      };
    })
    .filter((item) => item.staff_id && item.session_id);
}

function getLockedAssignmentPreviewSummary(store, mode) {
  const normalizedAssignments = (store.assignments || []).map((item) =>
    normalizeAssignmentMetadata(item, { sourceFallback: 'legacy', lockedFallback: true })
  );
  const lockedAssignments = mode === 'rebalance_all'
    ? []
    : normalizedAssignments.filter((item) => mode === 'preserve_all' || shouldPreserveAssignmentForManualOnly(item));
  return {
    lockedAssignments,
    actualLockedPreservedCount: lockedAssignments.filter((item) => item.locked).length,
    preservedManualLockedAssignments: lockedAssignments.filter((item) => item.assignmentSource === 'manual' && item.locked).length,
    preservedImportLockedAssignments: lockedAssignments.filter((item) => item.assignmentSource === 'import' && item.locked).length,
    preservedLegacyLockedAssignments: lockedAssignments.filter((item) => item.assignmentSource === 'legacy' && item.locked).length,
    replaceableLegacyUnlockedAssignments: normalizedAssignments.filter((item) => item.assignmentSource === 'legacy' && !item.locked).length,
    replaceableManualUnlockedAssignments: normalizedAssignments.filter((item) => item.assignmentSource === 'manual' && !item.locked).length,
    replaceableImportUnlockedAssignments: normalizedAssignments.filter((item) => item.assignmentSource === 'import' && !item.locked).length,
    replaceableAutoUnlockedAssignments: normalizedAssignments.filter((item) => item.assignmentSource === 'auto' && !item.locked).length,
  };
}

function buildAutoSchedulePayload(store) {
  return buildAutoSchedulePayloadForMode(store, 'preserve_all', 'both');
}

function normalizeRoleScope(value) {
  const raw = String(value || 'both').trim().toLowerCase();
  if (['both', 'ta_only', 'doctor_only'].includes(raw)) {
    return raw;
  }
  return 'both';
}

function normalizePreviewMode(value) {
  const raw = String(value || 'preserve_all').trim().toLowerCase();
  if (['preserve_all', 'preserve_manual_only', 'rebalance_all'].includes(raw)) {
    return raw;
  }
  return 'preserve_all';
}

function shouldPreserveByRoleScope(assignment, roleScope) {
  if (roleScope === 'ta_only') {
    return assignment.role === 'Doctor';
  }
  if (roleScope === 'doctor_only') {
    return assignment.role === 'TA';
  }
  return false;
}

function buildAutoSchedulePayloadForMode(store, mode = 'preserve_all', roleScope = 'both') {
  const normalizedRoleScope = normalizeRoleScope(roleScope);
  const { dayWindows } = buildDutyCollections(store);
  const dayWindowMap = new Map(dayWindows.map((item) => [item.date, item]));
  const controlSessionMap = new Map(store.controlSessions.map((item) => [item.id, item]));
  const invigilatorById = new Map(store.invigilators.map((item) => [item.id, item]));
  const hourPolicySummary = buildStaffHourPolicySummary(store);
  const assignmentModeSupport = getPreviewAssignmentModeSupport(store);

  if (mode === 'preserve_manual_only' && !assignmentModeSupport.supportsPreserveManualOnly) {
    const error = new Error(assignmentModeSupport.reason);
    error.status = 'UNSUPPORTED_PREVIEW_MODE';
    throw error;
  }

  const normalizedAssignments = (store.assignments || []).map((item) =>
    normalizeAssignmentMetadata(item, { sourceFallback: 'legacy', lockedFallback: true })
  );
  const previewLockSummary = getLockedAssignmentPreviewSummary(store, mode);
  const roleScopePreservedAssignments = normalizedRoleScope === 'both'
    ? []
    : normalizedAssignments.filter((item) => shouldPreserveByRoleScope(item, normalizedRoleScope));
  const lockedAssignments = buildLockedAssignmentsFromStore(
    store,
    (item) => {
      if (mode === 'preserve_all') return true;
      if (shouldPreserveByRoleScope(item, normalizedRoleScope)) return true;
      if (mode === 'preserve_manual_only') return shouldPreserveAssignmentForManualOnly(item);
      return false;
    }
  );

  const generatedBusyEngagements = [
    ...store.superAssignments
      .map((item) => {
        const window = dayWindowMap.get(item.date);
        const person = invigilatorById.get(item.invigilatorId);
        if (!window || !person) return null;
        return {
          staff_id: String(person.staffId || person.id),
          exam_date: item.date,
          start_time: window.startTime,
          end_time: window.endTime,
          engagement: 1,
        };
      })
      .filter(Boolean),
    ...store.controlAssignments
      .map((item) => {
        const controlSession = controlSessionMap.get(item.controlSessionId);
        const person = invigilatorById.get(item.invigilatorId);
        if (!controlSession || !person) return null;
        return {
          staff_id: String(person.staffId || person.id),
          exam_date: controlSession.date,
          start_time: controlSession.startTime,
          end_time: controlSession.endTime,
          engagement: 1,
        };
      })
      .filter(Boolean),
    ...(store.onCallAssignments || [])
      .map((item) => {
        const person = invigilatorById.get(item.invigilatorId);
        if (!person) return null;
        return {
          staff_id: String(person.staffId || person.id),
          exam_date: item.date,
          start_time: item.startTime,
          end_time: item.endTime,
          engagement: 1,
        };
      })
      .filter(Boolean)
  ];

  const payload = {
    sessions: store.sessions.map((item) => ({
      id: item.id,
      exam_date: item.date,
      start_time: item.startTime,
      end_time: item.endTime,
      ta_needed: normalizedRoleScope === 'doctor_only' ? 0 : Number(item.taNeeded || 0),
      doctor_needed: normalizedRoleScope === 'ta_only' ? 0 : Number(item.doctorNeeded || 0)
    })),
    invigilators: store.invigilators.map((item) => ({
      staff_id: String(item.staffId || item.id),
      role: item.role,
      load_type: item.loadType || 'full',
      max_hours: Number(item.maxHours || 0),
      prefer_consecutive_duties: Boolean(hourPolicySummary.effectivePolicyByInvigilatorId.get(item.id)?.preferConsecutiveDuties),
      prefer_consecutive_days: Boolean(hourPolicySummary.effectivePolicyByInvigilatorId.get(item.id)?.preferConsecutiveDays),
      allow_engagement_override: hourPolicySummary.effectivePolicyByInvigilatorId.get(item.id)?.allowEngagementOverride ?? true,
    })),
    engagements: store.engagements.map((item) => ({
      staff_id: String(item.staffId || ''),
      exam_date: item.date,
      start_time: item.startTime,
      end_time: item.endTime,
      engagement: Number(item.engagement ?? 1),
      allow_override: hourPolicySummary.effectivePolicyByInvigilatorId.get((store.invigilators.find((person) => String(person.staffId || person.id) === String(item.staffId)))?.id)?.allowEngagementOverride ?? true
    })).concat(generatedBusyEngagements.map((item) => ({ ...item, hard_conflict: true }))),
    locked_assignments: lockedAssignments,
    staff_hour_policies: (store.staffHourPolicies || []).map((item) => ({
      staff_id: String(item.staffId || invigilatorById.get(item.invigilatorId)?.staffId || ''),
      role: item.role,
      mode: item.mode,
      hours_value: Number(item.hoursValue || 0),
      exclude_from_auto_schedule: Boolean(item.excludeFromAutoSchedule || item.mode === 'exclude'),
      prefer_consecutive_duties: Boolean(item.preferConsecutiveDuties),
      prefer_consecutive_days: Boolean(item.preferConsecutiveDays),
      allow_engagement_override: item.allowEngagementOverride ?? true,
      notes: item.notes || '',
    })).filter((item) => item.staff_id),
    existing_duty_minutes_by_staff: (() => {
      const fixedDutyMinutesByStaff = {};
      const { superDuties, controlDuties, onCallDuties } = buildDutyCollections(store);
      [...superDuties, ...controlDuties, ...onCallDuties].forEach((duty) => {
        const person = invigilatorById.get(duty.invigilatorId);
        const staffId = String(person?.staffId || duty.invigilatorId || '').trim();
        if (!staffId) return;
        fixedDutyMinutesByStaff[staffId] = Number(fixedDutyMinutesByStaff[staffId] || 0) + Number(duty.durationMinutes || 0);
      });
      return fixedDutyMinutesByStaff;
    })(),
    fixed_duties: (() => {
      const { superDuties, controlDuties, onCallDuties } = buildDutyCollections(store);
      return [...superDuties, ...controlDuties, ...onCallDuties]
        .filter((duty) => duty.date && duty.startTime && duty.endTime)
        .map((duty) => ({ staff_id: String(invigilatorById.get(duty.invigilatorId)?.staffId || duty.invigilatorId), exam_date: duty.date, start_time: duty.startTime, end_time: duty.endTime, duty_type: duty.dutyType === 'OnCall' ? 'on_call' : duty.dutyType.toLowerCase() }));
    })(),
    additional_required_minutes_by_role: (() => {
      const totals = { TA: 0, Doctor: 0 };
      (store.controlSessions || []).forEach((item) => {
        const durationMinutes = getDurationMinutes(item.startTime, item.endTime);
        totals.TA += Number(item.taNeeded || 0) * durationMinutes;
        totals.Doctor += Number(item.doctorNeeded || 0) * durationMinutes;
      });
      buildOnCallNeeds(store).forEach((item) => {
        const durationMinutes = Number(item.durationMinutes || getDurationMinutes(item.startTime, item.endTime));
        totals.TA += Number(item.onCallTANeeded || 0) * durationMinutes;
        totals.Doctor += Number(item.onCallDoctorNeeded || 0) * durationMinutes;
      });
      // Fixed assignments of the unselected role still use that role's full
      // demand when calculating average-based policies.
      if (normalizedRoleScope !== 'both') {
        store.sessions.forEach((item) => {
          const durationMinutes = getDurationMinutes(item.startTime, item.endTime);
          if (normalizedRoleScope === 'ta_only') totals.Doctor += Number(item.doctorNeeded || 0) * durationMinutes;
          if (normalizedRoleScope === 'doctor_only') totals.TA += Number(item.taNeeded || 0) * durationMinutes;
        });
      }
      return totals;
    })(),
    options: {
      time_limit_seconds: 60,
      coverage_weight: 1000000,
      max_load_weight: 1000,
      spread_weight: 500,
      imbalance_weight: 100,
      variance_weight: 20,
      duty_weight: 0,
      daily_penalty_weight: 5,
      max_sessions_per_day_soft: normalizeSchedulingConfig(store.schedulingConfig).dailySoftTarget,
      preference_order: normalizeSchedulingConfig(store.schedulingConfig).preferenceOrder,
      scoring_mode: normalizeSchedulingConfig(store.schedulingConfig).scoringMode,
      preference_weights: normalizeSchedulingConfig(store.schedulingConfig).weights
    }
  };

  payload.__preview_mode = mode;
  payload.__role_scope = normalizedRoleScope;
  payload.__preview_lock_summary = previewLockSummary;
  payload.__role_scope_summary = {
    preservedByRoleScopeCount: roleScopePreservedAssignments.length,
    preservedDoctorAssignments: roleScopePreservedAssignments.filter((item) => item.role === 'Doctor').length,
    preservedTAAssignments: roleScopePreservedAssignments.filter((item) => item.role === 'TA').length,
  };

  return { payload, hourPolicySummary, previewMode: mode, roleScope: normalizedRoleScope, assignmentModeSupport };
}

function runAutoScheduleSolver(payload) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scripts', 'auto_schedule.py');
    const child = spawn('python', [scriptPath], { cwd: path.join(__dirname, '..') });
    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(error.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      try {
        const result = JSON.parse(stdout || '{}');
        if (result.error) {
          const error = new Error(result.error);
          error.details = result.details || [];
          error.status = result.status || 'ERROR';
          reject(error);
          return;
        }
        if (code !== 0 || !Array.isArray(result.assignments)) {
          reject(new Error(stderr || `Auto-scheduler returned no usable result (exit ${code}).`));
          return;
        }
        resolve(result);
      } catch (error) {
        reject(new Error(stderr || error.message));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// A plan contains both duty types, solved together and saved without rerunning.
const combinedSchedulingPlans = new Map();
const COMBINED_PLAN_TTL_MS = 10 * 60 * 1000;
const sessionSchedulingPlans = new Map();

function getSessionSchedulingPlan(token) {
  const planToken = String(token || '');
  const plan = sessionSchedulingPlans.get(planToken);
  if (!plan || plan.expiresAt <= Date.now()) {
    sessionSchedulingPlans.delete(planToken);
    const error = new Error('Preview expired or is unavailable. Run preview again.');
    error.status = 409;
    throw error;
  }
  if (plan.version !== getStoreVersion()) {
    const error = new Error('Data changed since this preview. Run preview again before saving or exporting.');
    error.status = 409;
    throw error;
  }
  return plan;
}

function buildCombinedSchedulingPayload(store, mode, roleScope, dutyScope = 'combined', policyMode = 'strict', shortageExcludedInvigilatorIds = []) {
  const withoutOnCall = { ...store, onCallAssignments: [] };
  const built = buildAutoSchedulePayloadForMode(withoutOnCall, dutyScope === 'on_call' ? 'preserve_all' : mode, roleScope);
  const relaxed = policyMode === 'cover_shortage';
  const selectedRole = (role) => roleScope === 'both' || (roleScope === 'ta_only' ? role === 'TA' : role === 'Doctor');
  built.payload.invigilators.forEach((person) => { person.shortage_override = relaxed && selectedRole(person.role) && !person.prefer_consecutive_duties && !person.prefer_consecutive_days && !person.allow_engagement_override; });
  const excludedStaffIds = new Set(store.invigilators.filter((person) => shortageExcludedInvigilatorIds.includes(person.id)).map((person) => String(person.staffId || person.id)));
  built.payload.invigilators.forEach((person) => { person.exclude_new_assignments = relaxed && excludedStaffIds.has(person.staff_id); });
  // Engagement permission comes only from the staff checkbox, even in
  // shortage mode. Generated busy times and duty overlaps remain hard.
  if (dutyScope === 'on_call') {
    built.payload.sessions.forEach((session) => {
      built.payload.additional_required_minutes_by_role.TA += session.ta_needed * getDurationMinutes(session.start_time, session.end_time);
      built.payload.additional_required_minutes_by_role.Doctor += session.doctor_needed * getDurationMinutes(session.start_time, session.end_time);
      session.ta_needed = 0;
      session.doctor_needed = 0;
    });
  }
  const config = normalizeOnCallConfig(store.onCallConfig);
  const periods = new Map();
  const sessionIds = new Set(store.sessions.map((item) => String(item.id)));
  const personById = new Map(store.invigilators.map((person) => [person.id, person]));
  built.payload.invigilators.forEach((person) => {
    const stored = store.invigilators.find((item) => String(item.staffId || item.id) === person.staff_id);
    person.on_call_excluded = config.excludedInvigilatorIds.includes(stored?.id);
  });
  buildOnCallNeeds(store).forEach((period) => {
    const id = `__on_call__|${period.periodKey}`;
    if (sessionIds.has(id)) throw new Error('Session identifier conflicts with an on-call period identifier.');
    periods.set(id, period);
    const taNeeded = roleScope === 'doctor_only' ? 0 : period.onCallTANeeded;
    const doctorNeeded = roleScope === 'ta_only' ? 0 : period.onCallDoctorNeeded;
    built.payload.sessions.push({ id, exam_date: period.date, start_time: period.startTime, end_time: period.endTime, ta_needed: taNeeded, doctor_needed: doctorNeeded, duty_type: 'on_call' });
    // These needs are now modeled directly, so do not count them twice in targets.
    built.payload.additional_required_minutes_by_role.TA -= taNeeded * period.durationMinutes;
    built.payload.additional_required_minutes_by_role.Doctor -= doctorNeeded * period.durationMinutes;
  });
  const preservedOnCall = (store.onCallAssignments || []).filter((assignment) => mode !== 'rebalance_all' || shouldPreserveByRoleScope(assignment, roleScope));
  preservedOnCall.forEach((assignment) => {
    const id = `__on_call__|${assignment.date}|${assignment.startTime}|${assignment.endTime}`;
    const person = personById.get(assignment.invigilatorId);
    if (!periods.has(id) || !person) throw new Error('An existing on-call assignment has no matching period or staff member. Review it before building a combined plan.');
    built.payload.locked_assignments.push({ session_id: id, staff_id: String(person.staffId || person.id), role: assignment.role });
  });
  return { ...built, periods, preservedOnCall };
}

function summarizeCombinedPlan(store, assignments, onCallAssignments, solver, policyMode = 'strict') {
  const next = { ...store, assignments, onCallAssignments };
  const gaps = (source) => {
    const sessions = buildSchedulingView(source).sessions;
    const sessionGaps = sessions.reduce((sum, item) => sum + Number(item.taRemaining || 0) + Number(item.doctorRemaining || 0), 0);
    return { sessions: sessionGaps, onCall: buildOnCallSummary(source).totalShortage };
  };
  const before = gaps(store);
  const after = gaps(next);
  const keys = (items, onCall = false) => new Set(items.map((item) => onCall
    ? `oncall|${item.date}|${item.startTime}|${item.endTime}|${item.invigilatorId}|${item.role}`
    : `session|${item.sessionId}|${item.invigilatorId}|${item.role}`));
  const oldKeys = new Set([...keys(store.assignments), ...keys(store.onCallAssignments, true)].map((key) => key));
  const newKeys = new Set([...keys(assignments), ...keys(onCallAssignments, true)].map((key) => key));
  const currentWorkload = new Map(buildWorkloadView(store).map((person) => [person.id, person]));
  const staffLoads = buildWorkloadView(next).map((person) => ({
    staffId: person.staffId, name: person.name, role: person.role,
    currentHours: Number(currentWorkload.get(person.id)?.totalMinutes || 0) / 60,
    sessionHours: person.sessionMinutes / 60, onCallHours: person.onCallMinutes / 60,
    otherHours: (person.superMinutes + person.controlMinutes) / 60,
    totalHours: person.totalMinutes / 60,
    targetHours: person.effectiveAllowedHours,
  }));
  const people = new Map(store.invigilators.map((person) => [person.id, person]));
  const sessionsById = new Map(store.sessions.map((session) => [session.id, session]));
  const duties = [
    ...assignments.map((assignment) => ({ ...assignment, ...sessionsById.get(assignment.sessionId), invigilatorId: assignment.invigilatorId, role: assignment.role, dutyType: 'Session' })),
    ...onCallAssignments.map((assignment) => ({ ...assignment, room: 'On-call reserve', dutyType: 'On-call' })),
  ].map((duty) => ({ DutyType: duty.dutyType, Date: duty.date, Start: duty.startTime, End: duty.endTime, Room: duty.room, StaffID: people.get(duty.invigilatorId)?.staffId, Name: people.get(duty.invigilatorId)?.name, Role: duty.role, ExistingAssignment: oldKeys.has(duty.dutyType === 'On-call' ? `oncall|${duty.date}|${duty.startTime}|${duty.endTime}|${duty.invigilatorId}|${duty.role}` : `session|${duty.sessionId}|${duty.invigilatorId}|${duty.role}`) }));
  const policyOverrides = [];
  if (policyMode === 'cover_shortage') {
    const policies = buildStaffHourPolicySummary(store);
    const personByStaffId = new Map(store.invigilators.map((person) => [String(person.staffId || person.id), person]));
    const config = normalizeOnCallConfig(store.onCallConfig);
    duties.forEach((duty) => {
      const person = personByStaffId.get(String(duty.StaffID));
      const policy = policies.effectivePolicyByInvigilatorId.get(person?.id);
      const add = (rule, detail) => policyOverrides.push({ ...duty, Rule: rule, Detail: detail });
      if (policy?.excluded) add('Staff excluded', 'Staff-hour policy excludes this staff member.');
      if (duty.DutyType === 'On-call' && config.excludedInvigilatorIds.includes(person?.id)) add('On-call excluded', 'Staff member is excluded from on-call.');
      const unavailable = store.engagements.filter((item) => String(item.staffId) === String(duty.StaffID) && item.date === duty.Date && Number(item.engagement ?? 1) === 1 && item.startTime < duty.End && duty.Start < item.endTime);
      if (unavailable.length) add('Unavailable', [...new Set(unavailable.map((item) => item.notes || 'Marked unavailable'))].join('; '));
    });
    staffLoads.forEach((person) => {
      const stored = personByStaffId.get(String(person.staffId));
      const policy = policies.effectivePolicyByInvigilatorId.get(stored?.id);
      if (!policy?.excluded && policy?.hasPolicyLimit && person.totalHours * 60 > policy.allowedMinutes + 0.01) {
        policyOverrides.push({ StaffID: person.staffId, Name: person.name, Role: person.role, Rule: 'Hour-policy limit', Detail: `${person.totalHours.toFixed(2)}h planned; ${(policy.allowedMinutes / 60).toFixed(2)}h policy limit.`, ExtraHours: Math.round((person.totalHours - policy.allowedMinutes / 60) * 100) / 100 });
      }
    });
  }
  return {
    policyMode, policyOverrides,
    currentTotalShortage: before.sessions + before.onCall,
    previewTotalShortage: after.sessions + after.onCall,
    totalShortage: after.sessions + after.onCall,
    sessionShortage: after.sessions, onCallShortage: after.onCall,
    assignmentsWouldCreate: [...newKeys].filter((key) => !oldKeys.has(key)).length,
    assignmentsWouldRemove: [...oldKeys].filter((key) => !newKeys.has(key)).length,
    assignmentsWouldKeep: [...newKeys].filter((key) => oldKeys.has(key)).length,
    staffLoads, duties, placedDuties: assignments.length + onCallAssignments.length,
    selectedSolver: solver.selectedSolver, cpSatStatus: solver.cpSatStatus,
    fallbackStatus: solver.fallbackStatus, selectionReason: solver.selectionReason,
    roleHourSpread: solver.roleHourSpread,
    continuity: solver.continuity || [],
    defaultStaffBalance: solver.defaultStaffBalance || [],
    scoringMode: solver.scoringMode || 'ranked',
    preferenceWeights: solver.preferenceWeights || {},
    preferenceScore: solver.preferenceScore ?? null,
    preferenceOrder: solver.preferenceOrder || [],
    preferenceRepair: solver.preferenceRepair || null,
    optimizationStages: solver.optimizationStages || [],
    optimizationSeconds: solver.optimizationSeconds || 0,
    engagementOverrides: solver.engagementOverrides || [],
    engagementOverrideMinutes: solver.engagementOverrideMinutes || 0,
  };
}

app.get('/api/scheduling/config', (_req, res) => {
  res.json(normalizeSchedulingConfig(readStore().schedulingConfig));
});

app.patch('/api/scheduling/config', (req, res) => {
  const { preferenceOrder, dailySoftTarget, scoringMode, weights } = req.body || {};
  if (!Array.isArray(preferenceOrder) || preferenceOrder.length !== SCHEDULING_PREFERENCES.length || new Set(preferenceOrder).size !== SCHEDULING_PREFERENCES.length || preferenceOrder.some((key) => !SCHEDULING_PREFERENCES.includes(key))) {
    return respondError(res, 'Include each editable scheduling priority exactly once.');
  }
  if (!Number.isInteger(dailySoftTarget) || dailySoftTarget < 0 || dailySoftTarget > 20) return respondError(res, 'Daily soft target must be an integer between 0 and 20.');
  if (!['ranked', 'weighted'].includes(scoringMode)) return respondError(res, 'Choose priority order or weighted scoring.');
  if (!weights || SCHEDULING_PREFERENCES.some((key) => !Number.isInteger(weights[key]) || weights[key] < 0 || weights[key] > 1000) || !SCHEDULING_PREFERENCES.some((key) => weights[key] > 0)) return respondError(res, 'Give every preference a weight from 0 to 1000, with at least one positive weight.');
  const store = readStore();
  store.schedulingConfig = normalizeSchedulingConfig({ preferenceOrder, dailySoftTarget, scoringMode, weights });
  return persistStoreResponse(res, store, store.schedulingConfig);
});

app.get('/api/scheduling/combined', (_req, res) => {
  const store = readStore();
  res.json({ ...buildSchedulingView(store), onCall: buildOnCallView(store), storeVersion: getStoreVersion() });
});

app.post('/api/scheduling/combined/preview', async (req, res) => {
  const store = readStore();
  const version = getStoreVersion();
  const mode = normalizePreviewMode(req.body?.mode);
  const roleScope = normalizeRoleScope(req.body?.roleScope);
  const dutyScope = req.body?.dutyScope === 'on_call' ? 'on_call' : 'combined';
  const policyMode = req.body?.policyMode ?? 'strict';
  if (!['strict', 'cover_shortage'].includes(policyMode)) return res.status(400).json({ error: 'Invalid policy mode.' });
  const shortageExcludedInvigilatorIds = policyMode === 'cover_shortage' ? (req.body?.shortageExcludedInvigilatorIds ?? []) : [];
  if (!Array.isArray(shortageExcludedInvigilatorIds) || shortageExcludedInvigilatorIds.some((id) => typeof id !== 'string' || !store.invigilators.some((person) => person.id === id))) return res.status(400).json({ error: 'Shortage exclusions must contain valid staff identifiers.' });
  try {
    const built = buildCombinedSchedulingPayload(store, mode, roleScope, dutyScope, policyMode, shortageExcludedInvigilatorIds);
    const result = await runAutoScheduleSolver(built.payload);
    if (version !== getStoreVersion()) return res.status(409).json({ error: 'Data changed during the preview. Run preview again.' });
    const byStaffId = new Map(store.invigilators.map((person) => [String(person.staffId || person.id), person.id]));
    const examRows = result.assignments.filter((item) => !built.periods.has(item.session_id));
    const assignments = mergeSavedAutoScheduleAssignments(store, examRows, byStaffId, roleScope, dutyScope === 'on_call' ? 'preserve_all' : mode).assignments;
    const onCallAssignments = [...built.preservedOnCall];
    const onCallKeys = new Set(onCallAssignments.map((item) => `${item.date}|${item.startTime}|${item.endTime}|${item.invigilatorId}|${item.role}`));
    result.assignments.filter((item) => built.periods.has(item.session_id)).forEach((item) => {
      const period = built.periods.get(item.session_id);
      const invigilatorId = byStaffId.get(String(item.staff_id));
      const key = `${period.date}|${period.startTime}|${period.endTime}|${invigilatorId}|${item.role}`;
      if (onCallKeys.has(key)) return;
      onCallKeys.add(key);
      onCallAssignments.push({ id: generateId('oncall'), date: period.date, startTime: period.startTime, endTime: period.endTime, invigilatorId, role: item.role, engagementOverrideReason: item.engagement_override_reason || '' });
    });
    const summary = summarizeCombinedPlan(store, assignments, onCallAssignments, result, policyMode);
    summary.shortageExcludedStaff = store.invigilators.filter((person) => shortageExcludedInvigilatorIds.includes(person.id)).map((person) => ({ StaffID: person.staffId || person.id, Name: person.name, Role: person.role }));
    summary.shortageExcludedInvigilatorIds = shortageExcludedInvigilatorIds;
    summary.shortageStaff = policyMode === 'cover_shortage' ? store.invigilators.map((person) => ({ id: person.id, staffId: person.staffId || person.id, name: person.name, role: person.role, newDuties: summary.duties.filter((duty) => duty.StaffID === person.staffId && !duty.ExistingAssignment).length, overrides: summary.policyOverrides.filter((row) => row.StaffID === person.staffId).length })).filter((person) => person.newDuties || shortageExcludedInvigilatorIds.includes(person.id)) : [];
    const now = Date.now();
    for (const [key, plan] of combinedSchedulingPlans) if (plan.expiresAt <= now) combinedSchedulingPlans.delete(key);
    while (combinedSchedulingPlans.size >= 20) combinedSchedulingPlans.delete(combinedSchedulingPlans.keys().next().value);
    const planToken = randomUUID();
    const expiresAt = now + COMBINED_PLAN_TTL_MS;
    combinedSchedulingPlans.set(planToken, { version, expiresAt, assignments, onCallAssignments, summary, mode, roleScope, dutyScope });
    res.json({ ...summary, planToken, expiresAt, previewMode: mode, roleScope, dutyScope, combined: true, dryRun: true, note: 'Preview only. Save applies this exact session and on-call plan. It expires after 10 minutes or when data changes.' });
  } catch (error) {
    res.status(400).json({ error: error.message, details: error.details || [] });
  }
});

app.post('/api/scheduling/combined/apply', async (req, res) => {
  const token = String(req.body?.planToken || '');
  const plan = combinedSchedulingPlans.get(token);
  if (!plan || plan.expiresAt <= Date.now()) {
    combinedSchedulingPlans.delete(token);
    return res.status(409).json({ error: 'Preview expired or is unavailable. Run preview again.' });
  }
  if (plan.version !== getStoreVersion()) return res.status(409).json({ error: 'Data changed since this preview. Run preview again before saving.' });
  const store = readStore();
  store.assignments = plan.assignments;
  store.onCallAssignments = plan.onCallAssignments;
  try {
    await writeStore(store, { expectedVersion: plan.version });
    combinedSchedulingPlans.delete(token);
    res.json({ ...plan.summary, combined: true, dryRun: false, status: plan.summary.totalShortage ? 'COMBINED_PARTIAL' : 'COMBINED_FEASIBLE', placed: plan.summary.placedDuties, shortageRemaining: plan.summary.totalShortage, mode: plan.mode, roleScope: plan.roleScope });
  } catch (error) { respondPersistenceError(res, error); }
});

function summarizeCurrentAssignmentState(store, hourPolicySummary) {
  const workloadRows = buildWorkloadView(store);
  const scheduling = buildSchedulingView(store);
  const assignedHoursByStaff = {};
  const overHardLimitStaff = [];
  const overTargetStaff = [];
  const underTargetStaff = [];
  const roleHours = { TA: [], Doctor: [] };
  const maxAssignedHoursByRole = { TA: 0, Doctor: 0 };

  workloadRows.forEach((row) => {
    const staffId = String(row.staffId || row.id);
    const assignedHours = Math.round((Number(row.totalMinutes || 0) / 60) * 100) / 100;
    assignedHoursByStaff[staffId] = assignedHours;
    const policy = hourPolicySummary.effectivePolicyByInvigilatorId.get(row.id);
    const allowedHours = Number(policy?.allowedHours || 0);
    const hardLimitHours = Number(policy?.hardLimitHours || 0);
    const excluded = Boolean(policy?.excluded);

    if (!excluded && allowedHours > 0 && assignedHours > allowedHours) {
      overTargetStaff.push(staffId);
    }
    if (policy?.hasHardLimit && assignedHours > hardLimitHours) {
      overHardLimitStaff.push(staffId);
    }
    if (!excluded && allowedHours > 0 && assignedHours < allowedHours) {
      underTargetStaff.push(staffId);
    }
    if (!excluded && row.role === 'Doctor') {
      roleHours.Doctor.push(assignedHours);
      maxAssignedHoursByRole.Doctor = Math.max(maxAssignedHoursByRole.Doctor, assignedHours);
    } else if (!excluded) {
      roleHours.TA.push(assignedHours);
      maxAssignedHoursByRole.TA = Math.max(maxAssignedHoursByRole.TA, assignedHours);
    }
  });

  return {
    assignedHoursByStaff,
    totalShortage: (scheduling.sessions || []).reduce(
      (sum, item) => sum + Number(item.taRemaining || 0) + Number(item.doctorRemaining || 0),
      0
    ),
    taShortage: (scheduling.sessions || []).reduce((sum, item) => sum + Number(item.taRemaining || 0), 0),
    doctorShortage: (scheduling.sessions || []).reduce((sum, item) => sum + Number(item.doctorRemaining || 0), 0),
    uncoveredSessionCount: (scheduling.sessions || []).filter(
      (item) => Number(item.taRemaining || 0) > 0 || Number(item.doctorRemaining || 0) > 0
    ).length,
    roleHourSpread: {
      TA: roleHours.TA.length ? Math.round((Math.max(...roleHours.TA) - Math.min(...roleHours.TA)) * 100) / 100 : 0,
      Doctor: roleHours.Doctor.length ? Math.round((Math.max(...roleHours.Doctor) - Math.min(...roleHours.Doctor)) * 100) / 100 : 0,
    },
    maxAssignedHoursByRole,
    averageHoursByRole: hourPolicySummary.rawAverageHoursByRole,
    overTargetStaff,
    overTargetCount: overTargetStaff.length,
    overHardLimitStaff,
    underTargetStaff,
  };
}

function getResultRoleShortage(result) {
  const uncovered = Array.isArray(result.uncovered_sessions) ? result.uncovered_sessions : [];
  return uncovered.reduce((acc, item) => {
    const remaining = Number(item.remaining || item.shortage || 0);
    if (item.role === 'Doctor') {
      acc.doctor += remaining;
    } else {
      acc.ta += remaining;
    }
    return acc;
  }, { ta: 0, doctor: 0 });
}

function summarizePreviewAssignmentState(store, result, hourPolicySummary) {
  const assignedHoursByStaff = result.assignedHoursByStaff || {};
  const overHardLimitStaff = [];
  const overTargetStaff = [];
  const underTargetStaff = [];
  const topOverTargetStaff = [];
  const topUnderTargetStaff = [];

  (store.invigilators || []).forEach((person) => {
    const staffId = String(person.staffId || person.id);
    const assignedHours = Number(assignedHoursByStaff[staffId] || 0);
    const policy = hourPolicySummary.effectivePolicyByInvigilatorId.get(person.id);
    const allowedHours = Number(result.effectiveAllowedHoursByStaff?.[staffId] ?? policy?.allowedHours ?? 0);
    const hardLimitHours = Number(policy?.hardLimitHours || 0);
    const excluded = Boolean(policy?.excluded);
    const row = {
      staffId,
      name: person.name,
      role: person.role,
      assignedHours: Math.round(assignedHours * 100) / 100,
      allowedHours: Math.round(allowedHours * 100) / 100,
      differenceHours: Math.round((assignedHours - allowedHours) * 100) / 100,
      excluded,
    };

    if (policy?.hasHardLimit && assignedHours > hardLimitHours) {
      overHardLimitStaff.push(staffId);
    }
    if (!excluded && allowedHours > 0 && assignedHours > allowedHours) {
      overTargetStaff.push(staffId);
      topOverTargetStaff.push(row);
    }
    if (!excluded && allowedHours > 0 && assignedHours < allowedHours) {
      underTargetStaff.push(staffId);
      topUnderTargetStaff.push(row);
    }
  });

  topOverTargetStaff.sort((a, b) => b.differenceHours - a.differenceHours || b.assignedHours - a.assignedHours || a.name.localeCompare(b.name));
  topUnderTargetStaff.sort((a, b) => ((b.allowedHours - b.assignedHours) - (a.allowedHours - a.assignedHours)) || a.name.localeCompare(b.name));

  return {
    overHardLimitStaff,
    overTargetStaff,
    underTargetStaff,
    topOverTargetStaff: topOverTargetStaff.slice(0, 10),
    topUnderTargetStaff: topUnderTargetStaff.slice(0, 10),
  };
}

function buildAutoSchedulePreviewPayload(store, payload, result, hourPolicySummary, assignmentModeSupport) {
  const previewMode = payload.__preview_mode || 'preserve_all';
  const roleScope = normalizeRoleScope(payload.__role_scope || 'both');
  const previewLockSummary = payload.__preview_lock_summary || {};
  const roleScopeSummary = payload.__role_scope_summary || { preservedByRoleScopeCount: 0, preservedDoctorAssignments: 0, preservedTAAssignments: 0 };
  const currentAssignmentsCount = store.assignments.length;
  const previewAssignmentsCount = Array.isArray(result.assignments) ? result.assignments.length : 0;
  const lockedAssignmentsBefore = payload.locked_assignments.length;

  const currentKeys = new Set(
    store.assignments.map((item) => {
      const person = store.invigilators.find((row) => row.id === item.invigilatorId);
      return `${item.sessionId}|${String(person?.staffId || item.invigilatorId || '')}|${item.role}`;
    })
  );
  const previewKeys = new Set(
    (result.assignments || []).map((item) => `${item.session_id}|${String(item.staff_id || '')}|${item.role}`)
  );

  const lockedAssignmentsPreservedCount = payload.locked_assignments.filter((item) => {
    return previewKeys.has(`${item.session_id}|${String(item.staff_id || '')}|${item.role}`);
  }).length;
  const assignmentsWouldRemove = Array.from(currentKeys).filter((key) => !previewKeys.has(key)).length;
  const assignmentsWouldKeep = Array.from(currentKeys).filter((key) => previewKeys.has(key)).length;
  const assignmentsWouldCreate = Array.from(previewKeys).filter((key) => !currentKeys.has(key)).length;
  const currentKeepKeys = Array.from(currentKeys).filter((key) => previewKeys.has(key));
  const createKeys = Array.from(previewKeys).filter((key) => !currentKeys.has(key));
  const removeKeys = Array.from(currentKeys).filter((key) => !previewKeys.has(key));
  const taAssignmentsWouldCreate = createKeys.filter((key) => key.endsWith('|TA')).length;
  const doctorAssignmentsWouldCreate = createKeys.filter((key) => key.endsWith('|Doctor')).length;
  const taAssignmentsWouldRemove = removeKeys.filter((key) => key.endsWith('|TA')).length;
  const doctorAssignmentsWouldRemove = removeKeys.filter((key) => key.endsWith('|Doctor')).length;
  const currentState = summarizeCurrentAssignmentState(store, hourPolicySummary);
  const previewState = summarizePreviewAssignmentState(store, result, hourPolicySummary);
  const previewShortageByRole = getResultRoleShortage(result);
  const currentAssignedHoursByStaff = currentState.assignedHoursByStaff;
  const previewAssignedHoursByStaff = result.assignedHoursByStaff || {};
  const staffHourDeltaRows = (store.invigilators || []).map((person) => {
    const staffId = String(person.staffId || person.id);
    const currentHours = Number(currentAssignedHoursByStaff[staffId] || 0);
    const previewHours = Number(previewAssignedHoursByStaff[staffId] || 0);
    return {
      staffId,
      name: person.name,
      role: person.role,
      currentHours: Math.round(currentHours * 100) / 100,
      previewHours: Math.round(previewHours * 100) / 100,
      differenceHours: Math.round((previewHours - currentHours) * 100) / 100,
    };
  });
  const staffWithReducedHours = staffHourDeltaRows
    .filter((item) => item.differenceHours < 0)
    .sort((a, b) => a.differenceHours - b.differenceHours || a.name.localeCompare(b.name))
    .slice(0, 10);
  const staffWithIncreasedHours = staffHourDeltaRows
    .filter((item) => item.differenceHours > 0)
    .sort((a, b) => b.differenceHours - a.differenceHours || a.name.localeCompare(b.name))
    .slice(0, 10);
  const staffUnchanged = staffHourDeltaRows.filter((item) => item.differenceHours === 0).length;
  let roleScopedNote = '';
  if (roleScope === 'ta_only') {
    roleScopedNote = 'Doctor assignments were preserved because roleScope is ta_only.';
  } else if (roleScope === 'doctor_only') {
    roleScopedNote = 'TA assignments were preserved because roleScope is doctor_only.';
  }

  return {
    dryRun: true,
    previewMode,
    roleScope,
    note: 'Preview only. No data was saved.',
    roleScopedNote,
    assignmentModeSupport,
    selectedSolver: result.selectedSolver,
    cpSatStatus: result.cpSatStatus,
    fallbackStatus: result.fallbackStatus,
    selectionReason: result.selectionReason,
    currentAssignmentsCount,
    previewAssignmentsCount,
    assignmentsWouldKeep,
    assignmentsWouldCreate,
    assignmentsWouldRemove,
    preservedByRoleScopeCount: Number(roleScopeSummary.preservedByRoleScopeCount || 0),
    preservedDoctorAssignments: Number(roleScopeSummary.preservedDoctorAssignments || 0),
    preservedTAAssignments: Number(roleScopeSummary.preservedTAAssignments || 0),
    taAssignmentsWouldCreate,
    doctorAssignmentsWouldCreate,
    taAssignmentsWouldRemove,
    doctorAssignmentsWouldRemove,
    lockedAssignmentsUsed: Number(previewLockSummary.actualLockedPreservedCount ?? lockedAssignmentsBefore),
    solverLockedAssignmentsPrepared: lockedAssignmentsBefore,
    preservedManualLockedAssignments: Number(previewLockSummary.preservedManualLockedAssignments || 0),
    preservedLegacyLockedAssignments: Number(previewLockSummary.preservedLegacyLockedAssignments || 0),
    preservedImportLockedAssignments: Number(previewLockSummary.preservedImportLockedAssignments || 0),
    replaceableLegacyUnlockedAssignments: Number(previewLockSummary.replaceableLegacyUnlockedAssignments || 0),
    replaceableManualUnlockedAssignments: Number(previewLockSummary.replaceableManualUnlockedAssignments || 0),
    replaceableImportUnlockedAssignments: Number(previewLockSummary.replaceableImportUnlockedAssignments || 0),
    replaceableAutoUnlockedAssignments: Number(previewLockSummary.replaceableAutoUnlockedAssignments || 0),
    lockedAssignmentsPreserved: lockedAssignmentsPreservedCount === lockedAssignmentsBefore,
    lockedAssignmentsPreservedCount,
    lockedAssignmentsExpected: lockedAssignmentsBefore,
    totalShortage: Number(result.selectedMetrics?.totalShortage ?? result.shortageRemaining ?? 0),
    taShortage: Number(previewShortageByRole.ta || 0),
    doctorShortage: Number(previewShortageByRole.doctor || 0),
    uncoveredSessionCount: Number(result.selectedMetrics?.uncoveredSessionCount ?? (result.uncovered_sessions || []).length),
    placedDuties: Number(result.selectedMetrics?.placedDuties ?? result.placed ?? 0),
    assignedHoursByStaff: previewAssignedHoursByStaff,
    sessionHoursByStaff: result.sessionHoursByStaff || {},
    onCallHoursByStaff: result.onCallHoursByStaff || {},
    defaultStaffBalance: result.defaultStaffBalance || [],
    scoringMode: result.scoringMode || 'ranked',
    preferenceWeights: result.preferenceWeights || {},
    preferenceScore: result.preferenceScore ?? null,
    preferenceOrder: result.preferenceOrder || [],
    preferenceRepair: result.preferenceRepair || null,
    optimizationStages: result.optimizationStages || [],
    optimizationSeconds: result.optimizationSeconds || 0,
    engagementOverrides: result.engagementOverrides || [],
    engagementOverrideMinutes: result.engagementOverrideMinutes || 0,
    continuity: result.continuity || [],
    averageHoursByRole: result.averageHoursByRole || hourPolicySummary.rawAverageHoursByRole,
    effectiveAllowedHoursByStaff: result.effectiveAllowedHoursByStaff || {},
    overHardLimitStaff: previewState.overHardLimitStaff,
    overTargetStaff: previewState.overTargetStaff,
    underTargetStaff: previewState.underTargetStaff,
    excludedStaffSkipped: result.excludedStaffSkipped || [],
    policyViolations: result.policyViolations || [],
    roleHourSpread: result.roleHourSpread || { TA: 0, Doctor: 0 },
    topOverTargetStaff: previewState.topOverTargetStaff,
    topUnderTargetStaff: previewState.topUnderTargetStaff,
    currentTotalShortage: currentState.totalShortage,
    previewTotalShortage: Number(result.selectedMetrics?.totalShortage ?? result.shortageRemaining ?? 0),
    currentTaShortage: Number(currentState.taShortage || 0),
    currentDoctorShortage: Number(currentState.doctorShortage || 0),
    previewTaShortage: Number(previewShortageByRole.ta || 0),
    previewDoctorShortage: Number(previewShortageByRole.doctor || 0),
    currentRoleHourSpread: currentState.roleHourSpread,
    previewRoleHourSpread: result.roleHourSpread || { TA: 0, Doctor: 0 },
    currentOverTargetCount: currentState.overTargetCount,
    previewOverTargetCount: previewState.overTargetStaff.length,
    currentMaxAssignedHoursByRole: currentState.maxAssignedHoursByRole,
    previewMaxAssignedHoursByRole: result.selectedMetrics?.maxAssignedHoursByRole || { TA: 0, Doctor: 0 },
    currentAverageHoursByRole: currentState.averageHoursByRole,
    previewAverageHoursByRole: result.averageHoursByRole || hourPolicySummary.rawAverageHoursByRole,
    staffWithReducedHours,
    staffWithIncreasedHours,
    staffUnchanged,
    hourPolicySummary: {
      rawAverageHoursByRole: hourPolicySummary.rawAverageHoursByRole,
      totalRequiredHoursByRole: hourPolicySummary.totalRequiredHoursByRole,
      availableStaffCountByRole: hourPolicySummary.availableStaffCountByRole,
    },
    solver: result,
  };
}

async function computeAutoSchedulePreview(store, mode = 'preserve_all', roleScope = 'both') {
  const built = buildAutoSchedulePayloadForMode(store, mode, roleScope);
  const { payload, hourPolicySummary, assignmentModeSupport } = built;
  const result = await runAutoScheduleSolver(payload);
  return buildAutoSchedulePreviewPayload(store, payload, result, hourPolicySummary, assignmentModeSupport);
}

function buildPreviewAssignmentRows(store, previewResult) {
  const sessionById = new Map((store.sessions || []).map((session) => [String(session.id), session]));
  const invigilatorById = new Map((store.invigilators || []).map((person) => [String(person.id), person]));
  const invigilatorByStaffId = new Map((store.invigilators || []).map((person) => [String(person.staffId || ''), person]));
  const currentAssignments = (store.assignments || []).map((assignment) =>
    normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true })
  );
  const currentByKey = new Map(currentAssignments.map((assignment) => {
    const person = invigilatorById.get(String(assignment.invigilatorId || ''));
    return [`${assignment.sessionId}|${String(person?.staffId || assignment.invigilatorId || '')}|${assignment.role}`, assignment];
  }));
  const previewAssignments = Array.isArray(previewResult.solver?.assignments) ? previewResult.solver.assignments : [];

  const makeRow = (assignmentLike, mode = 'current') => {
    const sessionId = String(assignmentLike.sessionId || assignmentLike.session_id || '');
    const staffId = String(assignmentLike.staffId || assignmentLike.staff_id || '');
    const session = sessionById.get(sessionId);
    const person = invigilatorByStaffId.get(staffId) || invigilatorById.get(String(assignmentLike.invigilatorId || ''));
    const currentMetadata = currentByKey.get(`${sessionId}|${staffId}|${assignmentLike.role}`) || null;
    const metadata = mode === 'current'
      ? normalizeAssignmentMetadata(assignmentLike, { sourceFallback: 'legacy', lockedFallback: true })
      : normalizeAssignmentMetadata(currentMetadata || {
        assignmentSource: 'auto',
        engagementOverrideReason: assignmentLike.engagement_override_reason || '',
        locked: false,
        createdAt: '',
        updatedAt: '',
        notes: '',
      }, { sourceFallback: currentMetadata ? 'legacy' : 'auto', lockedFallback: Boolean(currentMetadata?.locked) });

    return {
      AssignmentID: mode === 'current' ? String(metadata.id || '') : '',
      SessionID: sessionId,
      CourseCode: formatCourseNames(session?.courseNames?.length ? session.courseNames : session?.courseName),
      Room: session?.room || '',
      Date: session?.date || '',
      Start: session?.startTime || '',
      End: session?.endTime || '',
      StaffID: person?.staffId || staffId,
      StaffName: person?.name || '',
      Role: assignmentLike.role || person?.role || '',
      AssignmentSource: metadata.assignmentSource || '',
      Locked: metadata.locked ? 'Yes' : 'No',
      CreatedAt: metadata.createdAt || '',
      UpdatedAt: metadata.updatedAt || '',
      Notes: metadata.notes || '',
    };
  };

  const currentRows = currentAssignments.map((assignment) => {
    const person = invigilatorById.get(String(assignment.invigilatorId || ''));
    return makeRow({
      ...assignment,
      staffId: String(person?.staffId || assignment.invigilatorId || ''),
    }, 'current');
  });
  const previewRows = previewAssignments.map((assignment) => makeRow(assignment, 'preview'));
  const currentRowByKey = new Map(currentRows.map((row) => [`${row.SessionID}|${row.StaffID}|${row.Role}`, row]));
  const previewRowByKey = new Map(previewRows.map((row) => [`${row.SessionID}|${row.StaffID}|${row.Role}`, row]));

  const currentKeys = new Set(currentRows.map((row) => `${row.SessionID}|${row.StaffID}|${row.Role}`));
  const previewKeys = new Set(previewRows.map((row) => `${row.SessionID}|${row.StaffID}|${row.Role}`));
  const makeComparisonRow = (currentRow, previewRow, previewResult) => {
    const basis = currentRow || previewRow || {};
    const rowRole = basis.Role || '';
    const preservedByRoleScope = (
      (previewResult.roleScope === 'ta_only' && rowRole === 'Doctor')
      || (previewResult.roleScope === 'doctor_only' && rowRole === 'TA')
    );
    const changeReason = currentRow && previewRow
      ? (preservedByRoleScope ? 'Preserved by role scope' : 'Kept')
      : previewRow
        ? 'Created by preview'
        : preservedByRoleScope
          ? 'Preserved by role scope'
          : 'Removed by preview';
    return {
      SessionID: basis.SessionID || '',
      CourseCode: basis.CourseCode || '',
      Room: basis.Room || '',
      Date: basis.Date || '',
      Start: basis.Start || '',
      End: basis.End || '',
      CurrentStaffID: currentRow?.StaffID || '',
      CurrentStaffName: currentRow?.StaffName || '',
      PreviewStaffID: previewRow?.StaffID || '',
      PreviewStaffName: previewRow?.StaffName || '',
      Role: basis.Role || '',
      AssignmentSource: currentRow?.AssignmentSource || previewRow?.AssignmentSource || '',
      Locked: currentRow?.Locked || previewRow?.Locked || '',
      ChangeReason: changeReason,
      PreservedByRoleScope: preservedByRoleScope ? 'Yes' : 'No',
      CurrentCreatedAt: currentRow?.CreatedAt || '',
      CurrentUpdatedAt: currentRow?.UpdatedAt || '',
      Notes: currentRow?.Notes || previewRow?.Notes || '',
    };
  };

  return {
    currentRows,
    previewRows,
    keepRows: Array.from(currentKeys)
      .filter((key) => previewKeys.has(key))
      .map((key) => makeComparisonRow(currentRowByKey.get(key), previewRowByKey.get(key), previewResult)),
    createRows: Array.from(previewKeys)
      .filter((key) => !currentKeys.has(key))
      .map((key) => makeComparisonRow(null, previewRowByKey.get(key), previewResult)),
    removeRows: Array.from(currentKeys)
      .filter((key) => !previewKeys.has(key))
      .map((key) => makeComparisonRow(currentRowByKey.get(key), null, previewResult)),
  };
}

function buildPreviewStaffHourComparisonRows(store, previewResult) {
  const workloadRows = buildWorkloadView(store);
  const policySummary = buildStaffHourPolicySummary(store);
  const byStaffId = new Map((store.invigilators || []).map((person) => [String(person.staffId || ''), person]));
  const previewHours = previewResult.assignedHoursByStaff || {};

  return (store.invigilators || []).map((person) => {
    const workload = workloadRows.find((row) => row.id === person.id) || {};
    const effectivePolicy = policySummary.effectivePolicyByInvigilatorId.get(person.id) || null;
    const currentHours = Math.round(((Number(workload.totalMinutes || 0) / 60)) * 100) / 100;
    const projectedHours = Math.round((Number(previewHours[String(person.staffId || '')] || 0)) * 100) / 100;
    return {
      StaffID: person.staffId || '',
      Name: person.name || '',
      Role: person.role || '',
      PolicyMode: effectivePolicy?.mode || 'default',
      EffectiveAllowedHours: Number(previewResult.effectiveAllowedHoursByStaff?.[String(person.staffId || '')] ?? effectivePolicy?.allowedHours ?? 0),
      CurrentHours: currentHours,
      PreviewHours: projectedHours,
      SessionHours: Number(previewResult.sessionHoursByStaff?.[String(person.staffId || '')] || 0),
      OnCallHours: Number(previewResult.onCallHoursByStaff?.[String(person.staffId || '')] || 0),
      Difference: Math.round((projectedHours - currentHours) * 100) / 100,
      AssignmentSource: '',
      Locked: '',
    };
  }).sort((a, b) => Math.abs(b.Difference) - Math.abs(a.Difference) || a.Name.localeCompare(b.Name));
}

function buildPreviewSummaryRows(previewResult) {
  return [
    { Metric: 'PreviewMode', Value: previewResult.previewMode || '' },
    { Metric: 'RoleScope', Value: previewResult.roleScope || 'both' },
    { Metric: 'SelectedSolver', Value: previewResult.selectedSolver || '' },
    { Metric: 'CpSatStatus', Value: previewResult.cpSatStatus || '' },
    { Metric: 'FallbackStatus', Value: previewResult.fallbackStatus || '' },
    { Metric: 'SelectionReason', Value: previewResult.selectionReason || '' },
    { Metric: 'CurrentAssignmentsCount', Value: Number(previewResult.currentAssignmentsCount || 0) },
    { Metric: 'PreviewAssignmentsCount', Value: Number(previewResult.previewAssignmentsCount || 0) },
    { Metric: 'AssignmentsWouldKeep', Value: Number(previewResult.assignmentsWouldKeep || 0) },
    { Metric: 'AssignmentsWouldCreate', Value: Number(previewResult.assignmentsWouldCreate || 0) },
    { Metric: 'AssignmentsWouldRemove', Value: Number(previewResult.assignmentsWouldRemove || 0) },
    { Metric: 'TaAssignmentsWouldCreate', Value: Number(previewResult.taAssignmentsWouldCreate || 0) },
    { Metric: 'TaAssignmentsWouldRemove', Value: Number(previewResult.taAssignmentsWouldRemove || 0) },
    { Metric: 'DoctorAssignmentsWouldCreate', Value: Number(previewResult.doctorAssignmentsWouldCreate || 0) },
    { Metric: 'DoctorAssignmentsWouldRemove', Value: Number(previewResult.doctorAssignmentsWouldRemove || 0) },
    { Metric: 'TotalShortage', Value: Number(previewResult.totalShortage || 0) },
    { Metric: 'TaShortage', Value: Number(previewResult.taShortage || 0) },
    { Metric: 'DoctorShortage', Value: Number(previewResult.doctorShortage || 0) },
    { Metric: 'UncoveredSessionCount', Value: Number(previewResult.uncoveredSessionCount || 0) },
    { Metric: 'PlacedDuties', Value: Number(previewResult.placedDuties || 0) },
    { Metric: 'LockedAssignmentsUsed', Value: Number(previewResult.lockedAssignmentsUsed || 0) },
    { Metric: 'PreservedByRoleScopeCount', Value: Number(previewResult.preservedByRoleScopeCount || 0) },
    { Metric: 'PreservedDoctorAssignments', Value: Number(previewResult.preservedDoctorAssignments || 0) },
    { Metric: 'PreservedTAAssignments', Value: Number(previewResult.preservedTAAssignments || 0) },
    { Metric: 'PreservedLegacyLockedAssignments', Value: Number(previewResult.preservedLegacyLockedAssignments || 0) },
    { Metric: 'PreservedManualLockedAssignments', Value: Number(previewResult.preservedManualLockedAssignments || 0) },
    { Metric: 'PreservedImportLockedAssignments', Value: Number(previewResult.preservedImportLockedAssignments || 0) },
    { Metric: 'ReplaceableLegacyUnlockedAssignments', Value: Number(previewResult.replaceableLegacyUnlockedAssignments || 0) },
    { Metric: 'ReplaceableManualUnlockedAssignments', Value: Number(previewResult.replaceableManualUnlockedAssignments || 0) },
    { Metric: 'ReplaceableImportUnlockedAssignments', Value: Number(previewResult.replaceableImportUnlockedAssignments || 0) },
    { Metric: 'ReplaceableAutoUnlockedAssignments', Value: Number(previewResult.replaceableAutoUnlockedAssignments || 0) },
    { Metric: 'AverageTAHours', Value: Number(previewResult.averageHoursByRole?.TA || 0) },
    { Metric: 'AverageDoctorHours', Value: Number(previewResult.averageHoursByRole?.Doctor || 0) },
  ];
}

function buildPreviewDiagnosticsRows(previewResult) {
  const selectedMetrics = previewResult.solver?.selectedMetrics || {};
  const cpSatMetrics = previewResult.solver?.cpSatMetrics || {};
  const fallbackMetrics = previewResult.solver?.fallbackMetrics || {};
  return [
    { Section: 'Selected', Metric: 'roleScope', Value: previewResult.roleScope || 'both' },
    { Section: 'Selected', Metric: 'totalShortage', Value: Number(selectedMetrics.totalShortage || previewResult.totalShortage || 0) },
    { Section: 'Selected', Metric: 'taShortage', Value: Number(previewResult.taShortage || 0) },
    { Section: 'Selected', Metric: 'doctorShortage', Value: Number(previewResult.doctorShortage || 0) },
    { Section: 'Selected', Metric: 'uncoveredSessionCount', Value: Number(selectedMetrics.uncoveredSessionCount || previewResult.uncoveredSessionCount || 0) },
    { Section: 'Selected', Metric: 'placedDuties', Value: Number(selectedMetrics.placedDuties || previewResult.placedDuties || 0) },
    { Section: 'Selected', Metric: 'policyViolationCount', Value: Number(selectedMetrics.policyViolationCount || (previewResult.policyViolations || []).length) },
    { Section: 'Selected', Metric: 'overLimitStaffCount', Value: Number(selectedMetrics.overLimitStaffCount || (previewResult.overHardLimitStaff || []).length) },
    { Section: 'CpSat', Metric: 'totalShortage', Value: Number(cpSatMetrics.totalShortage || 0) },
    { Section: 'CpSat', Metric: 'uncoveredSessionCount', Value: Number(cpSatMetrics.uncoveredSessionCount || 0) },
    { Section: 'Fallback', Metric: 'totalShortage', Value: Number(fallbackMetrics.totalShortage || 0) },
    { Section: 'Fallback', Metric: 'uncoveredSessionCount', Value: Number(fallbackMetrics.uncoveredSessionCount || 0) },
  ];
}

function buildPreviewExportFile(store, previewResult) {
  const assignmentRows = buildPreviewAssignmentRows(store, previewResult);
  const hourRows = buildPreviewStaffHourComparisonRows(store, previewResult);
  const overTargetRows = (previewResult.topOverTargetStaff || []).map((item) => ({
    StaffID: item.staffId || '',
    Name: item.name || '',
    Role: item.role || '',
    AssignedHours: Number(item.assignedHours || 0),
    AllowedHours: Number(item.allowedHours || 0),
    Difference: Number(item.differenceHours || 0),
  }));
  const underTargetRows = (previewResult.topUnderTargetStaff || []).map((item) => ({
    StaffID: item.staffId || '',
    Name: item.name || '',
    Role: item.role || '',
    AssignedHours: Number(item.assignedHours || 0),
    AllowedHours: Number(item.allowedHours || 0),
    Difference: Number((item.allowedHours || 0) - (item.assignedHours || 0)),
  }));
  const policyViolationRows = (previewResult.policyViolations || []).map((item) => ({
    StaffID: item.staff_id || '',
    AssignedHours: Number(item.assigned_hours || 0),
    AllowedHours: Number(item.allowed_hours || 0),
  }));

  return makeWorkbookFile([
    { name: 'PreviewSummary', rows: buildPreviewSummaryRows(previewResult) },
    { name: 'CurrentAssignments', rows: assignmentRows.currentRows },
    { name: 'PreviewAssignments', rows: assignmentRows.previewRows },
    { name: 'AssignmentsToKeep', rows: assignmentRows.keepRows },
    { name: 'AssignmentsToCreate', rows: assignmentRows.createRows },
    { name: 'AssignmentsToRemove', rows: assignmentRows.removeRows },
    { name: 'StaffHourComparison', rows: hourRows },
    { name: 'OverTargetStaff', rows: overTargetRows },
    { name: 'UnderTargetStaff', rows: underTargetRows },
    { name: 'PolicyViolations', rows: policyViolationRows },
    { name: 'SolverDiagnostics', rows: buildPreviewDiagnosticsRows(previewResult) },
    { name: 'StaffContinuity', rows: previewResult.continuity || [] },
    { name: 'DefaultStaffBalance', rows: previewResult.defaultStaffBalance || [] },
    { name: 'EngagementOverrides', rows: previewResult.engagementOverrides || [] },
    { name: 'OptimizationStages', rows: previewResult.optimizationStages || [] },
    { name: 'PreferenceOrder', rows: (previewResult.preferenceOrder || []).map((priority, index) => ({ rank: index + 1, priority, mode: previewResult.scoringMode || 'ranked', weight: previewResult.preferenceWeights?.[priority] ?? '' })) },
  ], 'auto_schedule_preview');
}

function mergeSavedAutoScheduleAssignments(store, solverAssignments, staffIdToInvigilatorId, roleScope = 'both', mode = 'preserve_manual_only') {
  const normalizedRoleScope = normalizeRoleScope(roleScope);
  const normalizedMode = normalizePreviewMode(mode);
  const existingAssignments = (store.assignments || []).map((item) =>
    normalizeAssignmentMetadata(item, { sourceFallback: 'legacy', lockedFallback: true })
  );
  const preservedAssignments = existingAssignments.filter((item) =>
    (normalizedMode === 'preserve_all')
    || (normalizedMode === 'preserve_manual_only' && shouldPreserveAssignmentForManualOnly(item))
    || shouldPreserveByRoleScope(item, normalizedRoleScope)
  );
  const removableAssignments = existingAssignments.filter((item) =>
    !(
      (normalizedMode === 'preserve_all')
      || (normalizedMode === 'preserve_manual_only' && shouldPreserveAssignmentForManualOnly(item))
      || shouldPreserveByRoleScope(item, normalizedRoleScope)
    )
  );
  const preservedKeys = new Set(preservedAssignments.map((item) => `${item.sessionId}|${item.invigilatorId}|${item.role}`));
  const nowIso = new Date().toISOString();
  const nextAutoAssignments = (solverAssignments || [])
    .map((item, index) => {
      const invigilatorId = staffIdToInvigilatorId.get(String(item.staff_id));
      if (!invigilatorId) return null;
      const key = `${item.session_id}|${invigilatorId}|${item.role}`;
      if (preservedKeys.has(key)) return null;
      return normalizeAssignmentMetadata({
        id: generateId(`asgauto${index}`),
        sessionId: item.session_id,
        invigilatorId,
        role: item.role,
        assignmentSource: 'auto',
        engagementOverrideReason: item.engagement_override_reason || '',
        locked: false,
        createdAt: nowIso,
        updatedAt: nowIso,
        notes: '',
      }, { sourceFallback: 'auto', lockedFallback: false });
    })
    .filter(Boolean);

  return {
    assignments: [...preservedAssignments, ...nextAutoAssignments],
    preservedAssignments,
    removableAssignments,
    nextAutoAssignments,
    preservedManualAssignments: preservedAssignments.filter((item) => item.assignmentSource === 'manual').length,
    preservedLegacyAssignments: preservedAssignments.filter((item) => item.assignmentSource === 'legacy').length,
    preservedImportAssignments: preservedAssignments.filter((item) => item.assignmentSource === 'import').length,
    preservedLockedAssignments: preservedAssignments.filter((item) => item.locked).length,
    preservedByRoleScopeAssignments: preservedAssignments.filter((item) => shouldPreserveByRoleScope(item, normalizedRoleScope)).length,
    preservedDoctorAssignments: preservedAssignments.filter((item) => item.role === 'Doctor' && shouldPreserveByRoleScope(item, normalizedRoleScope)).length,
    preservedTAAssignments: preservedAssignments.filter((item) => item.role === 'TA' && shouldPreserveByRoleScope(item, normalizedRoleScope)).length,
    autoAssignmentsRemoved: removableAssignments.filter((item) => item.assignmentSource === 'auto' && !item.locked).length,
  };
}

function updateAssignmentLockState(assignments, predicate, locked) {
  const nextLocked = Boolean(locked);
  const nowIso = new Date().toISOString();
  let updatedCount = 0;
  let lastUpdated = null;
  const nextAssignments = assignments.map((assignment) => {
    const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
    if (!predicate(normalized)) {
      return normalized;
    }
    updatedCount += 1;
    lastUpdated = {
      ...normalized,
      locked: nextLocked,
      updatedAt: nowIso,
    };
    return lastUpdated;
  });
  return {
    assignments: nextAssignments,
    updatedCount,
    updatedAssignment: lastUpdated,
    updatedAt: nowIso,
  };
}

function getAssignmentPresentationContext(store) {
  const sessionById = new Map((store.sessions || []).map((session) => [String(session.id), session]));
  const invigilatorById = new Map((store.invigilators || []).map((person) => [String(person.id), person]));
  return { sessionById, invigilatorById };
}

function buildAssignmentPresentationRow(store, assignment) {
  const { sessionById, invigilatorById } = getAssignmentPresentationContext(store);
  const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
  const session = sessionById.get(String(normalized.sessionId || ''));
  const person = invigilatorById.get(String(normalized.invigilatorId || ''));
  const courseCode = formatCourseNames(session?.courseNames?.length ? session.courseNames : session?.courseName);
  return {
    ...normalized,
    courseCode,
    room: session?.room || '',
    date: session?.date || '',
    startTime: session?.startTime || '',
    endTime: session?.endTime || '',
    staffId: person?.staffId || '',
    staffName: person?.name || '',
  };
}

function matchesAssignmentLockFilters(row, filters = {}) {
  const assignmentSource = String(filters.assignmentSource || '').trim().toLowerCase();
  const role = String(filters.role || '').trim();
  const date = String(filters.date || '').trim();
  const dateFrom = String(filters.dateFrom || '').trim();
  const dateTo = String(filters.dateTo || '').trim();
  const room = String(filters.room || '').trim().toLowerCase();
  const courseCode = String(filters.courseCode || '').trim().toLowerCase();
  const staffId = String(filters.staffId || '').trim().toLowerCase();
  const invigilatorId = String(filters.invigilatorId || '').trim();
  const onlyLocked = Boolean(filters.onlyLocked);
  const onlyUnlocked = Boolean(filters.onlyUnlocked);

  if (assignmentSource && String(row.assignmentSource || '').toLowerCase() !== assignmentSource) return false;
  if (role && String(row.role || '') !== role) return false;
  if (date && String(row.date || '') !== date) return false;
  if (dateFrom && String(row.date || '') < dateFrom) return false;
  if (dateTo && String(row.date || '') > dateTo) return false;
  if (room && !String(row.room || '').toLowerCase().includes(room)) return false;
  if (courseCode && !String(row.courseCode || '').toLowerCase().includes(courseCode)) return false;
  if (staffId && !String(row.staffId || '').toLowerCase().includes(staffId)) return false;
  if (invigilatorId && String(row.invigilatorId || '') !== invigilatorId) return false;
  if (onlyLocked && !row.locked) return false;
  if (onlyUnlocked && row.locked) return false;
  return true;
}

function normalizeLockFilterPayload(filters = {}) {
  return {
    assignmentSource: String(filters.assignmentSource || '').trim(),
    role: String(filters.role || '').trim(),
    date: String(filters.date || '').trim(),
    dateFrom: String(filters.dateFrom || '').trim(),
    dateTo: String(filters.dateTo || '').trim(),
    room: String(filters.room || '').trim(),
    courseCode: String(filters.courseCode || '').trim(),
    staffId: String(filters.staffId || '').trim(),
    invigilatorId: String(filters.invigilatorId || '').trim(),
    onlyLocked: Boolean(filters.onlyLocked),
    onlyUnlocked: Boolean(filters.onlyUnlocked),
  };
}

function hasAnyLockFilter(filters) {
  return Object.values(filters).some((value) => {
    if (typeof value === 'boolean') return value;
    return String(value || '').trim() !== '';
  });
}

function getLockPlanRows(store) {
  return (store.assignments || []).map((assignment) => {
    const row = buildAssignmentPresentationRow(store, assignment);
    return {
      AssignmentID: row.id || '',
      SessionID: row.sessionId || '',
      CourseCode: row.courseCode || '',
      Room: row.room || '',
      Date: row.date || '',
      Start: row.startTime || '',
      End: row.endTime || '',
      StaffID: row.staffId || '',
      StaffName: row.staffName || '',
      Role: row.role || '',
      AssignmentSource: row.assignmentSource || '',
      Locked: row.locked ? 'Yes' : 'No',
      NewLocked: row.locked ? 'Yes' : 'No',
      Notes: row.notes || '',
    };
  });
}

function normalizeDate(value, dayName = '') {
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    }
  }

  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parts = raw.split(/[./-]/).map((item) => item.trim()).filter(Boolean);
  const currentYear = new Date().getFullYear();
  if (parts.length === 2) {
    const [day, month] = parts;
    return `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
    }
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    const year = Number(parts[2]);
    if (raw.includes('/')) {
      const expectedDay = String(dayName).trim().toLowerCase().slice(0, 3);
      if (first <= 12 && second <= 12 && expectedDay) {
        const dmy = new Date(year, second - 1, first);
        const mdy = new Date(year, first - 1, second);
        const dmyDay = dmy.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
        const mdyDay = mdy.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
        if (dmyDay === expectedDay && mdyDay !== expectedDay) {
          return `${year}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`;
        }
      }
      if (first <= 12) {
        return `${year}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`;
      }
    }
    return `${parts[2]}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
  }
  return raw;
}

function normalizeTime(value) {
  if (typeof value === 'number' && value > 0 && value < 1) {
    const totalMinutes = Math.round(value * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.includes(':')) {
    const [hours, minutes] = raw.split(':');
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) {
    return raw;
  }
  const hours = Math.floor(numeric / 100);
  const minutes = numeric % 100;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeCourseNames(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatCourseNames(value, fallback = '') {
  const courses = normalizeCourseNames(value);
  return courses.length ? courses.join('; ') : String(fallback || '').trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toNonNegativeNumber(value, fallback = 0) {
  return Math.max(0, toNumber(value, fallback));
}

function normalizeRole(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'TA';
  if (['doctor', 'dr', 'doc'].includes(raw)) return 'Doctor';
  return 'TA';
}

function normalizeLoadType(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'half' ? 'half' : 'full';
}

function normalizeNotes(value) {
  return String(value ?? '').trim();
}

function extractSessionDemand(row, fallback = {}) {
  const taCandidate = row.TANeeded ?? row.taNeeded ?? row.ta_needed;
  const doctorCandidate = row.DoctorNeeded ?? row.doctorNeeded ?? row.doctor_needed;
  const totalCandidate = row.InvigilatorsNeeded ?? row.totalNeeded ?? row.total_needed;

  const taNeeded = toNonNegativeNumber(taCandidate, fallback.taNeeded ?? 0);
  const doctorNeeded = toNonNegativeNumber(doctorCandidate, fallback.doctorNeeded ?? 0);
  const computedTotal = taNeeded + doctorNeeded;
  const totalNeeded = totalCandidate === undefined || totalCandidate === null || totalCandidate === ''
    ? computedTotal
    : toNonNegativeNumber(totalCandidate, computedTotal);

  return {
    taNeeded,
    doctorNeeded,
    totalNeeded,
    hasExplicitDemand: taCandidate !== undefined || doctorCandidate !== undefined || totalCandidate !== undefined
  };
}

function normalizeInvigilatorRow(row, index, preserveInputId = false) {
  const providedId = String(row.id ?? row.ID ?? '').trim();
  const staffId = String(row.StaffID ?? row.staffId ?? row.staff_id ?? index + 1).trim();
  return {
    id: preserveInputId && providedId ? providedId : generateId(`inv${index}`),
    staffId,
    name: String(row.Name ?? row.name ?? '').trim(),
    email: String(row.Email ?? row.email ?? '').trim(),
    role: normalizeRole(row.Role ?? row.role),
    loadType: normalizeLoadType(row.LoadType ?? row.loadType ?? row.load_type),
    maxHours: toNonNegativeNumber(row.MaxHours ?? row.maxHours ?? row.max_hours, 0),
    department: String(row.Department ?? row.department ?? '').trim(),
    notes: normalizeNotes(row.Notes ?? row.notes)
  };
}

function normalizeEngagementRow(row, index, preserveInputId = false) {
  const providedId = String(row.id ?? row.ID ?? '').trim();
  return {
    id: preserveInputId && providedId ? providedId : generateId(`eng${index}`),
    staffId: String(row.StaffID ?? row.staffId ?? row.staff_id ?? '').trim(),
    date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
    startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
    endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
    engagement: toNonNegativeNumber(row.Engagement ?? row.engagement, 1),
    notes: normalizeNotes(row.Notes ?? row.notes)
  };
}

function normalizeControlSessionRow(row, index, preserveInputId = false) {
  const providedId = String(row.id ?? row.ID ?? '').trim();
  const demand = extractSessionDemand(row);
  return {
    id: preserveInputId && providedId ? providedId : generateId(`ctlses${index}`),
    courseNames: normalizeCourseNames(readCourseInput(row, 'Control Session')),
    courseName: formatCourseNames(readCourseInput(row), 'Control Session'),
    room: String(row.Room ?? row.room ?? 'Control').trim(),
    date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
    startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
    endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
    taNeeded: demand.taNeeded,
    doctorNeeded: demand.doctorNeeded,
    totalNeeded: demand.totalNeeded,
    notes: normalizeNotes(row.Notes ?? row.notes)
  };
}

function normalizeAssignmentRow(row, index, preserveInputId = false) {
  const providedId = String(row.id ?? row.ID ?? '').trim();
  return normalizeAssignmentMetadata({
    id: preserveInputId && providedId ? providedId : generateId(`asg${index}`),
    sessionId: String(row.sessionId ?? row.session_id ?? row.SessionID ?? '').trim(),
    invigilatorId: String(row.invigilatorId ?? row.staff_id ?? row.staffId ?? row.StaffID ?? '').trim(),
    role: normalizeRole(row.role ?? row.Role),
    assignmentSource: String(row.AssignmentSource ?? row.assignmentSource ?? row.assignment_source ?? row.Source ?? row.source ?? 'import').trim(),
    engagementOverrideReason: String(row.EngagementOverrideReason ?? row.engagementOverrideReason ?? '').trim(),
    locked: row.Locked ?? row.locked,
    createdAt: String(row.CreatedAt ?? row.createdAt ?? row.created_at ?? '').trim(),
    updatedAt: String(row.UpdatedAt ?? row.updatedAt ?? row.updated_at ?? '').trim(),
    notes: String(row.Notes ?? row.notes ?? '').trim(),
  }, { sourceFallback: 'import', lockedFallback: true });
}

function normalizeSuperAssignmentRow(row, index, preserveInputId = false) {
  const providedId = String(row.id ?? row.ID ?? '').trim();
  return {
    id: preserveInputId && providedId ? providedId : generateId(`sup${index}`),
    date: normalizeDate(row.date ?? row.exam_date ?? row.Date, row.Day ?? row.day),
    invigilatorId: String(row.invigilatorId ?? row.staff_id ?? row.staffId ?? row.StaffID ?? '').trim()
  };
}

function normalizeControlAssignmentRow(row, index, preserveInputId = false) {
  const providedId = String(row.id ?? row.ID ?? '').trim();
  return {
    id: preserveInputId && providedId ? providedId : generateId(`ctlasg${index}`),
    controlSessionId: String(row.controlSessionId ?? row.control_session_id ?? row.ControlSessionID ?? '').trim(),
    invigilatorId: String(row.invigilatorId ?? row.staff_id ?? row.staffId ?? row.StaffID ?? '').trim(),
    role: normalizeRole(row.role ?? row.Role)
  };
}

function readCourseInput(source, fallback = '') {
  return source?.CourseCodes
    ?? source?.courseCodes
    ?? source?.CourseCode
    ?? source?.courseCode
    ?? source?.Courses
    ?? source?.courses
    ?? source?.CourseNames
    ?? source?.courseNames
    ?? source?.CourseName
    ?? source?.courseName
    ?? fallback;
}

function readRoomInput(source, fallback = '') {
  return source?.RoomPlacement
    ?? source?.roomPlacement
    ?? source?.Room
    ?? source?.room
    ?? fallback;
}

function readNotesInput(source, fallback = '') {
  return source?.Notes
    ?? source?.notes
    ?? source?.OverRide
    ?? source?.override
    ?? source?.Override
    ?? fallback;
}

function buildSessionBlockCourseKey({ date, startTime, room, courseNames, courseName }) {
  const courses = normalizeCourseNames(courseNames?.length ? courseNames : courseName)
    .map((item) => item.toLowerCase())
    .sort()
    .join(';');
  return [
    String(date || '').trim(),
    String(startTime || '').trim(),
    String(room || '').trim().toLowerCase(),
    courses
  ].join('|');
}

function buildSessionRoomStartKey({ date, startTime, room }) {
  return [
    String(date || '').trim(),
    String(startTime || '').trim(),
    String(room || '').trim().toLowerCase()
  ].join('|');
}

function buildSessionTimeRoomKey({ date, startTime, endTime, room }) {
  return `${buildSessionRoomStartKey({ date, startTime, room })}|${String(endTime || '').trim()}`;
}

function buildMergedBlockExamples(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const key = buildSessionRoomStartKey({
      date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
      startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
      room: String(readRoomInput(row)).trim(),
    });
    if (!key.replace(/\|/g, '').trim()) return;
    const current = grouped.get(key) || { count: 0, room: String(readRoomInput(row)).trim(), date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day), start: normalizeTime(row.Start ?? row.startTime ?? row.start_time), ends: [] };
    current.count += 1;
    current.ends.push(normalizeTime(row.End ?? row.endTime ?? row.end_time));
    grouped.set(key, current);
  });
  return Array.from(grouped.values())
    .filter((item) => item.count > 1)
    .slice(0, 5)
    .map((item) => ({
      room: item.room,
      date: item.date,
      start: item.start,
      originalEnds: item.ends.filter(Boolean),
      mergedEnd: item.ends.filter(Boolean).sort((a, b) => toNumber(a.replace(':', ''), 0) - toNumber(b.replace(':', ''), 0)).slice(-1)[0] || '',
      rowCount: item.count,
    }));
}

function makeSessionFromImportRow(row, id) {
  return {
    id,
    courseNames: normalizeCourseNames(readCourseInput(row)),
    courseName: formatCourseNames(readCourseInput(row)),
    room: String(readRoomInput(row)).trim(),
    date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
    startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
    endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
    notes: String(readNotesInput(row)).trim()
  };
}

function mergeSessionRowsByRoomTime(rows, existingSessions = []) {
  const existingByTimeRoom = new Map();
  existingSessions.forEach((session) => {
    const key = buildSessionRoomStartKey(session);
    if (!existingByTimeRoom.has(key)) {
      existingByTimeRoom.set(key, session);
    }
  });

  const grouped = new Map();
  rows.forEach((row) => {
    const candidate = makeSessionFromImportRow(row, '');
    const key = buildSessionRoomStartKey(candidate);
    if (!key.replace(/\|/g, '').trim()) return;

    if (!grouped.has(key)) {
      const existing = existingByTimeRoom.get(key);
      grouped.set(key, {
        ...candidate,
        id: existing?.id || generateId(`ses${grouped.size}`),
        courseNames: [],
        courseName: '',
        taNeeded: Number(existing?.taNeeded || 0),
        doctorNeeded: Number(existing?.doctorNeeded || 0),
        totalNeeded: Number(existing?.totalNeeded || ((existing?.taNeeded || 0) + (existing?.doctorNeeded || 0)))
      });
    }

    const session = grouped.get(key);
    if (parseTimeToMinutes(candidate.endTime) > parseTimeToMinutes(session.endTime)) {
      session.endTime = candidate.endTime;
    }
    const knownCourses = new Set(session.courseNames.map((item) => item.toLowerCase()));
    candidate.courseNames.forEach((course) => {
      const normalized = course.toLowerCase();
      if (!knownCourses.has(normalized)) {
        session.courseNames.push(course);
        knownCourses.add(normalized);
      }
    });
    session.courseName = formatCourseNames(session.courseNames);
    if (!session.notes && candidate.notes) {
      session.notes = candidate.notes;
    }
  });

  return Array.from(grouped.values());
}

function normalizeImportedSessions(rows, existingSessions = [], preserveInputIds = false) {
  const existingByTimeRoom = new Map();
  existingSessions.forEach((session) => {
    const key = buildSessionRoomStartKey(session);
    if (!existingByTimeRoom.has(key)) {
      existingByTimeRoom.set(key, session);
    }
  });

  const grouped = new Map();
  rows.forEach((row, index) => {
    const candidate = makeSessionFromImportRow(row, '');
    const key = buildSessionRoomStartKey(candidate);
    if (!key.replace(/\|/g, '').trim()) return;

    if (!grouped.has(key)) {
      const existing = existingByTimeRoom.get(key);
      const providedId = String(row.id ?? row.ID ?? row.SessionID ?? row.sessionId ?? '').trim();
      grouped.set(key, {
        ...candidate,
        id: preserveInputIds && providedId ? providedId : existing?.id || generateId(`ses${index}`),
        courseNames: [],
        courseName: '',
        taNeeded: toNonNegativeNumber(existing?.taNeeded, 0),
        doctorNeeded: toNonNegativeNumber(existing?.doctorNeeded, 0),
        totalNeeded: toNonNegativeNumber(existing?.totalNeeded, toNonNegativeNumber(existing?.taNeeded, 0) + toNonNegativeNumber(existing?.doctorNeeded, 0))
      });
    }

    const session = grouped.get(key);
    if (parseTimeToMinutes(candidate.endTime) > parseTimeToMinutes(session.endTime)) {
      session.endTime = candidate.endTime;
    }
    const knownCourses = new Set(session.courseNames.map((item) => item.toLowerCase()));
    candidate.courseNames.forEach((course) => {
      const normalized = course.toLowerCase();
      if (!knownCourses.has(normalized)) {
        session.courseNames.push(course);
        knownCourses.add(normalized);
      }
    });
    session.courseName = formatCourseNames(session.courseNames);

    const demand = extractSessionDemand(row, session);
    if (demand.hasExplicitDemand) {
      session.taNeeded = Math.max(session.taNeeded, demand.taNeeded);
      session.doctorNeeded = Math.max(session.doctorNeeded, demand.doctorNeeded);
      session.totalNeeded = Math.max(session.totalNeeded, demand.totalNeeded, session.taNeeded + session.doctorNeeded);
    } else {
      session.totalNeeded = Math.max(session.totalNeeded, session.taNeeded + session.doctorNeeded);
    }

    if (!session.notes && candidate.notes) {
      session.notes = candidate.notes;
    }
  });

  return Array.from(grouped.values());
}

function makeSessionIdentityRows(sessions) {
  return sessions.map((session) => {
    const courseCodes = formatCourseNames(session.courseNames?.length ? session.courseNames : session.courseName);
    return {
      Room: session.room || '',
      CourseCode: courseCodes,
      Date: session.date || '',
      Start: session.startTime || '',
      End: session.endTime || ''
    };
  });
}

function makeSessionNeedRows(sessions) {
  return sessions.map((session) => {
    return {
      SessionID: session.id,
      CourseCode: formatCourseNames(session.courseNames?.length ? session.courseNames : session.courseName),
      Room: session.room || '',
      Date: session.date || '',
      Start: session.startTime || '',
      End: session.endTime || '',
      TANeeded: Number(session.taNeeded || 0),
      DoctorNeeded: Number(session.doctorNeeded || 0),
      InvigilatorsNeeded: Number(session.totalNeeded || ((session.taNeeded || 0) + (session.doctorNeeded || 0)))
    };
  });
}

function makeSchedulingAssignmentRows(store) {
  const sessionById = new Map(store.sessions.map((session) => [session.id, session]));
  const invigilatorById = new Map(store.invigilators.map((person) => [person.id, person]));

  return store.assignments.map((assignment) => {
    const session = sessionById.get(assignment.sessionId);
    const person = invigilatorById.get(assignment.invigilatorId);
    const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
    return {
      AssignmentID: normalized.id || '',
      SessionID: normalized.sessionId || '',
      StaffID: person?.staffId || '',
      Name: person?.name || '',
      Role: normalized.role || person?.role || '',
      CourseCode: formatCourseNames(session?.courseNames?.length ? session.courseNames : session?.courseName),
      Room: session?.room || '',
      Date: session?.date || '',
      Start: session?.startTime || '',
      End: session?.endTime || '',
      AssignmentSource: normalized.assignmentSource || 'legacy',
      EngagementOverrideReason: normalized.engagementOverrideReason || '',
      Locked: normalized.locked ? 'Yes' : 'No',
      CreatedAt: normalized.createdAt || '',
      UpdatedAt: normalized.updatedAt || '',
      Notes: normalized.notes || '',
    };
  });
}

function buildSchedulingSessionReferenceRows(store) {
  const scheduling = buildSchedulingView(store);
  return (scheduling.sessions || []).map((session) => ({
    SessionID: session.id || '',
    CourseCode: formatCourseNames(session.courseNames?.length ? session.courseNames : session.courseName),
    CourseName: session.courseName || formatCourseNames(session.courseNames?.length ? session.courseNames : session.courseName),
    Room: session.room || '',
    Date: session.date || '',
    Start: session.startTime || '',
    End: session.endTime || '',
    TANeeded: Number(session.taNeeded || 0),
    DoctorNeeded: Number(session.doctorNeeded || 0),
    AssignedTAs: Number(session.assignedTACount || 0),
    AssignedDoctors: Number(session.assignedDoctorCount || 0),
    TARemaining: Number(session.taRemaining || 0),
    DoctorRemaining: Number(session.doctorRemaining || 0),
  }));
}

function buildSchedulingStaffReferenceRows(store) {
  const workloadRows = buildWorkloadView(store);
  const workloadById = new Map(workloadRows.map((row) => [row.id, row]));
  return store.invigilators.map((person) => {
    const row = workloadById.get(person.id) || {};
    return {
      InvigilatorID: person.id || '',
      StaffID: person.staffId || '',
      StaffName: person.name || '',
      Role: person.role || 'TA',
      Department: person.department || '',
      CurrentAssignedHours: Math.round(((Number(row.totalMinutes || 0) / 60) || 0) * 100) / 100,
      RoleAverageHours: Number(row.roleAverageHours || 0),
      EffectiveAllowedHours: Number(row.effectiveAllowedHours || 0),
      PolicyMode: row.policyMode || 'default',
      ExcludedFromAutoSchedule: row.excludeFromAutoSchedule ? 'Yes' : 'No',
    };
  });
}

function buildSchedulingCurrentAssignmentRows(store) {
  const sessionById = new Map(store.sessions.map((session) => [session.id, session]));
  const invigilatorById = new Map(store.invigilators.map((person) => [person.id, person]));
  const workloadRows = buildWorkloadView(store);
  const workloadById = new Map(workloadRows.map((row) => [row.id, row]));
  return (store.assignments || []).map((assignment) => {
    const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
    const session = sessionById.get(normalized.sessionId);
    const person = invigilatorById.get(normalized.invigilatorId);
    const workload = workloadById.get(person?.id) || {};
    const durationHours = session ? Math.round((getDurationMinutes(session.startTime, session.endTime) / 60) * 100) / 100 : 0;
    return {
      AssignmentID: normalized.id || '',
      SessionID: normalized.sessionId || '',
      CourseCode: formatCourseNames(session?.courseNames?.length ? session.courseNames : session?.courseName),
      CourseName: session?.courseName || formatCourseNames(session?.courseNames?.length ? session.courseNames : session?.courseName),
      Room: session?.room || '',
      Date: session?.date || '',
      Start: session?.startTime || '',
      End: session?.endTime || '',
      DurationHours: durationHours,
      Role: normalized.role || person?.role || '',
      StaffID: person?.staffId || '',
      StaffName: person?.name || '',
      AssignmentSource: normalized.assignmentSource || 'legacy',
      EngagementOverrideReason: normalized.engagementOverrideReason || '',
      Locked: normalized.locked ? 'Yes' : 'No',
      CurrentAssignedHours: Math.round(((Number(workload.totalMinutes || 0) / 60) || 0) * 100) / 100,
      RoleAverageHours: Number(workload.roleAverageHours || 0),
      EffectiveAllowedHours: Number(workload.effectiveAllowedHours || 0),
      PolicyMode: workload.policyMode || 'default',
      Notes: normalized.notes || '',
    };
  });
}

function buildSchedulingSummaryRows(store) {
  const scheduling = buildSchedulingView(store);
  const workloadRows = buildWorkloadView(store);
  const assignmentRows = (store.assignments || []).map((assignment) =>
    normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true })
  );
  return [
    { Metric: 'TotalSessions', Value: Number((scheduling.sessions || []).length) },
    { Metric: 'TotalAssignments', Value: Number(assignmentRows.length) },
    { Metric: 'TAAssignments', Value: Number(assignmentRows.filter((item) => item.role === 'TA').length) },
    { Metric: 'DoctorAssignments', Value: Number(assignmentRows.filter((item) => item.role === 'Doctor').length) },
    { Metric: 'LockedAssignments', Value: Number(assignmentRows.filter((item) => item.locked).length) },
    { Metric: 'UnlockedAssignments', Value: Number(assignmentRows.filter((item) => !item.locked).length) },
    { Metric: 'TotalTARemaining', Value: Number((scheduling.sessions || []).reduce((sum, item) => sum + Number(item.taRemaining || 0), 0)) },
    { Metric: 'TotalDoctorRemaining', Value: Number((scheduling.sessions || []).reduce((sum, item) => sum + Number(item.doctorRemaining || 0), 0)) },
    { Metric: 'OverTargetStaffCount', Value: Number(workloadRows.filter((row) => row.policyStatus === 'over target').length) },
  ];
}

function buildSchedulingInstructionsRows() {
  return [
    { Section: 'Purpose', Instruction: 'Scheduling export is for assignment review and scheduling-only edits.' },
    { Section: 'Scope', Instruction: 'This workbook does not modify Sessions master data, Invigilators master data, Staff Hour Policies, On-Call settings, or Course Room Assignment data.' },
    { Section: 'AssignmentActions', Instruction: 'Allowed Action values: ADD, UPDATE, REMOVE, LOCK, UNLOCK.' },
    { Section: 'ADD', Instruction: 'Requires SessionID + StaffID + Role. Locked defaults to Yes unless explicitly set to No.' },
    { Section: 'UPDATE', Instruction: 'Requires AssignmentID. StaffID/Role may be changed if validation passes.' },
    { Section: 'REMOVE', Instruction: 'Requires AssignmentID. Locked assignments require ForceRemove=YES.' },
    { Section: 'LOCK', Instruction: 'Requires AssignmentID. Sets locked = true.' },
    { Section: 'UNLOCK', Instruction: 'Requires AssignmentID. Sets locked = false.' },
    { Section: 'DryRun', Instruction: 'Use dry-run validation before apply. Dry-run does not save any data.' },
  ];
}

function buildCommitteeAssignmentInstructionsRows() {
  return [
    { Section: 'Purpose', Instruction: 'This file imports staff assigned inside committees or rooms into Scheduling assignments only.' },
    { Section: 'Scope', Instruction: 'It does not create sessions, invigilators, staff hour policies, on-call settings, or course-room assignment data.' },
    { Section: 'DryRun', Instruction: 'Use dry-run validation before apply. Dry-run does not save any data.' },
    { Section: 'Matching', Instruction: 'SessionID is optional. Matching uses SessionID first, then Room + Date + Start, then CourseCode, then End as fallback.' },
    { Section: 'Staff', Instruction: 'StaffID is recommended. StaffName-only matching must be unique.' },
    { Section: 'Locked', Instruction: 'Imported assignments default to locked = Yes unless Locked explicitly says No.' },
    { Section: 'ReplaceMode', Instruction: 'replace_matching_sessions replaces only targeted session-role assignments. Locked assignments require ForceReplaceLocked=YES.' },
    { Section: 'Formats', Instruction: 'You can use one assignment per row or one committee row with TA1/TA2/TA3 and Doctor1/Doctor2 staff columns.' },
  ];
}

function buildAssignmentActionTemplateRows() {
  return [
    {
      Action: 'ADD',
      AssignmentID: '',
      SessionID: 'ses_db_1',
      StaffID: '2001',
      Role: 'TA',
      Locked: 'Yes',
      ForceRemove: '',
      Notes: 'Example add',
    },
    {
      Action: 'LOCK',
      AssignmentID: 'asg_db_1',
      SessionID: '',
      StaffID: '',
      Role: '',
      Locked: 'Yes',
      ForceRemove: '',
      Notes: 'Example lock',
    },
  ];
}

function buildCommitteeAssignmentTemplateRows() {
  return [
    {
      Date: '2026-06-01',
      Start: '09:30',
      End: '11:30',
      Room: '315 TH PH',
      CourseCode: 'ME101',
      Role: 'TA',
      StaffID: '2058',
      StaffName: 'Example TA',
      Locked: 'Yes',
      Notes: 'One assignment per row example',
      TA1StaffID: '',
      TA1Name: '',
      TA2StaffID: '',
      TA2Name: '',
      TA3StaffID: '',
      TA3Name: '',
      Doctor1StaffID: '',
      Doctor1Name: '',
      Doctor2StaffID: '',
      Doctor2Name: '',
      ForceReplaceLocked: '',
      AllowOverstaffing: '',
    },
    {
      Date: '2026-06-01',
      Start: '12:00',
      End: '14:00',
      Room: '316 TH PH',
      CourseCode: 'ME102',
      Role: '',
      StaffID: '',
      StaffName: '',
      Locked: 'Yes',
      Notes: 'Committee row example',
      TA1StaffID: '2101',
      TA1Name: 'Example TA 1',
      TA2StaffID: '2102',
      TA2Name: 'Example TA 2',
      TA3StaffID: '',
      TA3Name: '',
      Doctor1StaffID: '1101',
      Doctor1Name: 'Example Doctor 1',
      Doctor2StaffID: '',
      Doctor2Name: '',
      ForceReplaceLocked: '',
      AllowOverstaffing: '',
    },
  ];
}

function ensureSheetColumns(rows, columns) {
  if (Array.isArray(rows) && rows.length) {
    return rows;
  }
  return [{
    ...Object.fromEntries(columns.map((column) => [column, ''])),
    Notice: 'No data',
  }];
}

function cloneStoreState(store) {
  return JSON.parse(JSON.stringify(store));
}

function normalizeAssignmentAction(value) {
  const raw = String(value || '').trim().toUpperCase();
  return ['ADD', 'UPDATE', 'REMOVE', 'LOCK', 'UNLOCK'].includes(raw) ? raw : '';
}

function parseLockedCell(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  return normalizeAssignmentMetadata({ locked: value }, { sourceFallback: 'legacy', lockedFallback: fallback }).locked;
}

function summarizeSchedulingImportError(rowNumber, action, row, reason, message = '') {
  return {
    row: rowNumber,
    action,
    AssignmentID: String(row.AssignmentID ?? row.assignmentId ?? '').trim(),
    SessionID: String(row.SessionID ?? row.sessionId ?? '').trim(),
    StaffID: String(row.StaffID ?? row.staffId ?? '').trim(),
    reason,
    message,
  };
}

function getSchedulingImportMessageForEligibility(reason, session) {
  if (reason === 'engagement') return { reason: 'engagement', message: 'Staff has an engagement during this session.' };
  if (reason === 'overlap') return { reason: 'overlap', message: 'Staff has an overlapping duty during this session.' };
  if (reason === 'max_hours') return { reason: 'max_hours', message: 'Staff would exceed max hours.' };
  if (reason === 'policy_excluded') return { reason: 'staff_hour_policy_exceeded', message: 'Staff is excluded by Staff Hour Policy.' };
  if (reason === 'policy_limit') {
    return {
      reason: 'staff_hour_policy_exceeded',
      message: `Staff hour policy exceeded. Current hours: ${((session.currentMinutes || 0) / 60).toFixed(2)}, new duty hours: ${((session.newDutyMinutes || 0) / 60).toFixed(2)}, allowed hours: ${((session.allowedMinutes || 0) / 60).toFixed(2)}.`,
    };
  }
  if (reason === 'already_assigned') return { reason: 'already_assigned', message: 'Staff is already assigned to this session.' };
  return { reason: reason || 'validation_failed', message: 'Assignment validation failed.' };
}

function normalizeCommitteeImportMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'replace_matching_sessions' ? 'replace_matching_sessions' : 'append';
}

function getCommitteeValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return row[key];
    }
  }
  return '';
}

function parseCommitteeRole(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const lowered = raw.toLowerCase();
  if (['ta', 'teacher assistant', 'assistant'].includes(lowered)) return 'TA';
  if (['doctor', 'dr', 'doc', 'professor'].includes(lowered)) return 'Doctor';
  return '';
}

function isNormalizedDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function isNormalizedTime(value) {
  return /^\d{2}:\d{2}$/.test(String(value || '').trim());
}

function parseBooleanLike(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const raw = String(value).trim().toLowerCase();
  if (['yes', 'true', '1', 'y', 'locked'].includes(raw)) return true;
  if (['no', 'false', '0', 'n', 'unlocked'].includes(raw)) return false;
  return fallback;
}

function buildCommitteeImportError(rowNumber, entry, reason, message = '') {
  return {
    row: rowNumber,
    sessionReference: {
      SessionID: String(entry.SessionID || '').trim(),
      Date: String(entry.Date || '').trim(),
      Start: String(entry.Start || '').trim(),
      End: String(entry.End || '').trim(),
      Room: String(entry.Room || '').trim(),
      CourseCode: String(entry.CourseCode || '').trim(),
    },
    staffReference: {
      StaffID: String(entry.StaffID || '').trim(),
      StaffName: String(entry.StaffName || '').trim(),
      InvigilatorID: String(entry.InvigilatorID || '').trim(),
    },
    role: String(entry.Role || '').trim(),
    reason,
    message,
  };
}

function buildCommitteeImportContext(store) {
  const sessions = store.sessions || [];
  return {
    sessionById: new Map(sessions.map((session) => [String(session.id), session])),
    sessionsByRoomStart: new Map(sessions.reduce((acc, session) => {
      const key = buildSessionRoomStartKey(session);
      acc.push([key, (acc.find((item) => item[0] === key)?.[1] || []).concat(session)]);
      return acc;
    }, [])),
    invigilatorById: new Map((store.invigilators || []).map((person) => [String(person.id), person])),
    invigilatorByStaffId: new Map((store.invigilators || []).map((person) => [String(person.staffId || ''), person])),
    invigilatorsByName: new Map((store.invigilators || []).reduce((acc, person) => {
      const key = String(person.name || '').trim();
      if (!acc.has(key)) acc.set(key, []);
      acc.get(key).push(person);
      return acc;
    }, new Map())),
  };
}

function getSessionsByRoomStart(store) {
  const map = new Map();
  (store.sessions || []).forEach((session) => {
    const key = buildSessionRoomStartKey(session);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(session);
  });
  return map;
}

function matchCommitteeImportSession(store, context, entry) {
  const sessionId = String(entry.SessionID || '').trim();
  if (sessionId) {
    return context.sessionById.get(sessionId)
      ? { session: context.sessionById.get(sessionId) }
      : { reason: 'unknown_session', message: 'SessionID not found.' };
  }

  const room = String(entry.Room || '').trim();
  const date = String(entry.Date || '').trim();
  const startTime = String(entry.Start || '').trim();
  const endTime = String(entry.End || '').trim();
  const courseCode = String(entry.CourseCode || '').trim().toLowerCase();
  const candidates = (getSessionsByRoomStart(store).get(buildSessionRoomStartKey({ room, date, startTime })) || []);
  if (!candidates.length) {
    return { reason: 'unknown_session', message: 'No session matches Room + Date + Start.' };
  }
  if (candidates.length === 1) {
    return { session: candidates[0] };
  }

  if (courseCode) {
    const byCourse = candidates.filter((session) =>
      formatCourseNames(session.courseNames?.length ? session.courseNames : session.courseName).toLowerCase() === courseCode
    );
    if (byCourse.length === 1) return { session: byCourse[0] };
  }

  if (endTime) {
    const byEnd = candidates.filter((session) => String(session.endTime || '') === endTime);
    if (byEnd.length === 1) return { session: byEnd[0] };
  }

  return { reason: 'ambiguous_session', message: 'Multiple sessions match this committee reference.' };
}

function matchCommitteeImportStaff(context, entry) {
  const staffId = String(entry.StaffID || '').trim();
  const invigilatorId = String(entry.InvigilatorID || '').trim();
  const staffName = String(entry.StaffName || '').trim();

  if (staffId) {
    const person = context.invigilatorByStaffId.get(staffId);
    return person ? { person } : { reason: 'unknown_staff', message: 'StaffID not found.' };
  }

  if (invigilatorId) {
    const person = context.invigilatorById.get(invigilatorId);
    return person ? { person } : { reason: 'unknown_staff', message: 'InvigilatorID not found.' };
  }

  if (staffName) {
    const matches = context.invigilatorsByName.get(staffName) || [];
    if (matches.length === 1) return { person: matches[0] };
    if (matches.length > 1) return { reason: 'ambiguous_staff_name', message: 'StaffName matches more than one invigilator.' };
  }

  return { reason: 'unknown_staff', message: 'Staff reference not found.' };
}

function expandCommitteeAssignmentRows(rows) {
  const expanded = [];
  const warnings = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const date = normalizeDate(getCommitteeValue(row, ['Date', 'ExamDate', 'Day', 'date', 'examDate', 'exam_date', 'التاريخ']), row.Day ?? row.day ?? '');
    const startTime = normalizeTime(getCommitteeValue(row, ['Start', 'StartTime', 'From', 'start', 'startTime', 'start_time', 'بداية']));
    const endTime = normalizeTime(getCommitteeValue(row, ['End', 'EndTime', 'To', 'end', 'endTime', 'end_time', 'نهاية']));
    const room = String(getCommitteeValue(row, ['Room', 'Committee', 'RoomName', 'room', 'committee', 'لجنة', 'الغرفة']) || '').trim();
    const courseCode = String(getCommitteeValue(row, ['CourseCode', 'Course', 'Code', 'SubjectCode', 'courseCode', 'course', 'code', 'كود المقرر']) || '').trim();
    const locked = parseLockedCell(getCommitteeValue(row, ['Locked', 'locked']), true);
    const notes = String(getCommitteeValue(row, ['Notes', 'notes']) || '').trim();
    const sessionId = String(getCommitteeValue(row, ['SessionID', 'sessionId']) || '').trim();
    const forceReplaceLocked = parseBooleanLike(getCommitteeValue(row, ['ForceReplaceLocked', 'forceReplaceLocked']), false);
    const allowOverstaffing = parseBooleanLike(getCommitteeValue(row, ['AllowOverstaffing', 'allowOverstaffing']), false);
    const invigilatorId = String(getCommitteeValue(row, ['InvigilatorID', 'invigilatorId']) || '').trim();

    const base = {
      SessionID: sessionId,
      Date: date,
      Start: startTime,
      End: endTime,
      Room: room,
      CourseCode: courseCode,
      Locked: locked ? 'Yes' : 'No',
      Notes: notes,
      ForceReplaceLocked: forceReplaceLocked ? 'Yes' : 'No',
      AllowOverstaffing: allowOverstaffing ? 'Yes' : 'No',
      InvigilatorID: invigilatorId,
    };

    const directStaffId = String(getCommitteeValue(row, ['StaffID', 'ID', 'StaffCode', 'staffId', 'staff_id', 'كود', 'الرقم']) || '').trim();
    const directStaffName = String(getCommitteeValue(row, ['StaffName', 'Name', 'InvigilatorName', 'staffName', 'name', 'الاسم']) || '').trim();
    const directRoleRaw = getCommitteeValue(row, ['Role', 'Type', 'role', 'type', 'الوظيفة']);
    const directRole = parseCommitteeRole(directRoleRaw);
    const hasDirect = directStaffId || directStaffName || directRoleRaw;

    if (hasDirect) {
      expanded.push({
        ...base,
        rowNumber,
        Role: directRoleRaw ? (directRole || String(directRoleRaw || '').trim()) : '',
        StaffID: directStaffId,
        StaffName: directStaffName,
      });
    }

    let multiCount = 0;
    for (let i = 1; i <= 6; i += 1) {
      const taStaffId = String(getCommitteeValue(row, [`TA${i}StaffID`, `TA${i}ID`, `TA${i}StaffId`]) || '').trim();
      const taName = String(getCommitteeValue(row, [`TA${i}Name`]) || '').trim();
      if (taStaffId || taName) {
        multiCount += 1;
        expanded.push({
          ...base,
          rowNumber,
          Role: 'TA',
          StaffID: taStaffId,
          StaffName: taName,
        });
      }
    }
    for (let i = 1; i <= 4; i += 1) {
      const doctorStaffId = String(getCommitteeValue(row, [`Doctor${i}StaffID`, `Doctor${i}ID`, `Doctor${i}StaffId`]) || '').trim();
      const doctorName = String(getCommitteeValue(row, [`Doctor${i}Name`]) || '').trim();
      if (doctorStaffId || doctorName) {
        multiCount += 1;
        expanded.push({
          ...base,
          rowNumber,
          Role: 'Doctor',
          StaffID: doctorStaffId,
          StaffName: doctorName,
        });
      }
    }

    if (!hasDirect && multiCount === 0) {
      warnings.push({
        row: rowNumber,
        reason: 'no_assignments_found',
        message: 'Row did not contain direct staff fields or committee TA/Doctor columns.',
      });
    }
  });
  return { expanded, warnings };
}

function processCommitteeAssignmentImport(store, rows, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const mode = normalizeCommitteeImportMode(options.mode);
  const summary = {
    dryRun,
    mode,
    rowsRead: rows.length,
    expandedAssignments: 0,
    sessionsMatched: 0,
    assignmentsToAdd: 0,
    assignmentsToUpdate: 0,
    assignmentsToRemove: 0,
    added: 0,
    updated: 0,
    removed: 0,
    rejected: 0,
    duplicatesSkipped: 0,
    unchanged: 0,
    warnings: [],
    errors: [],
    examples: [],
  };
  const workingStore = cloneStoreState(store);
  const nowIso = new Date().toISOString();
  const context = buildCommitteeImportContext(workingStore);
  const { expanded, warnings } = expandCommitteeAssignmentRows(rows);
  const sessionMatchSet = new Set();
  summary.expandedAssignments = expanded.length;
  summary.warnings.push(...warnings);

  const resolvedEntries = [];
  expanded.forEach((entry) => {
    const rowNumber = entry.rowNumber;
    if (!isNormalizedDate(entry.Date)) {
      summary.rejected += 1;
      summary.errors.push(buildCommitteeImportError(rowNumber, entry, 'invalid_date', 'Date is required and must normalize to YYYY-MM-DD.'));
      return;
    }
    if (!isNormalizedTime(entry.Start) || !isNormalizedTime(entry.End)) {
      summary.rejected += 1;
      summary.errors.push(buildCommitteeImportError(rowNumber, entry, 'invalid_time', 'Start and End are required and must normalize to HH:MM.'));
      return;
    }

    const sessionMatch = matchCommitteeImportSession(workingStore, context, entry);
    if (!sessionMatch.session) {
      summary.rejected += 1;
      summary.errors.push(buildCommitteeImportError(rowNumber, entry, sessionMatch.reason, sessionMatch.message));
      return;
    }

    const staffMatch = matchCommitteeImportStaff(context, entry);
    if (!staffMatch.person) {
      summary.rejected += 1;
      summary.errors.push(buildCommitteeImportError(rowNumber, entry, staffMatch.reason, staffMatch.message));
      return;
    }

    let requestedRole = '';
    if (String(entry.Role || '').trim()) {
      requestedRole = parseCommitteeRole(entry.Role);
      if (!requestedRole) {
        summary.rejected += 1;
        summary.errors.push(buildCommitteeImportError(rowNumber, entry, 'invalid_role', 'Role must be TA or Doctor when provided.'));
        return;
      }
    } else {
      requestedRole = staffMatch.person.role;
    }
    if (requestedRole !== staffMatch.person.role) {
      summary.rejected += 1;
      summary.errors.push(buildCommitteeImportError(rowNumber, entry, 'role_mismatch', 'Role does not match invigilator master role.'));
      return;
    }

    sessionMatchSet.add(sessionMatch.session.id);
    resolvedEntries.push({
      ...entry,
      session: sessionMatch.session,
      person: staffMatch.person,
      role: requestedRole,
      locked: parseLockedCell(entry.Locked, true),
      notes: String(entry.Notes || '').trim(),
      forceReplaceLocked: parseBooleanLike(entry.ForceReplaceLocked, false),
      allowOverstaffing: parseBooleanLike(entry.AllowOverstaffing, false),
    });
  });

  summary.sessionsMatched = sessionMatchSet.size;

  if (mode === 'replace_matching_sessions') {
    const replaceTargets = new Map();
    resolvedEntries.forEach((entry) => {
      const key = `${entry.session.id}|${entry.role}`;
      if (!replaceTargets.has(key)) {
        replaceTargets.set(key, {
          session: entry.session,
          role: entry.role,
          forceReplaceLocked: false,
        });
      }
      if (entry.forceReplaceLocked) {
        replaceTargets.get(key).forceReplaceLocked = true;
      }
    });

    const nextAssignments = [];
    (workingStore.assignments || []).forEach((assignment) => {
      const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
      const target = replaceTargets.get(`${normalized.sessionId}|${normalized.role}`);
      if (!target) {
        nextAssignments.push(normalized);
        return;
      }
      if (normalized.locked && !target.forceReplaceLocked) {
        nextAssignments.push(normalized);
        return;
      }
      summary.assignmentsToRemove += 1;
      summary.removed += 1;
    });
    workingStore.assignments = nextAssignments;
  }

  resolvedEntries.forEach((entry) => {
    const duplicate = (workingStore.assignments || []).find((item) =>
      String(item.sessionId) === String(entry.session.id)
      && String(item.invigilatorId) === String(entry.person.id)
      && String(item.role) === String(entry.role)
    );
    if (duplicate) {
      summary.duplicatesSkipped += 1;
      summary.unchanged += 1;
      return;
    }

    const currentRoleAssignments = (workingStore.assignments || []).filter((item) =>
      String(item.sessionId) === String(entry.session.id) && String(item.role) === String(entry.role)
    );
    const needed = entry.role === 'Doctor'
      ? Number(entry.session.doctorNeeded || 0)
      : Number(entry.session.taNeeded || 0);
    if (currentRoleAssignments.length >= needed && !entry.allowOverstaffing) {
      summary.rejected += 1;
      summary.errors.push(buildCommitteeImportError(entry.rowNumber, entry, 'session_full', `${entry.role} need is already full for this session.`));
      return;
    }

    const eligibility = validateSchedulingAssignmentCandidate(workingStore, entry.session, entry.person);
    if (!eligibility.eligible) {
      const mapped = getSchedulingImportMessageForEligibility(eligibility.reason, {
        currentMinutes: eligibility.currentMinutes,
        newDutyMinutes: getDurationMinutes(entry.session.startTime, entry.session.endTime),
        allowedMinutes: eligibility.hardLimitMinutes || eligibility.allowedMinutes || 0,
      });
      summary.rejected += 1;
      summary.errors.push(buildCommitteeImportError(entry.rowNumber, entry, mapped.reason, mapped.message));
      return;
    }

    const assignment = normalizeAssignmentMetadata({
      id: generateId('asgimp'),
      sessionId: entry.session.id,
      invigilatorId: entry.person.id,
      role: entry.role,
      assignmentSource: 'import',
      locked: entry.locked,
      createdAt: nowIso,
      updatedAt: nowIso,
      notes: entry.notes,
    }, { sourceFallback: 'import', lockedFallback: true });
    workingStore.assignments.push(assignment);
    summary.assignmentsToAdd += 1;
    summary.added += 1;
    if (summary.examples.length < 10) {
      summary.examples.push({
        row: entry.rowNumber,
        sessionId: entry.session.id,
        staffId: entry.person.staffId,
        role: entry.role,
        assignmentSource: 'import',
        locked: assignment.locked,
      });
    }
  });

  return {
    summary,
    nextStore: workingStore,
  };
}

function buildSchedulingActionContext(store) {
  return {
    sessionById: new Map((store.sessions || []).map((session) => [String(session.id), session])),
    invigilatorById: new Map((store.invigilators || []).map((person) => [String(person.id), person])),
    invigilatorByStaffId: new Map((store.invigilators || []).map((person) => [String(person.staffId || ''), person])),
    assignmentById: new Map((store.assignments || []).map((assignment) => [String(assignment.id), assignment])),
  };
}

function validateSchedulingAssignmentCandidate(store, session, person, assignmentIdToIgnore = '') {
  const context = buildSchedulingIndexes(store);
  if (assignmentIdToIgnore) {
    context.assignmentsBySessionId = new Map(Array.from(context.assignmentsBySessionId.entries()).map(([key, rows]) => [
      key,
      rows.filter((row) => String(row.id) !== String(assignmentIdToIgnore)),
    ]));
    context.assignmentsByInvigilatorId = new Map(Array.from(context.assignmentsByInvigilatorId.entries()).map(([key, rows]) => [
      key,
      rows.filter((row) => String(row.id) !== String(assignmentIdToIgnore)),
    ]));
    const filteredAssignments = (store.assignments || []).filter((row) => String(row.id) !== String(assignmentIdToIgnore));
    const sessionDurationById = new Map((store.sessions || []).map((item) => [item.id, getDurationMinutes(item.startTime, item.endTime)]));
    const assignedMinutesByInvigilator = new Map(context.assignedMinutesByInvigilator);
    const removed = (store.assignments || []).find((row) => String(row.id) === String(assignmentIdToIgnore));
    if (removed) {
      assignedMinutesByInvigilator.set(
        removed.invigilatorId,
        Math.max(0, Number(assignedMinutesByInvigilator.get(removed.invigilatorId) || 0) - Number(sessionDurationById.get(removed.sessionId) || 0))
      );
    }
    context.assignedMinutesByInvigilator = assignedMinutesByInvigilator;
    context.store = { ...store, assignments: filteredAssignments };
  }
  return getEligibilityForSession(store, session, person, context);
}

function processSchedulingAssignmentActions(store, rows, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const summary = {
    rowsRead: rows.length,
    added: 0,
    updated: 0,
    removed: 0,
    locked: 0,
    unlocked: 0,
    rejected: 0,
    unchanged: 0,
    warnings: [],
    errors: [],
    examples: [],
  };
  const workingStore = cloneStoreState(store);
  const nowIso = new Date().toISOString();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const action = normalizeAssignmentAction(row.Action ?? row.action);
    if (!action) {
      summary.rejected += 1;
      summary.errors.push(summarizeSchedulingImportError(rowNumber, '', row, 'invalid_action', 'Action must be ADD, UPDATE, REMOVE, LOCK, or UNLOCK.'));
      return;
    }

    const context = buildSchedulingActionContext(workingStore);
    const assignmentId = String(row.AssignmentID ?? row.assignmentId ?? '').trim();
    const sessionId = String(row.SessionID ?? row.sessionId ?? '').trim();
    const staffId = String(row.StaffID ?? row.staffId ?? '').trim();
    const role = String(row.Role ?? row.role ?? '').trim();
    const notes = String(row.Notes ?? row.notes ?? '').trim();
    const forceRemove = String(row.ForceRemove ?? row.forceRemove ?? '').trim().toUpperCase() === 'YES';

    if (action === 'LOCK' || action === 'UNLOCK') {
      const assignment = context.assignmentById.get(assignmentId);
      if (!assignment) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'unknown_assignment', 'AssignmentID not found.'));
        return;
      }
      const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
      const nextLocked = action === 'LOCK';
      if (normalized.locked === nextLocked) {
        summary.unchanged += 1;
        return;
      }
      assignment.locked = nextLocked;
      assignment.updatedAt = nowIso;
      if (notes) assignment.notes = notes;
      if (nextLocked) {
        summary.locked += 1;
      } else {
        summary.unlocked += 1;
      }
      if (summary.examples.length < 10) {
        summary.examples.push({ row: rowNumber, action, assignmentId, locked: nextLocked });
      }
      return;
    }

    if (action === 'REMOVE') {
      const assignment = context.assignmentById.get(assignmentId);
      if (!assignment) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'unknown_assignment', 'AssignmentID not found.'));
        return;
      }
      const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
      if (normalized.locked && !forceRemove) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'locked_assignment_requires_force', 'Locked assignment requires ForceRemove=YES.'));
        return;
      }
      workingStore.assignments = workingStore.assignments.filter((item) => String(item.id) !== assignmentId);
      summary.removed += 1;
      if (summary.examples.length < 10) {
        summary.examples.push({ row: rowNumber, action, assignmentId });
      }
      return;
    }

    if (action === 'ADD') {
      const session = context.sessionById.get(sessionId);
      if (!session) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'unknown_session', 'SessionID not found.'));
        return;
      }
      const person = context.invigilatorByStaffId.get(staffId);
      if (!person) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'unknown_staff', 'StaffID not found.'));
        return;
      }
      const requestedRole = role ? normalizeRole(role) : person.role;
      if (requestedRole !== person.role) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'role_mismatch', 'Role does not match staff role.'));
        return;
      }
      const duplicate = (workingStore.assignments || []).find((item) => item.sessionId === session.id && item.invigilatorId === person.id && item.role === person.role);
      if (duplicate) {
        summary.unchanged += 1;
        return;
      }
      const currentRoleAssignments = (workingStore.assignments || []).filter((item) => item.sessionId === session.id && item.role === person.role);
      const needed = person.role === 'Doctor' ? Number(session.doctorNeeded || 0) : Number(session.taNeeded || 0);
      if (currentRoleAssignments.length >= needed) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'session_full', `${person.role} need is already full for this session.`));
        return;
      }
      const eligibility = validateSchedulingAssignmentCandidate(workingStore, session, person);
      if (!eligibility.eligible) {
        const mapped = getSchedulingImportMessageForEligibility(eligibility.reason, {
          currentMinutes: eligibility.currentMinutes,
          newDutyMinutes: getDurationMinutes(session.startTime, session.endTime),
          allowedMinutes: eligibility.hardLimitMinutes || eligibility.allowedMinutes || 0,
        });
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, mapped.reason, mapped.message));
        return;
      }
      const assignment = normalizeAssignmentMetadata({
        id: generateId('asgimp'),
        sessionId: session.id,
        invigilatorId: person.id,
        role: person.role,
        assignmentSource: 'import',
        locked: parseLockedCell(row.Locked ?? row.locked, true),
        createdAt: nowIso,
        updatedAt: nowIso,
        notes,
      }, { sourceFallback: 'import', lockedFallback: true });
      workingStore.assignments.push(assignment);
      summary.added += 1;
      if (summary.examples.length < 10) {
        summary.examples.push({ row: rowNumber, action, assignmentId: assignment.id, sessionId: assignment.sessionId, staffId: person.staffId });
      }
      return;
    }

    if (action === 'UPDATE') {
      const assignment = context.assignmentById.get(assignmentId);
      if (!assignment) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'unknown_assignment', 'AssignmentID not found.'));
        return;
      }
      const normalized = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
      const session = context.sessionById.get(normalized.sessionId);
      if (!session) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'unknown_session', 'Assignment session not found.'));
        return;
      }
      let person = context.invigilatorById.get(normalized.invigilatorId);
      if (staffId) {
        person = context.invigilatorByStaffId.get(staffId);
        if (!person) {
          summary.rejected += 1;
          summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'unknown_staff', 'StaffID not found.'));
          return;
        }
      }
      if (!person) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'unknown_staff', 'Assignment staff not found.'));
        return;
      }
      const requestedRole = role ? normalizeRole(role) : person.role;
      if (requestedRole !== person.role) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'role_mismatch', 'Role does not match staff role.'));
        return;
      }
      const currentRoleAssignments = (workingStore.assignments || []).filter((item) => item.sessionId === session.id && item.role === requestedRole && String(item.id) !== assignmentId);
      const needed = requestedRole === 'Doctor' ? Number(session.doctorNeeded || 0) : Number(session.taNeeded || 0);
      if (currentRoleAssignments.length >= needed) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'session_full', `${requestedRole} need is already full for this session.`));
        return;
      }
      const duplicate = (workingStore.assignments || []).find((item) =>
        String(item.id) !== assignmentId
        && item.sessionId === session.id
        && item.invigilatorId === person.id
        && item.role === requestedRole
      );
      if (duplicate) {
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, 'already_assigned', 'Target staff is already assigned to this session and role.'));
        return;
      }
      const eligibility = validateSchedulingAssignmentCandidate(workingStore, session, person, assignmentId);
      if (!eligibility.eligible && String(person.id) !== String(normalized.invigilatorId)) {
        const mapped = getSchedulingImportMessageForEligibility(eligibility.reason, {
          currentMinutes: eligibility.currentMinutes,
          newDutyMinutes: getDurationMinutes(session.startTime, session.endTime),
          allowedMinutes: eligibility.hardLimitMinutes || eligibility.allowedMinutes || 0,
        });
        summary.rejected += 1;
        summary.errors.push(summarizeSchedulingImportError(rowNumber, action, row, mapped.reason, mapped.message));
        return;
      }
      const nextLocked = row.Locked === undefined && row.locked === undefined
        ? normalized.locked
        : parseLockedCell(row.Locked ?? row.locked, normalized.locked);
      const changed = (
        String(normalized.invigilatorId) !== String(person.id)
        || String(normalized.role) !== String(requestedRole)
        || normalized.locked !== nextLocked
        || notes !== (normalized.notes || '')
      );
      if (!changed) {
        summary.unchanged += 1;
        return;
      }
      assignment.invigilatorId = person.id;
      assignment.role = requestedRole;
      assignment.locked = nextLocked;
      assignment.updatedAt = nowIso;
      assignment.notes = notes;
      summary.updated += 1;
      if (summary.examples.length < 10) {
        summary.examples.push({ row: rowNumber, action, assignmentId, staffId: person.staffId, locked: nextLocked });
      }
      return;
    }
  });

  return {
    summary,
    nextStore: workingStore,
  };
}

function makeSuperAssignmentRows(store) {
  const invigilatorById = new Map(store.invigilators.map((person) => [person.id, person]));
  const dayWindowByDate = new Map(buildDutyCollections(store).dayWindows.map((window) => [window.date, window]));
  const workloadById = new Map(buildWorkloadView(store).map((row) => [row.id, row]));
  return store.superAssignments.map((assignment) => {
    const person = invigilatorById.get(assignment.invigilatorId);
    const dayWindow = dayWindowByDate.get(assignment.date);
    const workload = workloadById.get(assignment.invigilatorId);
    return {
      AssignmentID: assignment.id || '',
      Date: assignment.date || '',
      Start: dayWindow?.startTime || '',
      End: dayWindow?.endTime || '',
      DurationHours: dayWindow ? Math.round((Number(dayWindow.durationMinutes || 0) / 60) * 100) / 100 : 0,
      StaffID: person?.staffId || '',
      Name: person?.name || '',
      Role: person?.role || 'Doctor',
      CurrentAssignedHours: workload ? Math.round((Number(workload.totalMinutes || 0) / 60) * 100) / 100 : 0,
    };
  });
}

function makeControlSessionRows(controlSessions) {
  return controlSessions.map((session) => ({
    ControlSessionID: session.id || '',
    CourseCode: formatCourseNames(session.courseNames?.length ? session.courseNames : session.courseName),
    Room: session.room || '',
    Date: session.date || '',
    Start: session.startTime || '',
    End: session.endTime || '',
    TANeeded: Number(session.taNeeded || 0),
    DoctorNeeded: Number(session.doctorNeeded || 0),
    InvigilatorsNeeded: Number(session.totalNeeded || ((session.taNeeded || 0) + (session.doctorNeeded || 0))),
    Notes: session.notes || '',
  }));
}

function makeControlAssignmentRows(store) {
  const sessionById = new Map(store.controlSessions.map((session) => [session.id, session]));
  const invigilatorById = new Map(store.invigilators.map((person) => [person.id, person]));
  const workloadById = new Map(buildWorkloadView(store).map((row) => [row.id, row]));

  return store.controlAssignments.map((assignment) => {
    const session = sessionById.get(assignment.controlSessionId);
    const person = invigilatorById.get(assignment.invigilatorId);
    const workload = workloadById.get(assignment.invigilatorId);
    return {
      AssignmentID: assignment.id || '',
      ControlSessionID: assignment.controlSessionId || '',
      StaffID: person?.staffId || '',
      Name: person?.name || '',
      Role: assignment.role || person?.role || '',
      CourseCode: formatCourseNames(session?.courseNames?.length ? session.courseNames : session?.courseName),
      Room: session?.room || '',
      Date: session?.date || '',
      Start: session?.startTime || '',
      End: session?.endTime || '',
      DurationHours: session ? Math.round((getDurationMinutes(session.startTime, session.endTime) / 60) * 100) / 100 : 0,
      CurrentAssignedHours: workload ? Math.round((Number(workload.totalMinutes || 0) / 60) * 100) / 100 : 0,
    };
  });
}

function buildControlSessionTemplateRows() {
  return [{
    ControlSessionID: '',
    CourseCode: 'Control Session',
    Room: 'Control',
    Date: '2026-06-15',
    Start: '09:00',
    End: '13:00',
    TANeeded: 2,
    DoctorNeeded: 1,
    InvigilatorsNeeded: 3,
    Notes: 'Example control session row',
  }];
}

function buildControlAssignmentTemplateRows() {
  return [{
    AssignmentID: '',
    ControlSessionID: '',
    StaffID: '2058',
    Name: 'Example Invigilator',
    Role: 'TA',
    CourseCode: 'Control Session',
    Room: 'Control',
    Date: '2026-06-15',
    Start: '09:00',
    End: '13:00',
    DurationHours: 4,
    CurrentAssignedHours: '',
    Notes: 'Example control assignment row',
  }];
}

function buildControlSessionTemplateInstructionsRows() {
  return [
    { Section: 'Purpose', Instruction: 'Use this template to import control sessions and/or control assignment load.' },
    { Section: 'ControlSessions', Instruction: 'Import master control session rows through the ControlSessions sheet.' },
    { Section: 'ControlAssignments', Instruction: 'Import staff load assignments through the ControlAssignments sheet.' },
    { Section: 'Matching', Instruction: 'Control assignments match by ControlSessionID first, then Room + Date + Start.' },
    { Section: 'Staff', Instruction: 'StaffID is recommended. Name-only matching must be exact and unique.' },
    { Section: 'Scope', Instruction: 'This import affects control sessions and control assignments only. It does not modify scheduling sessions or invigilator master data.' },
  ];
}

function processControlAssignmentImportRows(store, rows) {
  const summary = {
    rowsRead: rows.length,
    added: 0,
    rejected: 0,
    unchanged: 0,
    warnings: [],
    errors: [],
    examples: [],
  };
  const nextStore = {
    ...store,
    controlAssignments: [...(store.controlAssignments || [])],
  };
  const controlSessionById = new Map((store.controlSessions || []).map((item) => [String(item.id), item]));
  const controlSessionByKey = new Map((store.controlSessions || []).map((item) => [
    `${String(item.room || '').trim()}|${String(item.date || '').trim()}|${String(item.startTime || '').trim()}`,
    item,
  ]));
  const invigilatorById = new Map((store.invigilators || []).map((item) => [String(item.id), item]));
  const invigilatorByStaffId = new Map((store.invigilators || []).map((item) => [String(item.staffId || ''), item]));
  const invigilatorsByName = new Map();
  (store.invigilators || []).forEach((item) => {
    const key = String(item.name || '').trim();
    if (!key) return;
    const list = invigilatorsByName.get(key) || [];
    list.push(item);
    invigilatorsByName.set(key, list);
  });

  const appendError = (index, row, reason, message) => {
    const entry = {
      row: index + 1,
      controlSessionId: String(row.ControlSessionID ?? row.controlSessionId ?? '').trim(),
      staffId: String(row.StaffID ?? row.staffId ?? '').trim(),
      role: String(row.Role ?? row.role ?? '').trim(),
      reason,
      message,
    };
    summary.errors.push(entry);
    if (summary.examples.length < 10) {
      summary.examples.push(entry);
    }
    summary.rejected += 1;
  };

  rows.forEach((row, index) => {
    const controlSessionId = String(row.ControlSessionID ?? row.controlSessionID ?? row.controlSessionId ?? '').trim();
    const room = String(row.Room ?? row.room ?? '').trim();
    const date = normalizeDate(row.Date ?? row.date, row.Day ?? row.day);
    const startTime = normalizeTime(row.Start ?? row.startTime ?? row.start_time);
    const staffId = String(row.StaffID ?? row.staffId ?? '').trim();
    const invigilatorIdInput = String(row.InvigilatorID ?? row.invigilatorId ?? '').trim();
    const name = String(row.Name ?? row.StaffName ?? row.staffName ?? '').trim();
    const roleInput = String(row.Role ?? row.role ?? '').trim();

    const controlSession = controlSessionId
      ? controlSessionById.get(controlSessionId)
      : controlSessionByKey.get(`${room}|${date}|${startTime}`);
    if (!controlSession) {
      appendError(index, row, 'unknown_control_session', 'Control session not found.');
      return;
    }

    let person = null;
    if (staffId) {
      person = invigilatorByStaffId.get(staffId) || null;
    } else if (invigilatorIdInput) {
      person = invigilatorById.get(invigilatorIdInput) || null;
    } else if (name) {
      const matches = invigilatorsByName.get(name) || [];
      if (matches.length > 1) {
        appendError(index, row, 'ambiguous_staff_name', 'Staff name matches more than one invigilator.');
        return;
      }
      person = matches[0] || null;
    }
    if (!person) {
      appendError(index, row, 'unknown_staff', 'Invigilator not found.');
      return;
    }

    const resolvedRole = roleInput ? normalizeRole(roleInput) : normalizeRole(person.role);
    if (resolvedRole !== normalizeRole(person.role)) {
      appendError(index, row, 'role_mismatch', 'Role does not match invigilator role.');
      return;
    }

    const duplicate = (nextStore.controlAssignments || []).some((item) =>
      String(item.controlSessionId) === String(controlSession.id)
      && String(item.invigilatorId) === String(person.id)
    );
    if (duplicate) {
      summary.unchanged += 1;
      return;
    }

    const existingRoleCount = (nextStore.controlAssignments || []).filter((item) =>
      String(item.controlSessionId) === String(controlSession.id)
      && normalizeRole(item.role) === resolvedRole
    ).length;
    const roleNeed = resolvedRole === 'Doctor'
      ? Number(controlSession.doctorNeeded || 0)
      : Number(controlSession.taNeeded || 0);
    if (roleNeed > 0 && existingRoleCount >= roleNeed) {
      appendError(index, row, 'session_full', 'Control session role need is already full.');
      return;
    }

    const regularizedSession = {
      id: `control_import_${controlSession.id}`,
      room: controlSession.room,
      courseName: controlSession.courseName,
      courseNames: controlSession.courseNames,
      startTime: controlSession.startTime,
      endTime: controlSession.endTime,
      date: controlSession.date,
    };
    const eligibility = getEligibilityForSession(store, regularizedSession, person, buildSchedulingIndexes(store));
    if (!eligibility.eligible && eligibility.reason !== 'already_assigned') {
      appendError(index, row, eligibility.reason === 'policy_limit' ? 'staff_hour_policy_exceeded' : eligibility.reason, 'Invigilator cannot be assigned to this control session.');
      return;
    }

    nextStore.controlAssignments.push({
      id: generateId('ctlasgimp'),
      controlSessionId: controlSession.id,
      invigilatorId: person.id,
      role: normalizeRole(person.role),
    });
    summary.added += 1;
  });

  return { nextStore, summary };
}

function makeOnCallNeedRows(store) {
  return buildOnCallNeeds(store).map((need) => ({
    Date: need.date,
    Start: need.startTime,
    End: need.endTime,
    ActiveRooms: Number(need.activeRoomCount || 0),
    OnCallTANeeded: Number(need.onCallTANeeded || 0),
    OnCallDoctorNeeded: Number(need.onCallDoctorNeeded || 0),
    Rooms: Array.isArray(need.rooms) ? need.rooms.join('; ') : '',
  }));
}

function makeOnCallAssignmentRows(store) {
  const invigilatorById = new Map(store.invigilators.map((person) => [person.id, person]));
  return (store.onCallAssignments || []).map((assignment) => {
    const person = invigilatorById.get(assignment.invigilatorId);
    return {
      AssignmentID: assignment.id || '',
      EngagementOverrideReason: assignment.engagementOverrideReason || '',
      Date: assignment.date || '',
      Start: assignment.startTime || '',
      End: assignment.endTime || '',
      StaffID: person?.staffId || '',
      Name: person?.name || '',
      Role: assignment.role || person?.role || '',
    };
  });
}

function makeStaffHourPolicyRows(store) {
  const summary = buildStaffHourPolicySummary(store);
  const workloadById = new Map(buildWorkloadView(store).map((row) => [row.id, row]));
  return store.invigilators.map((person) => {
    const policy = (store.staffHourPolicies || []).find((item) => item.invigilatorId === person.id) || {};
    const effective = summary.effectivePolicyByInvigilatorId.get(person.id);
    const workload = makeStaffHourWorkloadFields(workloadById.get(person.id), effective);
    return {
      PolicyID: policy.id || '',
      InvigilatorID: person.id,
      StaffID: policy.staffId || person?.staffId || '',
      Name: person?.name || '',
      Role: policy.role || person?.role || '',
      Mode: policy.mode || 'default',
      HoursValue: Number(policy.hoursValue || 0),
      MaxHours: Number(person.maxHours || 0),
      SessionHours: workload.sessionHours,
      OnCallHours: workload.onCallHours,
      SuperHours: workload.superHours,
      ControlHours: workload.controlHours,
      CurrentAssignedHours: workload.currentAssignedHours,
      RemainingHours: workload.remainingHours ?? '',
      RoleAverageHours: effective?.rawAverageHours ?? 0,
      EffectiveAllowedHours: effective?.allowedHours ?? 0,
      EffectiveLimitHours: effective?.hasHardLimit ? effective.hardLimitHours : '',
      ExcludeFromAutoSchedule: policy.excludeFromAutoSchedule ? 'Yes' : 'No',
      PreferConsecutiveDuties: policy.preferConsecutiveDuties ? 'Yes' : 'No',
      PreferConsecutiveDays: policy.preferConsecutiveDays ? 'Yes' : 'No',
      AllowEngagementOverride: policy.allowEngagementOverride === false ? 'No' : 'Yes',
      Notes: policy.notes || '',
    };
  });
}

function makeStaffHourWorkloadFields(workload, effective) {
  const hours = (minutes) => Math.round((Number(minutes || 0) / 60) * 100) / 100;
  const currentAssignedMinutes = Number(workload?.totalMinutes || 0);
  return {
    currentAssignedMinutes,
    currentAssignedHours: hours(currentAssignedMinutes),
    sessionHours: hours(workload?.sessionMinutes),
    onCallHours: hours(workload?.onCallMinutes),
    superHours: hours(workload?.superMinutes),
    controlHours: hours(workload?.controlMinutes),
    onCallCount: Number(workload?.onCallCount || 0),
    remainingHours: effective?.hasHardLimit ? hours(Math.max(0, effective.hardLimitMinutes - currentAssignedMinutes)) : null,
  };
}

function makeStaffHourPolicyInstructions() {
  return [
    { Topic: 'Editing', Instruction: 'Edit the StaffHourPolicies sheet, then import this workbook. StaffID identifies staff; keep IDs as text, including leading zeros. Names and roles are reference only.' },
    { Topic: 'Modes', Instruction: 'Mode is required: default uses the flexible role average; exact sets a strict hour limit; add/reduce adjust the current role average; exclude blocks automatic assignment.' },
    { Topic: 'HoursValue', Instruction: 'Enter non-negative hours for exact/add/reduce. Decimals and zero are supported. A blank value is permitted only for default/exclude.' },
    { Topic: 'Exclusion', Instruction: 'ExcludeFromAutoSchedule accepts Yes/No, True/False, or 1/0. Blank means No; mode exclude always excludes.' },
    { Topic: 'Continuity', Instruction: 'PreferConsecutiveDuties minimizes idle minutes within days. PreferConsecutiveDays minimizes calendar days off between working dates. Each accepts Yes/No, True/False or 1/0; blank means No. Both respect all other policies; engagements may be overridden only when AllowEngagementOverride is Yes. Coverage comes first.' },
    { Topic: 'Engagement override', Instruction: 'AllowEngagementOverride defaults to Yes, including for existing staff. Yes allows automatic assignments during engagements to fill shortages or improve workload balance. No keeps engagements strict. Other policies, hour limits, exclusions and duty overlaps remain strict. Overrides are listed in preview and export; availability records are retained.' },
    { Topic: 'Updates', Instruction: 'Only listed staff are updated. One row per staff member. Existing policies keep their IDs. Blank Notes clears notes. To reset a policy, use Mode default, HoursValue 0, No for exclusion and both consecutive preferences, and blank Notes.' },
    { Topic: 'Reference columns', Instruction: 'PolicyID and InvigilatorID are identifiers. Name, Role, MaxHours, workload hours, RoleAverageHours, EffectiveAllowedHours and EffectiveLimitHours are reference values; editing them does not change staff or calculated hours.' },
    { Topic: 'Workload', Instruction: 'CurrentAssignedHours includes SessionHours + OnCallHours + SuperHours + ControlHours. On-call duties use their full duration and count once. RemainingHours is the remaining hard-limit capacity across all duties; blank means no fixed cap. Role averages include required on-call staffing, including unfilled on-call needs.' },
    { Topic: 'Scheduling', Instruction: 'Policies affect total duties and recalculate from current needs. Import does not change existing assignments; rerun scheduling when ready.' },
  ];
}

function makeStaffHourPolicyTemplateRows() {
  return [
    {
      StaffID: 'TA001',
      Name: 'Example TA',
      Role: 'TA',
      Mode: 'exact',
      HoursValue: 12,
      ExcludeFromAutoSchedule: 'No',
      Notes: 'Exact allowed hours example',
      PreferConsecutiveDuties: 'Yes',
      PreferConsecutiveDays: 'No',
      AllowEngagementOverride: 'Yes',
    },
    {
      StaffID: 'DR003',
      Name: 'Example Doctor',
      Role: 'Doctor',
      Mode: 'reduce',
      HoursValue: 3,
      ExcludeFromAutoSchedule: 'No',
      Notes: 'Reduce from role average by 3 hours',
      PreferConsecutiveDuties: 'No',
      PreferConsecutiveDays: 'Yes',
      AllowEngagementOverride: 'Yes',
    },
    {
      StaffID: 'DR004',
      Name: 'Excluded Doctor',
      Role: 'Doctor',
      Mode: 'exclude',
      HoursValue: 0,
      ExcludeFromAutoSchedule: 'Yes',
      Notes: 'Do not assign in auto-schedule',
      PreferConsecutiveDuties: 'No',
      PreferConsecutiveDays: 'No',
      AllowEngagementOverride: 'Yes',
    },
  ];
}

function parseStaffHourPolicyMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['default', 'exact', 'add', 'reduce', 'exclude'].includes(mode) ? mode : '';
}

function parseBooleanFlag(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(raw);
}

function buildStaffHourPolicyWarnings(store) {
  const summary = buildStaffHourPolicySummary(store);
  const workloadRows = buildWorkloadView(store);
  return workloadRows
    .map((row) => {
      const policy = summary.effectivePolicyByInvigilatorId.get(row.id);
      if (!policy) return null;
      if (policy.excluded && Number(row.totalMinutes || 0) > 0) {
        return `${row.name} is excluded but already has ${Math.round((row.totalMinutes / 60) * 100) / 100} assigned hours.`;
      }
      if (policy.hasHardLimit && Number(row.totalMinutes || 0) > policy.hardLimitMinutes) {
        return `${row.name} exceeds allowed hours (${Math.round((row.totalMinutes / 60) * 100) / 100} > ${policy.hardLimitHours}).`;
      }
      return null;
    })
    .filter(Boolean)
    .concat(buildStaffContinuityView(store).map(staffContinuityWarning).filter(Boolean));
}

function staffContinuityWarning(row) {
  const gaps = [];
  if (row.preferConsecutiveDays && row.workingDayGaps) gaps.push(`${row.workingDayGaps} days off between working dates`);
  if (row.preferConsecutiveDuties && row.idleMinutes) gaps.push(`${row.idleMinutes} idle minutes within working days`);
  return gaps.length ? `${row.name}: ${gaps.join('; ')}. Consecutive scheduling is a preference; existing duties are retained.` : '';
}

function assignmentContinuityWarning(store, invigilatorId) {
  const row = buildStaffContinuityView(store).find((item) => item.invigilatorId === invigilatorId);
  return row ? staffContinuityWarning(row) : '';
}

function normalizeStaffHourPolicyInput(store, payload = {}, existingId = '') {
  const invigilatorById = new Map(store.invigilators.map((item) => [item.id, item]));
  const invigilatorByStaffId = new Map(store.invigilators.map((item) => [String(item.staffId || '').trim(), item]));
  const mode = parseStaffHourPolicyMode(payload.mode);
  if (!mode) {
    throw new Error('Invalid policy mode. Use default, exact, add, reduce, or exclude.');
  }
  const staffId = String(payload.staffId || '').trim();
  const invigilatorId = String(payload.invigilatorId || '').trim();
  const person = (staffId && invigilatorByStaffId.get(staffId)) || (invigilatorId && invigilatorById.get(invigilatorId));
  if (!person) {
    throw new Error('Unknown StaffID / invigilator for staff hour policy.');
  }
  const hoursValue = Number(payload.hoursValue ?? payload.hours_value ?? 0);
  if (!Number.isFinite(hoursValue) || hoursValue < 0) {
    throw new Error('HoursValue must be a non-negative number.');
  }
  return normalizeStaffHourPolicyRow({
    id: existingId || payload.id || generateId('hourpol'),
    invigilatorId: person.id,
    staffId: String(person.staffId || ''),
    role: person.role,
    mode,
    hoursValue,
    excludeFromAutoSchedule: mode === 'exclude' || parseBooleanFlag(payload.excludeFromAutoSchedule ?? payload.ExcludeFromAutoSchedule),
    preferConsecutiveDuties: parseBooleanFlag(payload.preferConsecutiveDuties ?? payload.PreferConsecutiveDuties ?? payload.prefer_consecutive_duties),
    preferConsecutiveDays: parseBooleanFlag(payload.preferConsecutiveDays ?? payload.PreferConsecutiveDays ?? payload.prefer_consecutive_days),
    allowEngagementOverride: parseBooleanFlag(payload.allowEngagementOverride ?? payload.AllowEngagementOverride ?? payload.allow_engagement_override ?? true),
    notes: String(payload.notes ?? payload.Notes ?? '').trim(),
  }, new Map(store.invigilators.map((item) => [String(item.staffId || ''), item.id])));
}

function getAssignedMinutesByInvigilator(store) {
  const totals = new Map();

  store.assignments.forEach((assignment) => {
    const session = store.sessions.find((item) => item.id === assignment.sessionId);
    if (!session) return;
    totals.set(
      assignment.invigilatorId,
      (totals.get(assignment.invigilatorId) || 0) + getDurationMinutes(session.startTime, session.endTime)
    );
  });

  const dayWindows = getDayWindows(store.sessions);
  const windowMap = new Map(dayWindows.map((item) => [item.date, item]));
  const controlSessionMap = new Map(store.controlSessions.map((item) => [item.id, item]));

  store.superAssignments.forEach((assignment) => {
    const window = windowMap.get(assignment.date);
    if (!window) return;
    totals.set(
      assignment.invigilatorId,
      (totals.get(assignment.invigilatorId) || 0) + Number(window.durationMinutes || 0)
    );
  });

  store.controlAssignments.forEach((assignment) => {
    const controlSession = controlSessionMap.get(assignment.controlSessionId);
    const durationMinutes = controlSession
      ? getDurationMinutes(controlSession.startTime, controlSession.endTime)
      : Number(windowMap.get(assignment.date)?.durationMinutes || 0);
    totals.set(
      assignment.invigilatorId,
      (totals.get(assignment.invigilatorId) || 0) + durationMinutes
    );
  });

  return totals;
}

function makeWorkbookFile(sheets, prefix) {
  const workbook = XLSX.utils.book_new();
  const sheetStats = [];
  for (const sheet of sheets) {
    const actualRows = Array.isArray(sheet.rows) ? sheet.rows.length : 0;
    const rows = actualRows
      ? sheet.rows
      : [{ Notice: 'No data' }];
    sheetStats.push({
      name: sheet.name,
      actualRows,
      renderedRows: rows.length,
      placeholderOnly: actualRows === 0,
    });
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), sheet.name);
  }
  const fileName = `${Date.now()}_${prefix}.xlsx`;
  const fullPath = path.join(tempDir, fileName);
  XLSX.writeFile(workbook, fullPath);
  const stat = fs.statSync(fullPath);
  return {
    fileName,
    url: `/api/temp/${fileName}`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: stat.size,
    sheetStats,
  };
}

function remapAssignmentsToImportedSessions(existingStore, importedSessions) {
  const importedByBlock = new Map(importedSessions.map((session) => [getSessionRoomStartKey(session), session]));
  const existingById = new Map(existingStore.sessions.map((session) => [String(session.id), session]));

  let remapped = 0;
  let dropped = 0;
  const nextAssignments = [];

  (existingStore.assignments || []).forEach((assignment) => {
    const existingSession = existingById.get(String(assignment.sessionId));
    if (!existingSession) {
      dropped += 1;
      return;
    }
    const targetSession = importedByBlock.get(getSessionRoomStartKey(existingSession));
    if (!targetSession) {
      dropped += 1;
      return;
    }
    if (String(targetSession.id) !== String(assignment.sessionId)) {
      remapped += 1;
    }
    nextAssignments.push({
      ...assignment,
      sessionId: targetSession.id,
    });
  });

  return { assignments: nextAssignments, remapped, dropped };
}

function pruneInvalidOnCallAssignments(store) {
  const validInvigilatorIds = new Set((store.invigilators || []).map((item) => item.id));
  const validPeriodKeys = new Set(buildOnCallNeeds(store).map((item) => `${item.date}|${item.startTime}|${item.endTime}`));
  const before = Array.isArray(store.onCallAssignments) ? store.onCallAssignments.length : 0;
  store.onCallAssignments = (store.onCallAssignments || [])
    .filter((item) => validInvigilatorIds.has(item.invigilatorId))
    .filter((item) => validPeriodKeys.has(`${item.date}|${item.startTime}|${item.endTime}`));
  return before - store.onCallAssignments.length;
}

app.get('/api/dashboard', (_req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const buildStart = perfNow();
  const payload = getCachedDerivedView('dashboardView', () => {
    const dayWindows = getDayWindows(store.sessions);
    const scheduling = buildSchedulingView(store);
    const onCallSummary = buildOnCallSummary(store);
    const hourPolicySummary = buildStaffHourPolicySummary(store);
    const workloadRows = buildWorkloadView(store);
    const customPolicyCount = (store.staffHourPolicies || []).length;
    const excludedStaffCount = workloadRows.filter((row) => row.excludeFromAutoSchedule).length;
    const overLimitStaffCount = workloadRows.filter((row) => row.policyStatus === 'over target').length;
    return {
      totals: {
        sessions: store.sessions.length,
        invigilators: store.invigilators.length,
        doctors: store.invigilators.filter((item) => item.role === 'Doctor').length,
        tas: store.invigilators.filter((item) => item.role === 'TA').length,
        assignedSessionDuties: store.assignments.length,
        onCallPeriods: onCallSummary.periodCount,
        onCallAssignments: onCallSummary.assignmentCount,
        superAssignments: store.superAssignments.length,
        controlAssignments: store.controlAssignments.length,
        engagements: store.engagements.length,
        customHourPolicies: customPolicyCount,
        excludedStaff: excludedStaffCount,
        overLimitStaff: overLimitStaffCount,
      },
      openNeeds: scheduling.sessions.reduce((acc, item) => ({
        ta: acc.ta + item.taRemaining,
        doctor: acc.doctor + item.doctorRemaining
      }), { ta: 0, doctor: 0 }),
      onCallNeeds: {
        ta: onCallSummary.shortage.ta,
        doctor: onCallSummary.shortage.doctor,
        total: onCallSummary.totalShortage,
      },
      hourAverages: hourPolicySummary.rawAverageHoursByRole,
      dayWindows
    };
  });
  sendJsonWithPerf(_req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.get('/api/system/storage-status', async (_req, res) => {
  const totalStart = perfNow();
  try {
    const buildStart = perfNow();
    const payload = await getStorageStatus();
    sendJsonWithPerf(_req, res, payload, {
      totalMs: perfMs(totalStart),
      readStoreMs: 0,
      buildMs: perfMs(buildStart),
      cacheStatus: 'none',
    });
  } catch (error) {
    res.status(500).json({
      health: 'error',
      startup: getStartupStorageInfo(),
      error: error.message,
    });
  }
});

app.get('/api/sessions', (_req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const buildStart = perfNow();
  const payload = getCachedDerivedView('sessionsView', () => store.sessions);
  sendJsonWithPerf(_req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.post('/api/sessions', (req, res) => {
  const store = readStore();
  const payload = req.body || {};
  if (!payload.date || !payload.startTime || !payload.endTime) {
    return respondError(res, 'Date, start time, and end time are required.');
  }

  const session = {
    id: generateId('ses'),
    courseNames: normalizeCourseNames(readCourseInput(payload)),
    courseName: formatCourseNames(readCourseInput(payload)),
    room: String(readRoomInput(payload)).trim(),
    date: normalizeDate(payload.date),
    startTime: normalizeTime(payload.startTime),
    endTime: normalizeTime(payload.endTime),
    taNeeded: Number(payload.taNeeded || 0),
    doctorNeeded: Number(payload.doctorNeeded || 0),
    totalNeeded: Number(payload.totalNeeded || (Number(payload.taNeeded || 0) + Number(payload.doctorNeeded || 0))),
    notes: String(readNotesInput(payload)).trim()
  };
  store.sessions.push(session);
  pruneInvalidOnCallAssignments(store);
  return persistStoreResponse(res, store, () => res.status(201).json(session));
});

app.put('/api/sessions/:id', (req, res) => {
  const store = readStore();
  const session = store.sessions.find((item) => item.id === req.params.id);
  if (!session) {
    return respondError(res, 'Session not found.', 404);
  }

  Object.assign(session, {
    courseNames: normalizeCourseNames(readCourseInput(req.body)),
    courseName: formatCourseNames(readCourseInput(req.body)),
    room: String(readRoomInput(req.body)).trim(),
    date: normalizeDate(req.body.date || session.date),
    startTime: normalizeTime(req.body.startTime || session.startTime),
    endTime: normalizeTime(req.body.endTime || session.endTime),
    taNeeded: Number(req.body.taNeeded || 0),
    doctorNeeded: Number(req.body.doctorNeeded || 0),
    totalNeeded: Number(req.body.totalNeeded || (Number(req.body.taNeeded || 0) + Number(req.body.doctorNeeded || 0))),
    notes: String(readNotesInput(req.body)).trim()
  });

  pruneInvalidOnCallAssignments(store);
  return persistStoreResponse(res, store, session);
});

app.delete('/api/sessions/:id', (req, res) => {
  const store = readStore();
  store.sessions = store.sessions.filter((item) => item.id !== req.params.id);
  store.assignments = store.assignments.filter((item) => item.sessionId !== req.params.id);
  pruneInvalidOnCallAssignments(store);
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/sessions', (_req, res) => {
  const store = readStore();
  store.sessions = [];
  store.assignments = [];
  store.superAssignments = [];
  store.onCallAssignments = [];
  return persistStoreResponse(res, store, { success: true });
});

app.get('/api/invigilators', (_req, res) => {
  res.json(readStore().invigilators);
});

app.post('/api/invigilators', (req, res) => {
  const store = readStore();
  const payload = req.body || {};
  if (!payload.name || !payload.role) {
    return respondError(res, 'Name and role are required.');
  }
  if (!['TA', 'Doctor'].includes(payload.role)) {
    return respondError(res, 'Role must be TA or Doctor.');
  }

  const person = {
    id: generateId('inv'),
    staffId: String(payload.staffId || payload.name || generateId('staff')).trim(),
    name: String(payload.name).trim(),
    email: String(payload.email || '').trim(),
    role: payload.role,
    loadType: String(payload.loadType || 'full').trim() || 'full',
    department: String(payload.department || '').trim(),
    maxHours: Number(payload.maxHours || 0),
    notes: String(payload.notes || '').trim()
  };

  store.invigilators.push(person);
  pruneInvalidOnCallAssignments(store);
  return persistStoreResponse(res, store, () => res.status(201).json(person));
});

app.put('/api/invigilators/:id', (req, res) => {
  const store = readStore();
  const person = store.invigilators.find((item) => item.id === req.params.id);
  if (!person) {
    return respondError(res, 'Invigilator not found.', 404);
  }
  if (!['TA', 'Doctor'].includes(req.body.role)) {
    return respondError(res, 'Role must be TA or Doctor.');
  }

  Object.assign(person, {
    staffId: String(req.body.staffId || person.staffId || person.id).trim(),
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim(),
    role: req.body.role,
    loadType: String(req.body.loadType || person.loadType || 'full').trim() || 'full',
    department: String(req.body.department || '').trim(),
    maxHours: Number(req.body.maxHours || 0),
    notes: String(req.body.notes || '').trim()
  });

  pruneInvalidOnCallAssignments(store);
  return persistStoreResponse(res, store, person);
});

app.delete('/api/invigilators/:id', (req, res) => {
  const store = readStore();
  const person = store.invigilators.find((item) => item.id === req.params.id);
  store.invigilators = store.invigilators.filter((item) => item.id !== req.params.id);
  store.assignments = store.assignments.filter((item) => item.invigilatorId !== req.params.id);
  store.superAssignments = store.superAssignments.filter((item) => item.invigilatorId !== req.params.id);
  store.controlAssignments = store.controlAssignments.filter((item) => item.invigilatorId !== req.params.id);
  store.onCallAssignments = (store.onCallAssignments || []).filter((item) => item.invigilatorId !== req.params.id);
  store.staffHourPolicies = (store.staffHourPolicies || []).filter((item) => item.invigilatorId !== req.params.id);
  if (person) {
    store.engagements = store.engagements.filter((item) => item.staffId !== person.staffId);
  }
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/invigilators', (_req, res) => {
  const store = readStore();
  store.invigilators = [];
  store.assignments = [];
  store.superAssignments = [];
  store.controlAssignments = [];
  store.onCallAssignments = [];
  store.staffHourPolicies = [];
  store.engagements = [];
  return persistStoreResponse(res, store, { success: true });
});

app.get('/api/staff-hour-policies', (_req, res) => {
  const store = readStore();
  const summary = buildStaffHourPolicySummary(store);
  const workloadRows = buildWorkloadView(store);
  const workloadByInvigilatorId = new Map(workloadRows.map((row) => [row.id, row]));

  res.json({
    invigilators: store.invigilators,
    policies: (store.staffHourPolicies || []),
    averagesByRole: summary.rawAverageHoursByRole,
    totalRequiredHoursByRole: summary.totalRequiredHoursByRole,
    onCallRequiredHoursByRole: summary.onCallRequiredHoursByRole,
    availableStaffCountByRole: summary.availableStaffCountByRole,
    effectivePolicyByStaff: Object.fromEntries(
      Array.from(summary.effectivePolicyByInvigilatorId.entries()).map(([invigilatorId, value]) => [invigilatorId, value])
    ),
    currentWorkloadHoursByStaff: Object.fromEntries(
      workloadRows.map((row) => [row.id, Math.round((Number(row.totalMinutes || 0) / 60) * 100) / 100])
    ),
    warnings: buildStaffHourPolicyWarnings(store),
    rows: store.invigilators.map((person) => ({
      ...person,
      ...makeStaffHourWorkloadFields(workloadByInvigilatorId.get(person.id), summary.effectivePolicyByInvigilatorId.get(person.id)),
      effectivePolicy: summary.effectivePolicyByInvigilatorId.get(person.id) || null,
      policy: (store.staffHourPolicies || []).find((item) => item.invigilatorId === person.id) || null,
    })),
  });
});

app.post('/api/staff-hour-policies', (req, res) => {
  const store = readStore();
  try {
    const normalized = normalizeStaffHourPolicyInput(store, req.body || {}, String(req.body?.id || ''));
    const existingIndex = (store.staffHourPolicies || []).findIndex((item) => item.id === normalized.id || item.invigilatorId === normalized.invigilatorId);
    if (existingIndex >= 0) {
      store.staffHourPolicies[existingIndex] = normalized;
    } else {
      store.staffHourPolicies.push(normalized);
    }
    return persistStoreResponse(res, store, () => res.status(201).json(normalized));
  } catch (error) {
    return respondError(res, error.message);
  }
});

app.delete('/api/staff-hour-policies/:id', (req, res) => {
  const store = readStore();
  store.staffHourPolicies = (store.staffHourPolicies || []).filter((item) => item.id !== req.params.id);
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/staff-hour-policies', (_req, res) => {
  const store = readStore();
  store.staffHourPolicies = [];
  return persistStoreResponse(res, store, { success: true });
});

app.get('/api/engagements', (_req, res) => {
  const store = readStore();
  res.json(store.engagements);
});

app.post('/api/engagements', (req, res) => {
  const store = readStore();
  const payload = req.body || {};
  const engagement = {
    id: generateId('eng'),
    staffId: String(payload.staffId || '').trim(),
    date: normalizeDate(payload.date),
    startTime: normalizeTime(payload.startTime),
    endTime: normalizeTime(payload.endTime),
    engagement: Number(payload.engagement ?? 1),
    notes: String(payload.notes || '').trim()
  };
  store.engagements.push(engagement);
  return persistStoreResponse(res, store, () => res.status(201).json(engagement));
});

app.put('/api/engagements/:id', (req, res) => {
  const store = readStore();
  const row = store.engagements.find((item) => item.id === req.params.id);
  if (!row) {
    return respondError(res, 'Engagement not found.', 404);
  }
  Object.assign(row, {
    staffId: String(req.body.staffId || row.staffId).trim(),
    date: normalizeDate(req.body.date || row.date),
    startTime: normalizeTime(req.body.startTime || row.startTime),
    endTime: normalizeTime(req.body.endTime || row.endTime),
    engagement: Number(req.body.engagement ?? row.engagement ?? 1),
    notes: String(req.body.notes || '').trim()
  });
  return persistStoreResponse(res, store, row);
});

app.delete('/api/engagements/:id', (req, res) => {
  const store = readStore();
  store.engagements = store.engagements.filter((item) => item.id !== req.params.id);
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/engagements', (_req, res) => {
  const store = readStore();
  store.engagements = [];
  return persistStoreResponse(res, store, { success: true });
});

app.get('/api/scheduling', (_req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const buildStart = perfNow();
  const payload = getCachedDerivedView('schedulingCompactView', () => buildSchedulingView(store));
  sendJsonWithPerf(_req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.get('/api/scheduling/session/:sessionId/eligible', (_req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const buildStart = perfNow();
  const payload = getCachedDerivedView(
    'schedulingEligibleView',
    () => buildSchedulingEligibilityView(store, _req.params.sessionId),
    _req.params.sessionId
  );
  if (!payload) {
    return respondError(res, 'Session not found.', 404);
  }
  sendJsonWithPerf(_req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.get('/api/scheduling/export/current', (_req, res) => {
  const store = readStore();
  const file = makeWorkbookFile([
    { name: 'Instructions', rows: buildSchedulingInstructionsRows() },
    {
      name: 'CurrentSchedule',
      rows: ensureSheetColumns(buildSchedulingCurrentAssignmentRows(store), [
        'AssignmentID', 'SessionID', 'CourseCode', 'CourseName', 'Room', 'Date', 'Start', 'End',
        'DurationHours', 'Role', 'StaffID', 'StaffName', 'AssignmentSource', 'Locked',
        'CurrentAssignedHours', 'RoleAverageHours', 'EffectiveAllowedHours', 'PolicyMode', 'Notes',
      ]),
    },
    {
      name: 'SessionsReference',
      rows: ensureSheetColumns(buildSchedulingSessionReferenceRows(store), [
        'SessionID', 'CourseCode', 'CourseName', 'Room', 'Date', 'Start', 'End',
        'TANeeded', 'DoctorNeeded', 'AssignedTAs', 'AssignedDoctors', 'TARemaining', 'DoctorRemaining',
      ]),
    },
    {
      name: 'StaffReference',
      rows: ensureSheetColumns(buildSchedulingStaffReferenceRows(store), [
        'InvigilatorID', 'StaffID', 'StaffName', 'Role', 'Department', 'CurrentAssignedHours',
        'RoleAverageHours', 'EffectiveAllowedHours', 'PolicyMode', 'ExcludedFromAutoSchedule',
      ]),
    },
    { name: 'Summary', rows: buildSchedulingSummaryRows(store) },
  ], 'scheduling_current');
  res.json({
    success: true,
    scope: 'scheduling',
    note: 'Scheduling export only. No data was saved.',
    ...file,
  });
});

app.get('/api/scheduling/export/assignment-template', (_req, res) => {
  const store = readStore();
  const file = makeWorkbookFile([
    { name: 'Instructions', rows: buildSchedulingInstructionsRows() },
    {
      name: 'AssignmentActions',
      rows: ensureSheetColumns(buildAssignmentActionTemplateRows(), [
        'Action', 'AssignmentID', 'SessionID', 'StaffID', 'Role', 'Locked', 'ForceRemove', 'Notes',
      ]),
    },
    {
      name: 'SessionsReference',
      rows: ensureSheetColumns(buildSchedulingSessionReferenceRows(store), [
        'SessionID', 'CourseCode', 'CourseName', 'Room', 'Date', 'Start', 'End',
        'TANeeded', 'DoctorNeeded', 'AssignedTAs', 'AssignedDoctors', 'TARemaining', 'DoctorRemaining',
      ]),
    },
    {
      name: 'StaffReference',
      rows: ensureSheetColumns(buildSchedulingStaffReferenceRows(store), [
        'InvigilatorID', 'StaffID', 'StaffName', 'Role', 'Department', 'CurrentAssignedHours',
        'RoleAverageHours', 'EffectiveAllowedHours', 'PolicyMode', 'ExcludedFromAutoSchedule',
      ]),
    },
  ], 'scheduling_assignment_template');
  res.json({
    success: true,
    scope: 'scheduling',
    note: 'Scheduling assignment template export only. No data was saved.',
    ...file,
  });
});

app.get('/api/scheduling/export/committee-assignment-template', (_req, res) => {
  const store = readStore();
  const file = makeWorkbookFile([
    { name: 'Instructions', rows: buildCommitteeAssignmentInstructionsRows() },
    {
      name: 'CommitteeAssignments',
      rows: ensureSheetColumns(buildCommitteeAssignmentTemplateRows(), [
        'Date', 'Start', 'End', 'Room', 'CourseCode', 'Role', 'StaffID', 'StaffName', 'Locked', 'Notes',
        'TA1StaffID', 'TA1Name', 'TA2StaffID', 'TA2Name', 'TA3StaffID', 'TA3Name',
        'Doctor1StaffID', 'Doctor1Name', 'Doctor2StaffID', 'Doctor2Name',
        'ForceReplaceLocked', 'AllowOverstaffing',
      ]),
    },
    {
      name: 'SessionsReference',
      rows: ensureSheetColumns(buildSchedulingSessionReferenceRows(store), [
        'SessionID', 'CourseCode', 'CourseName', 'Room', 'Date', 'Start', 'End',
        'TANeeded', 'DoctorNeeded', 'AssignedTAs', 'AssignedDoctors', 'TARemaining', 'DoctorRemaining',
      ]),
    },
    {
      name: 'StaffReference',
      rows: ensureSheetColumns(buildSchedulingStaffReferenceRows(store), [
        'InvigilatorID', 'StaffID', 'StaffName', 'Role', 'Department', 'CurrentAssignedHours',
        'RoleAverageHours', 'EffectiveAllowedHours', 'PolicyMode', 'ExcludedFromAutoSchedule',
      ]),
    },
  ], 'committee_assignment_template');
  res.json({
    success: true,
    scope: 'scheduling',
    note: 'Committee assignment template export only. No data was saved.',
    ...file,
  });
});

app.post('/api/scheduling/import/assignment-actions', (req, res) => {
  const store = readStore();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const dryRun = String(req.query?.dryRun || '').trim().toLowerCase() === 'true';
  if (!rows.length) {
    return respondError(res, 'AssignmentActions rows are required.');
  }
  if (!dryRun && String(req.body?.confirmText || '').trim().toUpperCase() !== 'IMPORT') {
    return respondError(res, 'Applying scheduling assignment import requires confirmText=IMPORT.');
  }

  const result = processSchedulingAssignmentActions(store, rows, { dryRun });
  if (dryRun) {
    return res.json({
      success: true,
      dryRun: true,
      note: 'Dry-run only. No data was saved.',
      ...result.summary,
    });
  }

  return persistStoreResponse(res, result.nextStore, () => res.json({
    success: true,
    dryRun: false,
    note: 'Scheduling assignment actions were applied.',
    ...result.summary,
  }));
});

app.post('/api/scheduling/import/committee-assignments', (req, res) => {
  const store = readStore();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const dryRun = Boolean(req.body?.dryRun) || String(req.query?.dryRun || '').trim().toLowerCase() === 'true';
  const mode = normalizeCommitteeImportMode(req.body?.mode);
  if (!rows.length) {
    return respondError(res, 'CommitteeAssignments rows are required.');
  }
  if (!dryRun && String(req.body?.confirmationText || '').trim().toUpperCase() !== 'IMPORT') {
    return respondError(res, 'Applying committee assignment import requires confirmationText=IMPORT.');
  }

  const result = processCommitteeAssignmentImport(store, rows, { dryRun, mode });
  if (dryRun) {
    return res.json({
      success: true,
      dryRun: true,
      note: 'Dry-run only. No data was saved.',
      ...result.summary,
    });
  }

  return persistStoreResponse(res, result.nextStore, () => res.json({
    success: true,
    dryRun: false,
    note: 'Committee assignments were imported into Scheduling.',
    ...result.summary,
  }));
});

app.get('/api/on-call', (_req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const buildStart = perfNow();
  const payload = getCachedDerivedView('onCallView', () => buildOnCallView(store));
  sendJsonWithPerf(_req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.patch('/api/on-call/config', (req, res) => {
  const store = readStore();
  store.onCallConfig = normalizeOnCallConfig(req.body || {});
  return persistStoreResponse(res, store, () => res.json({
    success: true,
    config: store.onCallConfig,
    summary: buildOnCallSummary(store),
  }));
});

app.get('/api/on-call/eligible', (req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const date = String(req.query.date || '').trim();
  const startTime = String(req.query.startTime || '').trim();
  const endTime = String(req.query.endTime || '').trim();
  const buildStart = perfNow();
  const payload = getCachedDerivedView(
    'onCallEligibleView',
    () => buildOnCallEligibilityView(store, date, startTime, endTime),
    `${date}|${startTime}|${endTime}`
  );
  if (!payload) {
    return respondError(res, 'On-call period not found.', 404);
  }
  sendJsonWithPerf(req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.post('/api/on-call/auto-assign', async (req, res) => {
  const store = readStore();
  const dryRun = Boolean(req.body?.dryRun);
  const version = getStoreVersion();
  try {
    const built = buildCombinedSchedulingPayload(store, 'rebalance_all', 'both', 'on_call', 'strict');
    const solved = await runAutoScheduleSolver(built.payload);
    if (version !== getStoreVersion()) return res.status(409).json({ error: 'Data changed while scheduling. Run on-call scheduling again.' });
    const byStaff = new Map(store.invigilators.map((person) => [String(person.staffId || person.id), person]));
    const onCallAssignments = solved.assignments.filter((row) => built.periods.has(row.session_id)).map((row) => {
      const period = built.periods.get(row.session_id);
      return { id: generateId('oncall'), date: period.date, startTime: period.startTime, endTime: period.endTime, invigilatorId: byStaff.get(row.staff_id).id, role: row.role, engagementOverrideReason: row.engagement_override_reason || '' };
    });
    const nextStore = { ...store, onCallAssignments };
    const summary = buildOnCallSummary(nextStore);
    const view = buildOnCallView(nextStore);
    if (!dryRun) await writeStore(nextStore, { expectedVersion: version });
    return res.json({ success: true, dryRun, rebalanced: true, previousAssignmentCount: store.onCallAssignments.length,
      addedCount: onCallAssignments.length, remainingTAShortage: Number(summary.shortage?.ta || 0),
      remainingDoctorShortage: Number(summary.shortage?.doctor || 0), totalRemainingShortage: summary.totalShortage,
      createdAssignments: onCallAssignments, periods: view.periods, config: view.config,
      continuity: solved.continuity, defaultStaffBalance: solved.defaultStaffBalance, engagementOverrides: solved.engagementOverrides, engagementOverrideMinutes: solved.engagementOverrideMinutes, selectedSolver: solved.selectedSolver,
      note: dryRun ? 'Dry-run only. No data was saved.' : 'On-call auto-assign completed.' });
  } catch (error) {
    if (error.status === 409) return respondPersistenceError(res, error);
    return res.status(400).json({ error: error.message, details: error.details || [] });
  }
});

app.post('/api/scheduling/assign', (req, res) => {
  const store = readStore();
  const { sessionId, invigilatorId } = req.body || {};
  const session = store.sessions.find((item) => item.id === sessionId);
  const person = store.invigilators.find((item) => item.id === invigilatorId);
  if (!session || !person) {
    return respondError(res, 'Session or invigilator not found.', 404);
  }

  const duplicate = store.assignments.find(
    (item) => item.sessionId === sessionId && item.invigilatorId === invigilatorId
  );
  if (duplicate) {
    return respondError(res, 'This invigilator is already assigned to the session.');
  }

  const roleAssignments = store.assignments.filter(
    (item) => item.sessionId === sessionId && item.role === person.role
  );
  const needed = person.role === 'TA' ? Number(session.taNeeded || 0) : Number(session.doctorNeeded || 0);
  if (roleAssignments.length >= needed) {
    return respondError(res, `This session already has all required ${person.role} assignments.`);
  }

  const eligibility = getEligibilityForSession(store, session, person, buildSchedulingIndexes(store));
  if (!eligibility.eligible) {
    if (eligibility.reason === 'engagement') {
      return respondError(res, 'This invigilator has an engagement during that period.');
    }
    if (eligibility.reason === 'overlap') {
      return respondError(res, 'This invigilator is already assigned to an overlapping session.');
    }
    if (eligibility.reason === 'max_hours') {
      return respondError(res, 'This invigilator would exceed their max hours.');
    }
    if (eligibility.reason === 'policy_excluded') {
      return respondError(res, 'This invigilator is excluded by Staff Hour Policy.');
    }
    if (eligibility.reason === 'policy_limit') {
      return respondError(
        res,
        `Staff hour policy exceeded. Policy mode: ${eligibility.policyMode || 'default'}. Current hours: ${((eligibility.currentMinutes || 0) / 60).toFixed(2)}, new duty hours: ${(getDurationMinutes(session.startTime, session.endTime) / 60).toFixed(2)}, allowed hours: ${((eligibility.hardLimitMinutes || eligibility.allowedMinutes || 0) / 60).toFixed(2)}.`
      );
    }
    if (eligibility.reason === 'already_assigned') {
      return respondError(res, 'This invigilator is already assigned to the session.');
    }
    return respondError(res, 'This invigilator cannot be assigned to the session.');
  }

  const assignment = {
    id: generateId('asg'),
    sessionId,
    invigilatorId,
    role: person.role,
    assignmentSource: 'manual',
    locked: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: '',
  };
  store.assignments.push(assignment);
  return persistStoreResponse(res, store, () => res.status(201).json({ ...assignment, continuityWarning: assignmentContinuityWarning(store, invigilatorId) }));
});

app.post('/api/on-call/assign', (req, res) => {
  const store = readStore();
  const { date, startTime, endTime, invigilatorId } = req.body || {};
  const person = store.invigilators.find((item) => item.id === invigilatorId);
  if (!date || !startTime || !endTime || !person) {
    return respondError(res, 'Date, start time, end time, and invigilator are required.', 404);
  }

  const need = buildOnCallNeeds(store).find((item) => item.date === date && item.startTime === startTime && item.endTime === endTime);
  if (!need) {
    return respondError(res, 'On-call period not found.', 404);
  }

  const duplicate = (store.onCallAssignments || []).find(
    (item) => item.date === date && item.startTime === startTime && item.endTime === endTime && item.invigilatorId === invigilatorId && item.role === person.role
  );
  if (duplicate) {
    return respondError(res, 'This invigilator is already assigned to that on-call period.');
  }

  const roleAssignments = (store.onCallAssignments || []).filter(
    (item) => item.date === date && item.startTime === startTime && item.endTime === endTime && item.role === person.role
  );
  const needed = person.role === 'TA' ? Number(need.onCallTANeeded || 0) : Number(need.onCallDoctorNeeded || 0);
  if (roleAssignments.length >= needed) {
    return respondError(res, `This on-call period already has all required ${person.role} assignments.`);
  }

  const eligibility = getEligibilityForOnCall(store, need, person, buildSchedulingIndexes(store));
  if (!eligibility.eligible) {
    if (eligibility.reason === 'engagement') {
      return respondError(res, 'This invigilator has an engagement during that period.');
    }
    if (eligibility.reason === 'overlap') {
      return respondError(res, 'This invigilator is already assigned to an overlapping duty.');
    }
    if (eligibility.reason === 'max_hours') {
      return respondError(res, 'This invigilator would exceed their max hours.');
    }
    if (eligibility.reason === 'policy_excluded') {
      return respondError(res, 'This invigilator is excluded by Staff Hour Policy.');
    }
    if (eligibility.reason === 'on_call_excluded') {
      return respondError(res, 'This invigilator is excluded from on-call duties.');
    }
    if (eligibility.reason === 'policy_limit') {
      return respondError(
        res,
        `Staff hour policy exceeded. Policy mode: ${eligibility.policyMode || 'default'}. Current hours: ${((eligibility.currentMinutes || 0) / 60).toFixed(2)}, new duty hours: ${(getDurationMinutes(need.startTime, need.endTime) / 60).toFixed(2)}, allowed hours: ${((eligibility.hardLimitMinutes || eligibility.allowedMinutes || 0) / 60).toFixed(2)}.`
      );
    }
    if (eligibility.reason === 'already_assigned') {
      return respondError(res, 'This invigilator is already assigned to that on-call period.');
    }
    return respondError(res, 'This invigilator cannot be assigned to the on-call period.');
  }

  const assignment = {
    id: generateId('oncall'),
    date,
    startTime,
    endTime,
    invigilatorId,
    role: person.role,
  };
  store.onCallAssignments.push(assignment);
  return persistStoreResponse(res, store, () => res.status(201).json({ ...assignment, continuityWarning: assignmentContinuityWarning(store, invigilatorId) }));
});

app.delete('/api/scheduling/assign/:id', (req, res) => {
  const store = readStore();
  store.assignments = store.assignments.filter((item) => item.id !== req.params.id);
  return persistStoreResponse(res, store, { success: true });
});

app.patch('/api/scheduling/assign/:id/lock', (req, res) => {
  const store = readStore();
  const assignmentId = String(req.params.id || '').trim();
  const hasAssignment = (store.assignments || []).some((item) => String(item.id) === assignmentId);
  if (!hasAssignment) {
    return respondError(res, 'Assignment not found.', 404);
  }
  const result = updateAssignmentLockState(store.assignments || [], (item) => String(item.id) === assignmentId, req.body?.locked);
  store.assignments = result.assignments;
  return persistStoreResponse(res, store, () => res.json({
    success: true,
    updatedCount: result.updatedCount,
    assignment: result.updatedAssignment,
  }));
});

app.patch('/api/scheduling/assign/bulk-lock', (req, res) => {
  const store = readStore();
  const assignmentIds = Array.isArray(req.body?.assignmentIds)
    ? req.body.assignmentIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!assignmentIds.length) {
    return respondError(res, 'assignmentIds is required.');
  }
  const wanted = new Set(assignmentIds);
  const known = new Set((store.assignments || []).map((item) => String(item.id)));
  const unknown = assignmentIds.filter((id) => !known.has(id));
  if (unknown.length) {
    return respondError(res, `Unknown assignment id(s): ${unknown.slice(0, 5).join(', ')}`);
  }
  const result = updateAssignmentLockState(store.assignments || [], (item) => wanted.has(String(item.id)), req.body?.locked);
  store.assignments = result.assignments;
  return persistStoreResponse(res, store, () => res.json({
    success: true,
    updatedCount: result.updatedCount,
    locked: Boolean(req.body?.locked),
    assignmentIds: Array.from(wanted),
  }));
});

app.patch('/api/scheduling/assign/lock-by-filter', (req, res) => {
  const store = readStore();
  const locked = Boolean(req.body?.locked);
  const confirmAll = Boolean(req.body?.confirmAll);
  const filters = normalizeLockFilterPayload(req.body?.filters || {});
  if (!hasAnyLockFilter(filters) && !confirmAll) {
    return respondError(res, 'Empty filters require confirmAll=true.');
  }

  const presented = (store.assignments || []).map((assignment) => buildAssignmentPresentationRow(store, assignment));
  const matches = presented.filter((row) => matchesAssignmentLockFilters(row, filters));
  const matchedIds = new Set(matches.map((row) => String(row.id)));
  const result = updateAssignmentLockState(store.assignments || [], (item) => matchedIds.has(String(item.id)), locked);
  store.assignments = result.assignments;

  const lockedCountAfter = store.assignments.filter((item) => normalizeAssignmentMetadata(item, { sourceFallback: 'legacy', lockedFallback: true }).locked).length;
  const unlockedCountAfter = store.assignments.length - lockedCountAfter;

  return persistStoreResponse(res, store, () => res.json({
    success: true,
    matchedCount: matches.length,
    updatedCount: result.updatedCount,
    lockedCountAfter,
    unlockedCountAfter,
    examples: matches.slice(0, 10).map((row) => ({
      assignmentId: row.id,
      sessionId: row.sessionId,
      courseCode: row.courseCode,
      room: row.room,
      date: row.date,
      staffId: row.staffId,
      staffName: row.staffName,
      role: row.role,
      assignmentSource: row.assignmentSource,
      locked,
    })),
  }));
});

app.delete('/api/scheduling/assign', (_req, res) => {
  const store = readStore();
  store.assignments = [];
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/on-call/assign/:id', (req, res) => {
  const store = readStore();
  store.onCallAssignments = (store.onCallAssignments || []).filter((item) => item.id !== req.params.id);
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/on-call/assign', (_req, res) => {
  const store = readStore();
  store.onCallAssignments = [];
  return persistStoreResponse(res, store, { success: true });
});

app.get('/api/super-invigilators', (_req, res) => {
  const store = readStore();
  const { dayWindows } = buildDutyCollections(store);
  const doctorMap = new Map(
    store.invigilators.filter((item) => item.role === 'Doctor').map((item) => [item.id, item])
  );

  res.json({
    dayWindows,
    doctors: Array.from(doctorMap.values()),
    assignments: store.superAssignments.map((item) => ({
      ...item,
      invigilator: doctorMap.get(item.invigilatorId),
      window: dayWindows.find((window) => window.date === item.date) || null
    }))
  });
});

app.get('/api/super-invigilators/export', (_req, res) => {
  const store = readStore();
  const { dayWindows } = buildDutyCollections(store);
  const assignments = makeSuperAssignmentRows(store);
  const file = makeWorkbookFile([
    {
      name: 'Instructions',
      rows: [
        { Section: 'Purpose', Instruction: 'Export current super invigilator assignments and their workload context.' },
        { Section: 'Scope', Instruction: 'This export is read-only. It does not change scheduling or staffing data.' },
      ],
    },
    {
      name: 'SuperAssignments',
      rows: ensureSheetColumns(assignments, [
        'AssignmentID', 'Date', 'Start', 'End', 'DurationHours', 'StaffID', 'Name', 'Role', 'CurrentAssignedHours',
      ]),
    },
    {
      name: 'DayWindows',
      rows: ensureSheetColumns(dayWindows.map((window) => ({
        Date: window.date || '',
        Start: window.startTime || '',
        End: window.endTime || '',
        DurationHours: Math.round((Number(window.durationMinutes || 0) / 60) * 100) / 100,
      })), ['Date', 'Start', 'End', 'DurationHours']),
    },
    {
      name: 'Summary',
      rows: [{ TotalSuperAssignments: assignments.length, CoveredDays: dayWindows.length }],
    },
  ], 'super_invigilator_assignments');
  res.json({
    success: true,
    note: 'Super invigilator assignment export only. No data was saved.',
    ...file,
  });
});

app.post('/api/super-invigilators/assign', (req, res) => {
  const store = readStore();
  const { date, invigilatorId } = req.body || {};
  const person = store.invigilators.find((item) => item.id === invigilatorId);
  const { dayWindows } = buildDutyCollections(store);
  const window = dayWindows.find((item) => item.date === date);
  if (!date || !person) {
    return respondError(res, 'Date and doctor are required.');
  }
  if (person.role !== 'Doctor') {
    return respondError(res, 'Super invigilators must be doctors only.');
  }
  if (!window) {
    return respondError(res, 'Supervision requires an existing exam-day window.');
  }

  const duplicate = store.superAssignments.find(
    (item) => item.date === date && item.invigilatorId === invigilatorId
  );
  if (duplicate) {
    return respondError(res, 'This doctor is already assigned as super invigilator for that day.');
  }

  if (window) {
    const fullDayDuty = {
      id: `super_window_${date}`,
      date,
      startTime: window.startTime,
      endTime: window.endTime,
    };
    const eligibility = getEligibilityForSession(store, fullDayDuty, person, buildSchedulingIndexes(store));
    if (!eligibility.eligible && eligibility.reason !== 'already_assigned') {
      if (eligibility.reason === 'engagement') {
        return respondError(res, 'This doctor has an engagement during that supervision window.');
      }
      if (eligibility.reason === 'overlap') {
        return respondError(res, 'This doctor already has an overlapping duty during that supervision window.');
      }
      if (eligibility.reason === 'max_hours') {
        return respondError(res, 'This doctor would exceed their max hours.');
      }
      if (eligibility.reason === 'policy_excluded') {
        return respondError(res, 'This doctor is excluded by Staff Hour Policy.');
      }
      if (eligibility.reason === 'policy_limit') {
        return respondError(
          res,
          `Staff hour policy exceeded. Policy mode: ${eligibility.policyMode || 'default'}. Current hours: ${((eligibility.currentMinutes || 0) / 60).toFixed(2)}, new duty hours: ${(getDurationMinutes(window.startTime, window.endTime) / 60).toFixed(2)}, allowed hours: ${((eligibility.hardLimitMinutes || eligibility.allowedMinutes || 0) / 60).toFixed(2)}.`
        );
      }
    }
  }

  const assignment = { id: generateId('sup'), date, invigilatorId };
  store.superAssignments.push(assignment);
  return persistStoreResponse(res, store, () => res.status(201).json(assignment));
});

app.delete('/api/super-invigilators/:id', (req, res) => {
  const store = readStore();
  store.superAssignments = store.superAssignments.filter((item) => item.id !== req.params.id);
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/super-invigilators', (_req, res) => {
  const store = readStore();
  store.superAssignments = [];
  return persistStoreResponse(res, store, { success: true });
});

app.get('/api/control-sessions', (_req, res) => {
  const store = readStore();
  const invigilatorMap = new Map(store.invigilators.map((item) => [item.id, item]));
  const assignmentsByControlSession = new Map();

  for (const assignment of store.controlAssignments) {
    const rows = assignmentsByControlSession.get(assignment.controlSessionId) || [];
    rows.push(assignment);
    assignmentsByControlSession.set(assignment.controlSessionId, rows);
  }

  res.json({
    sessions: store.controlSessions.map((session) => {
      const assignments = assignmentsByControlSession.get(session.id) || [];
      const taAssignments = assignments
        .filter((item) => item.role === 'TA')
        .map((item) => ({ ...item, invigilator: invigilatorMap.get(item.invigilatorId) }));
      const doctorAssignments = assignments
        .filter((item) => item.role === 'Doctor')
        .map((item) => ({ ...item, invigilator: invigilatorMap.get(item.invigilatorId) }));

      return {
        ...session,
        taAssignments,
        doctorAssignments,
        taRemaining: Math.max(0, Number(session.taNeeded || 0) - taAssignments.length),
        doctorRemaining: Math.max(0, Number(session.doctorNeeded || 0) - doctorAssignments.length)
      };
    }),
    invigilators: store.invigilators,
    assignments: store.controlAssignments.map((item) => ({
      ...item,
      invigilator: invigilatorMap.get(item.invigilatorId),
      controlSession: store.controlSessions.find((session) => session.id === item.controlSessionId) || null
    }))
  });
});

app.get('/api/control-sessions/export', (_req, res) => {
  const store = readStore();
  const sessions = makeControlSessionRows(store.controlSessions);
  const assignments = makeControlAssignmentRows(store);
  const file = makeWorkbookFile([
    {
      name: 'Instructions',
      rows: [
        { Section: 'Purpose', Instruction: 'Export current control sessions and their assignments.' },
        { Section: 'Scope', Instruction: 'This export is read-only. It does not change scheduling or staffing data.' },
      ],
    },
    {
      name: 'ControlSessions',
      rows: ensureSheetColumns(sessions, [
        'ControlSessionID', 'CourseCode', 'Room', 'Date', 'Start', 'End', 'TANeeded', 'DoctorNeeded', 'InvigilatorsNeeded', 'Notes',
      ]),
    },
    {
      name: 'ControlAssignments',
      rows: ensureSheetColumns(assignments, [
        'AssignmentID', 'ControlSessionID', 'StaffID', 'Name', 'Role', 'CourseCode', 'Room', 'Date', 'Start', 'End', 'DurationHours', 'CurrentAssignedHours',
      ]),
    },
    {
      name: 'Summary',
      rows: [{
        TotalControlSessions: sessions.length,
        TotalControlAssignments: assignments.length,
        TAAssignments: assignments.filter((item) => item.Role === 'TA').length,
        DoctorAssignments: assignments.filter((item) => item.Role === 'Doctor').length,
      }],
    },
  ], 'control_session_assignments');
  res.json({
    success: true,
    note: 'Control session assignment export only. No data was saved.',
    ...file,
  });
});

app.get('/api/control-sessions/template/export', (_req, res) => {
  const store = readStore();
  const file = makeWorkbookFile([
    {
      name: 'ControlSessions',
      rows: ensureSheetColumns(buildControlSessionTemplateRows(), [
        'ControlSessionID', 'CourseCode', 'Room', 'Date', 'Start', 'End', 'TANeeded', 'DoctorNeeded', 'InvigilatorsNeeded', 'Notes',
      ]),
    },
    {
      name: 'ControlAssignments',
      rows: ensureSheetColumns(buildControlAssignmentTemplateRows(), [
        'AssignmentID', 'ControlSessionID', 'StaffID', 'Name', 'Role', 'CourseCode', 'Room', 'Date', 'Start', 'End', 'DurationHours', 'CurrentAssignedHours', 'Notes',
      ]),
    },
    {
      name: 'StaffReference',
      rows: ensureSheetColumns(buildSchedulingStaffReferenceRows(store), [
        'InvigilatorID', 'StaffID', 'StaffName', 'Role', 'Department', 'CurrentAssignedHours',
        'RoleAverageHours', 'EffectiveAllowedHours', 'PolicyMode', 'ExcludedFromAutoSchedule',
      ]),
    },
    {
      name: 'Instructions',
      rows: buildControlSessionTemplateInstructionsRows(),
    },
  ], 'control_session_template');
  res.json({
    success: true,
    note: 'Control session template export only. No data was saved.',
    ...file,
  });
});

app.post('/api/control-sessions', (req, res) => {
  const store = readStore();
  const payload = req.body || {};
  if (!payload.date || !payload.startTime || !payload.endTime) {
    return respondError(res, 'Date, start time, and end time are required.');
  }

  const session = {
    id: generateId('ctlses'),
    courseNames: normalizeCourseNames(readCourseInput(payload, 'Control Session')),
    courseName: formatCourseNames(readCourseInput(payload), 'Control Session'),
    room: String(payload.room || 'Control').trim(),
    date: normalizeDate(payload.date),
    startTime: normalizeTime(payload.startTime),
    endTime: normalizeTime(payload.endTime),
    taNeeded: Number(payload.taNeeded || 0),
    doctorNeeded: Number(payload.doctorNeeded || 0),
    totalNeeded: Number(payload.totalNeeded || (Number(payload.taNeeded || 0) + Number(payload.doctorNeeded || 0))),
    notes: String(payload.notes || '').trim()
  };

  store.controlSessions.push(session);
  return persistStoreResponse(res, store, () => res.status(201).json(session));
});

app.put('/api/control-sessions/:id', (req, res) => {
  const store = readStore();
  const session = store.controlSessions.find((item) => item.id === req.params.id);
  if (!session) {
    return respondError(res, 'Control session not found.', 404);
  }

  Object.assign(session, {
    courseNames: normalizeCourseNames(readCourseInput(req.body)),
    courseName: formatCourseNames(readCourseInput(req.body)),
    room: String(req.body.room || '').trim(),
    date: normalizeDate(req.body.date || session.date),
    startTime: normalizeTime(req.body.startTime || session.startTime),
    endTime: normalizeTime(req.body.endTime || session.endTime),
    taNeeded: Number(req.body.taNeeded || 0),
    doctorNeeded: Number(req.body.doctorNeeded || 0),
    totalNeeded: Number(req.body.totalNeeded || (Number(req.body.taNeeded || 0) + Number(req.body.doctorNeeded || 0))),
    notes: String(req.body.notes || '').trim()
  });

  return persistStoreResponse(res, store, session);
});

app.post('/api/control-sessions/assign', (req, res) => {
  const store = readStore();
  const { controlSessionId, invigilatorId } = req.body || {};
  const controlSession = store.controlSessions.find((item) => item.id === controlSessionId);
  const person = store.invigilators.find((item) => item.id === invigilatorId);
  if (!controlSession || !person) {
    return respondError(res, 'Control session and invigilator are required.');
  }

  const duplicate = store.controlAssignments.find(
    (item) => item.controlSessionId === controlSessionId && item.invigilatorId === invigilatorId
  );
  if (duplicate) {
    return respondError(res, 'This invigilator is already assigned to the control session.');
  }

  const roleAssignments = store.controlAssignments.filter(
    (item) => item.controlSessionId === controlSessionId && item.role === person.role
  );
  const needed = person.role === 'TA' ? Number(controlSession.taNeeded || 0) : Number(controlSession.doctorNeeded || 0);
  if (roleAssignments.length >= needed) {
    return respondError(res, `This control session already has all required ${person.role} assignments.`);
  }

  const regularizedSession = {
    ...controlSession,
    startTime: controlSession.startTime,
    endTime: controlSession.endTime,
    date: controlSession.date
  };
  const eligibility = getEligibilityForSession(store, regularizedSession, person, buildSchedulingIndexes(store));
  if (!eligibility.eligible && eligibility.reason !== 'already_assigned') {
    if (eligibility.reason === 'engagement') {
      return respondError(res, 'This invigilator has an engagement during that period.');
    }
    if (eligibility.reason === 'overlap') {
      return respondError(res, 'This invigilator is already assigned to an overlapping session.');
    }
    if (eligibility.reason === 'max_hours') {
      return respondError(res, 'This invigilator would exceed their max hours.');
    }
    if (eligibility.reason === 'policy_excluded') {
      return respondError(res, 'This invigilator is excluded by Staff Hour Policy.');
    }
    if (eligibility.reason === 'policy_limit') {
      return respondError(
        res,
        `Staff hour policy exceeded. Policy mode: ${eligibility.policyMode || 'default'}. Current hours: ${((eligibility.currentMinutes || 0) / 60).toFixed(2)}, new duty hours: ${(getDurationMinutes(controlSession.startTime, controlSession.endTime) / 60).toFixed(2)}, allowed hours: ${((eligibility.hardLimitMinutes || eligibility.allowedMinutes || 0) / 60).toFixed(2)}.`
      );
    }
  }

  const assignment = { id: generateId('ctlasg'), controlSessionId, invigilatorId, role: person.role };
  store.controlAssignments.push(assignment);
  return persistStoreResponse(res, store, () => res.status(201).json(assignment));
});

app.delete('/api/control-sessions/assign/:id', (req, res) => {
  const store = readStore();
  store.controlAssignments = store.controlAssignments.filter((item) => item.id !== req.params.id);
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/control-sessions', (_req, res) => {
  const store = readStore();
  store.controlSessions = [];
  store.controlAssignments = [];
  return persistStoreResponse(res, store, { success: true });
});

app.delete('/api/control-sessions/:id', (req, res) => {
  const store = readStore();
  store.controlSessions = store.controlSessions.filter((item) => item.id !== req.params.id);
  store.controlAssignments = store.controlAssignments.filter((item) => item.controlSessionId !== req.params.id);
  return persistStoreResponse(res, store, { success: true });
});

app.get('/api/workload', (_req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const buildStart = perfNow();
  const payload = getCachedDerivedView('workloadView', () => ({
    rows: buildWorkloadView(store),
    dayWindows: getDayWindows(store.sessions)
  }));
  sendJsonWithPerf(_req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.post('/api/scheduling/auto-schedule-preview', async (req, res) => {
  const store = readStore();
  const version = getStoreVersion();
  const mode = normalizePreviewMode(req.body?.mode);
  const roleScope = normalizeRoleScope(req.body?.roleScope || 'both');
  try {
    const preview = await computeAutoSchedulePreview(store, mode, roleScope);
    if (version !== getStoreVersion()) return res.status(409).json({ error: 'Data changed during the preview. Run preview again.' });
    const { payload } = buildAutoSchedulePayloadForMode(store, mode, roleScope);
    const byStaffId = new Map(store.invigilators.map((person) => [String(person.staffId || person.id), person.id]));
    const mergedAssignments = mergeSavedAutoScheduleAssignments(store, preview.solver.assignments, byStaffId, roleScope, mode);
    const now = Date.now();
    for (const [key, plan] of sessionSchedulingPlans) if (plan.expiresAt <= now) sessionSchedulingPlans.delete(key);
    while (sessionSchedulingPlans.size >= 20) sessionSchedulingPlans.delete(sessionSchedulingPlans.keys().next().value);
    const planToken = randomUUID();
    const expiresAt = now + COMBINED_PLAN_TTL_MS;
    sessionSchedulingPlans.set(planToken, { version, expiresAt, store, preview, payload, mergedAssignments });
    res.json({ ...preview, planToken, expiresAt });
  } catch (error) {
    res.status(400).json({
      error: error.message,
      details: error.details || [],
      status: error.status || 'ERROR',
      dryRun: true,
      previewMode: mode,
      roleScope,
    });
  }
});

app.post('/api/scheduling/auto-schedule-preview/export', async (req, res) => {
  try {
    const { store, preview } = getSessionSchedulingPlan(req.body?.planToken);
    const file = buildPreviewExportFile(store, preview);
    res.json({
      success: true,
      dryRun: true,
      previewMode: preview.previewMode,
      roleScope: preview.roleScope,
      note: 'Preview export only. No data was saved.',
      ...file,
    });
  } catch (error) {
    res.status(error.status === 409 ? 409 : 400).json({
      error: error.message,
      details: error.details || [],
      status: error.status || 'ERROR',
      dryRun: true,
    });
  }
});

app.get('/api/scheduling/assign/lock-plan/export', (_req, res) => {
  const store = readStore();
  const file = makeWorkbookFile([
    { name: 'AssignmentLockPlan', rows: getLockPlanRows(store) },
  ], 'assignment_lock_plan');
  res.json({
    success: true,
    note: 'Lock plan export only. No data was saved.',
    ...file,
  });
});

app.post('/api/scheduling/assign/lock-plan/import', (req, res) => {
  const store = readStore();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const assignmentById = new Map((store.assignments || []).map((item) => [String(item.id), item]));
  let updated = 0;
  let unchanged = 0;
  const rejected = [];
  const examples = [];

  rows.forEach((row, index) => {
    const assignmentId = String(row.AssignmentID ?? row.assignmentId ?? row.id ?? '').trim();
    const target = assignmentById.get(assignmentId);
    if (!target) {
      rejected.push({ row: index + 1, assignmentId, reason: 'unknown_assignment' });
      return;
    }
    const nextLocked = String(row.NewLocked ?? row.newLocked ?? '').trim().toLowerCase();
    if (!['yes', 'no', 'true', 'false', '1', '0', 'locked', 'unlocked'].includes(nextLocked)) {
      rejected.push({ row: index + 1, assignmentId, reason: 'invalid_new_locked' });
      return;
    }
    const normalized = normalizeAssignmentMetadata(target, { sourceFallback: 'legacy', lockedFallback: true });
    const desiredLocked = ['yes', 'true', '1', 'locked'].includes(nextLocked);
    if (normalized.locked === desiredLocked) {
      unchanged += 1;
      return;
    }
    target.locked = desiredLocked;
    target.updatedAt = new Date().toISOString();
    updated += 1;
    if (examples.length < 10) {
      examples.push({
        assignmentId,
        assignmentSource: normalized.assignmentSource,
        locked: desiredLocked,
      });
    }
  });

  return persistStoreResponse(res, store, () => res.json({
    success: true,
    rowsImported: rows.length,
    updated,
    rejected: rejected.length,
    unchanged,
    examples,
    rejectedExamples: rejected.slice(0, 10),
  }));
});

app.post('/api/scheduling/auto-schedule', async (req, res) => {
  try {
    const plan = getSessionSchedulingPlan(req.body?.planToken);
    const { store, payload, preview, mergedAssignments } = plan;
    const { roleScope, previewMode: mode, solver: result, hourPolicySummary } = preview;
    const staffIdToInvigilatorId = new Map(store.invigilators.map((item) => [String(item.staffId || item.id), item.id]));
    const nextStore = { ...store, assignments: mergedAssignments.assignments };
    const assignmentKeys = new Set(nextStore.assignments.map((item) => `${item.sessionId}|${item.invigilatorId}|${item.role}`));
    const lockedAssignmentsPreserved = payload.locked_assignments.filter((item) => {
      const invigilatorId = staffIdToInvigilatorId.get(String(item.staff_id));
      return invigilatorId && assignmentKeys.has(`${item.session_id}|${invigilatorId}|${item.role}`);
    }).length;
    const shortagesRemaining = (result.uncovered_sessions || []).reduce((sum, item) => sum + Number(item.remaining || item.shortage || 0), 0);

    await writeStore(nextStore, { expectedVersion: plan.version });
    sessionSchedulingPlans.delete(String(req.body.planToken));
    res.json({
      ...result,
      assignments: nextStore.assignments,
      hourPolicySummary,
      persistence: {
        mode,
        roleScope,
        assignmentsBefore: store.assignments.length,
        assignmentsAfter: nextStore.assignments.length,
        lockedAssignmentsBefore: payload.locked_assignments.length,
        lockedAssignmentsPreserved,
        manualPreserved: mergedAssignments.preservedManualAssignments,
        legacyPreserved: mergedAssignments.preservedLegacyAssignments,
        importPreserved: mergedAssignments.preservedImportAssignments,
        lockedPreserved: mergedAssignments.preservedLockedAssignments,
        preservedByRoleScopeAssignments: mergedAssignments.preservedByRoleScopeAssignments,
        preservedDoctorAssignments: mergedAssignments.preservedDoctorAssignments,
        preservedTAAssignments: mergedAssignments.preservedTAAssignments,
        autoRemoved: mergedAssignments.autoAssignmentsRemoved,
        newAssignmentsCreated: mergedAssignments.nextAutoAssignments.length,
        shortagesRemaining,
        replaceMode: true,
      },
    });
  } catch (error) { respondPersistenceError(res, error); }
});

app.post('/api/room-capability/optimize', (req, res) => {
  const payload = req.body || {};
  const scriptPath = path.join(__dirname, 'scripts', 'room_capability.py');
  const child = spawn('python', [scriptPath], { cwd: path.join(__dirname, '..') });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    res.status(500).json({ error: error.message });
  });
  child.on('close', (code) => {
    if (code !== 0) {
      res.status(500).json({ error: stderr || `Room capability optimizer failed with code ${code}` });
      return;
    }
    try {
      const result = JSON.parse(stdout);
      if (result.status === 'ERROR') {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: stderr || error.message });
    }
  });

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
});

app.post('/api/import/sessions', (req, res) => {
  const store = readStore();
  const rows = readImportRows(req, res, 'Sessions');
  if (!rows) return;
  const previousSessionCount = store.sessions.length;
  const previousAssignmentsCount = store.assignments.length;
  const nextSessions = normalizeImportedSessions(rows, store.sessions, false);
  const remap = remapAssignmentsToImportedSessions(store, nextSessions);
  const mergedExamples = buildMergedBlockExamples(rows);
  const validBlockRows = rows.filter((row) => buildSessionRoomStartKey({
    date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
    startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
    room: String(readRoomInput(row)).trim(),
  }).replace(/\|/g, '').trim()).length;

  store.sessions = nextSessions;
  store.assignments = remap.assignments;
  pruneInvalidOnCallAssignments(store);

  return persistStoreResponse(res, store, {
    success: true,
    rowsImported: rows.length,
    sessionsCreatedAfterMerge: store.sessions.length,
    rowsMerged: Math.max(0, validBlockRows - store.sessions.length),
    rowsRejected: Math.max(0, rows.length - validBlockRows),
    assignmentRemapCount: remap.remapped,
    assignmentsDropped: remap.dropped,
    assignmentsBefore: previousAssignmentsCount,
    assignmentsAfter: store.assignments.length,
    previousSessionCount,
    mergedExamples,
    count: store.sessions.length,
  });
});

app.post('/api/import/session-needs', (req, res) => {
  const store = readStore();
  const rows = readImportRows(req, res, 'Session needs');
  if (!rows) return;
  const byId = new Map(store.sessions.map((session) => [String(session.id), session]));
  const byBlock = new Map();
  store.sessions.forEach((session) => {
    const key = buildSessionRoomStartKey(session);
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push(session);
  });

  const unmatched = [];
  const rejected = [];
  let updated = 0;

  rows.forEach((sourceRow, index) => {
    const row = normalizeNeedsRow(sourceRow);
    const invalidReason = validateNeedsRow(row);
    if (invalidReason) {
      rejected.push({ row: index + 2, reason: invalidReason });
      return;
    }
    const courseNames = normalizeCourseNames(readCourseInput(row));
    const importedSession = {
      date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
      startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
      endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
      room: String(readRoomInput(row)).trim(),
      courseNames,
      courseName: formatCourseNames(courseNames)
    };
    const sessionId = String(row.SessionID ?? row.sessionId ?? row.id ?? '').trim();
    let session = byId.get(sessionId);
    let candidates = [];
    if (!session && importedSession.room && importedSession.date && importedSession.startTime) {
      candidates = byBlock.get(buildSessionRoomStartKey(importedSession)) || [];
      // A merged room block may have a later End than an individual course row.
      // Narrow multiple candidates when possible, but keep the unique block fallback.
      if (candidates.length > 1 && importedSession.endTime) {
        candidates = candidates.filter((item) => item.endTime === importedSession.endTime);
      }
      if (candidates.length > 1 && courseNames.length) {
        candidates = candidates.filter((item) => {
          const known = normalizeCourseNames(item.courseNames?.length ? item.courseNames : item.courseName).map((name) => name.toLowerCase());
          return courseNames.every((name) => known.includes(name.toLowerCase()));
        });
      }
      if (candidates.length === 1) [session] = candidates;
    }

    if (!session) {
      unmatched.push({
        row: index + 2,
        sessionId,
        room: importedSession.room,
        date: importedSession.date,
        start: importedSession.startTime,
        end: importedSession.endTime,
        courses: importedSession.courseName,
        reason: candidates.length > 1 ? 'ambiguous_session' : 'session_not_found',
      });
      return;
    }

    const demand = extractSessionDemand(row, session);
    // Role needs drive scheduling. Do not retain a stale total from an export.
    demand.totalNeeded = demand.taNeeded + demand.doctorNeeded;
    session.taNeeded = demand.taNeeded;
    session.doctorNeeded = demand.doctorNeeded;
    session.totalNeeded = demand.totalNeeded;
    updated += 1;
  });

  if (!updated) {
    return res.status(400).json({
      error: rejected.length
        ? 'No session needs updated. Supply non-negative whole numbers in TANeeded and/or DoctorNeeded columns.'
        : 'No sessions matched. Use an existing SessionID or matching Room, Date and Start values.',
      updated, unmatched, rejected,
    });
  }

  return persistStoreResponse(res, store, {
    success: true,
    sessionNeedsUpdated: updated,
    sessionNeedsUnmatched: unmatched.length,
    unmatched,
    unmatchedExamples: unmatched.slice(0, 5),
    rejected,
    sessionNeedsRejected: rejected.length,
    updated,
  });
});

app.post('/api/import/control-sessions', (req, res) => {
  const store = readStore();
  const rows = readImportRows(req, res, 'Control sessions');
  if (!rows) return;
  store.controlSessions = rows
    .map((row, index) => normalizeControlSessionRow(row, index, false))
    .filter((row) => row.date && row.startTime && row.endTime);
  store.controlAssignments = [];
  return persistStoreResponse(res, store, { success: true, count: store.controlSessions.length });
});

app.post('/api/import/control-session-loads', (req, res) => {
  const store = readStore();
  const rows = readImportRows(req, res, 'Control assignments');
  if (!rows) return;
  const result = processControlAssignmentImportRows(store, rows);
  return persistStoreResponse(res, result.nextStore, {
    success: true,
    rowsRead: result.summary.rowsRead,
    added: result.summary.added,
    rejected: result.summary.rejected,
    unchanged: result.summary.unchanged,
    warnings: result.summary.warnings,
    errors: result.summary.errors,
    examples: result.summary.examples,
  });
});

app.post('/api/import/invigilators', (req, res) => {
  const store = readStore();
  const rows = readImportRows(req, res, 'Invigilators');
  if (!rows) return;
  const prepared = rows.map((row, index) => {
    const fields = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.trim().toLowerCase().replace(/[\s_-]+/g, ''), value]));
    return { fields, staffId: String(fields.staffid ?? '').trim(), row: Number(row.__importRow) || index + 2 };
  });
  const idRows = new Map();
  prepared.forEach((item) => {
    if (!idRows.has(item.staffId)) idRows.set(item.staffId, []);
    idRows.get(item.staffId).push(item.row);
  });
  const existingByStaffId = new Map(store.invigilators.map((person) => [String(person.staffId).trim(), person]));
  const nextByStaffId = new Map(existingByStaffId);
  const errors = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  prepared.forEach(({ fields, staffId, row }) => {
    try {
      if (!staffId) throw new Error('StaffID is required. Keep identifiers as text, including leading zeros.');
      if (idRows.get(staffId).length > 1) throw new Error(`Duplicate StaffID ${staffId} in Excel rows ${idRows.get(staffId).join(', ')}. Each person must have a unique StaffID.`);
      const existing = existingByStaffId.get(staffId);
      const name = String(fields.name ?? fields.staffname ?? existing?.name ?? '').trim();
      if (!name) throw new Error('Name is required.');
      const rawRole = String(fields.role ?? existing?.role ?? '').trim().toLowerCase();
      if (!['ta', 'doctor', 'dr', 'doc'].includes(rawRole)) throw new Error('Role is required and must be TA or Doctor.');
      const role = normalizeRole(rawRole);
      const rawLoad = String(fields.loadtype ?? existing?.loadType ?? 'full').trim().toLowerCase();
      if (!['full', 'half'].includes(rawLoad)) throw new Error('LoadType must be full or half.');
      const maxHours = Number(fields.maxhours ?? existing?.maxHours ?? 0);
      if (!Number.isFinite(maxHours) || maxHours < 0) throw new Error('MaxHours must be a non-negative number.');
      if (existing && existing.role !== role) {
        const linked = ['assignments', 'superAssignments', 'controlAssignments', 'onCallAssignments', 'staffHourPolicies']
          .some((key) => (store[key] || []).some((item) => item.invigilatorId === existing.id));
        if (linked) throw new Error('Role cannot change while this staff member has assignments or an hour policy. Review those records first.');
      }
      const person = {
        ...(existing || {}),
        id: existing?.id || generateId('inv'),
        staffId, name, role, loadType: rawLoad, maxHours,
        email: String(fields.email ?? existing?.email ?? '').trim(),
        department: String(fields.department ?? existing?.department ?? '').trim(),
        notes: normalizeNotes(fields.notes ?? existing?.notes ?? ''),
      };
      nextByStaffId.set(staffId, person);
      if (!existing) created += 1;
      else if (['name', 'role', 'loadType', 'maxHours', 'email', 'department', 'notes'].every((key) => existing[key] === person[key])) unchanged += 1;
      else updated += 1;
    } catch (error) { errors.push({ row, staffId, error: error.message }); }
  });
  if (errors.length) {
    return res.status(400).json({ success: false, imported: 0, rejected: errors.length, errors, error: `No staff imported. Row ${errors[0].row}: ${errors[0].error}` });
  }
  const result = { success: true, imported: created + updated, created, updated, unchanged, rejected: 0, count: nextByStaffId.size };
  if (!created && !updated) return res.json(result);
  store.invigilators = Array.from(nextByStaffId.values());
  return persistStoreResponse(res, store, result);
});

app.post('/api/import/staff-hour-policies', (req, res) => {
  const store = readStore();
  const rows = readImportRows(req, res, 'Staff hour policies');
  if (!rows) return;
  const rejected = [];
  const seenStaff = new Set();
  let updated = 0;
  let created = 0;
  let unchanged = 0;

  rows.forEach((source, index) => {
    const fields = Object.fromEntries(Object.entries(source).map(([key, value]) => [key.trim().toLowerCase().replace(/[\s_-]+/g, ''), value]));
    const row = {
      PolicyID: fields.policyid ?? fields.id ?? '',
      StaffID: fields.staffid ?? '',
      InvigilatorID: fields.invigilatorid ?? '',
      Mode: fields.mode ?? fields.policymode ?? '',
      HoursValue: fields.hoursvalue,
      ExcludeFromAutoSchedule: fields.excludefromautoschedule ?? '',
      PreferConsecutiveDuties: fields.preferconsecutiveduties ?? '',
      PreferConsecutiveDays: fields.preferconsecutivedays ?? '',
      AllowEngagementOverride: fields.allowengagementoverride ?? 'Yes',
      Notes: fields.notes ?? '',
    };
    try {
      const mode = parseStaffHourPolicyMode(row.Mode);
      if (['exact', 'add', 'reduce'].includes(mode) && (row.HoursValue === undefined || String(row.HoursValue).trim() === '')) {
        throw new Error('HoursValue is required for exact, add and reduce modes.');
      }
      const flag = String(row.ExcludeFromAutoSchedule).trim().toLowerCase();
      if (!['', 'yes', 'no', 'true', 'false', '1', '0', 'y', 'n'].includes(flag)) {
        throw new Error('ExcludeFromAutoSchedule must be Yes/No, True/False or 1/0.');
      }
      for (const key of ['PreferConsecutiveDuties', 'PreferConsecutiveDays', 'AllowEngagementOverride']) {
        if (!['', 'yes', 'no', 'true', 'false', '1', '0', 'y', 'n'].includes(String(row[key]).trim().toLowerCase())) throw new Error(`${key} must be Yes/No, True/False or 1/0.`);
      }
      const normalized = normalizeStaffHourPolicyInput(store, {
        id: row.PolicyID ?? row.policyId ?? row.id ?? '',
        staffId: row.StaffID ?? row.staffId ?? row.staff_id ?? '',
        invigilatorId: row.InvigilatorID ?? row.invigilatorId ?? '',
        mode: row.Mode ?? row.mode ?? '',
        hoursValue: row.HoursValue ?? row.hoursValue ?? row.hours_value ?? 0,
        excludeFromAutoSchedule: parseBooleanFlag(row.ExcludeFromAutoSchedule ?? row.excludeFromAutoSchedule ?? ''),
        preferConsecutiveDuties: parseBooleanFlag(row.PreferConsecutiveDuties),
        preferConsecutiveDays: parseBooleanFlag(row.PreferConsecutiveDays),
        allowEngagementOverride: parseBooleanFlag(String(row.AllowEngagementOverride).trim() || 'Yes'),
        notes: row.Notes ?? row.notes ?? '',
      }, String(row.PolicyID ?? row.policyId ?? row.id ?? ''));
      const person = store.invigilators.find((item) => item.id === normalized.invigilatorId);
      const suppliedStaffId = String(row.StaffID).trim();
      const suppliedInvigilatorId = String(row.InvigilatorID).trim();
      if ((suppliedStaffId && suppliedStaffId !== String(person.staffId).trim()) || (suppliedInvigilatorId && suppliedInvigilatorId !== String(person.id))) {
        throw new Error('StaffID and InvigilatorID refer to different staff.');
      }
      if (store.staffHourPolicies.some((item) => item.id === normalized.id && item.invigilatorId !== normalized.invigilatorId)) {
        throw new Error('PolicyID belongs to a different staff member.');
      }
      if (seenStaff.has(normalized.invigilatorId)) throw new Error('Duplicate staff row. Keep one policy row per staff member.');
      seenStaff.add(normalized.invigilatorId);
      const existingIndex = store.staffHourPolicies.findIndex((item) => item.invigilatorId === normalized.invigilatorId);
      if (existingIndex >= 0) {
        normalized.id = store.staffHourPolicies[existingIndex].id;
        const existing = store.staffHourPolicies[existingIndex];
        if (['mode', 'hoursValue', 'excludeFromAutoSchedule', 'notes', 'preferConsecutiveDuties', 'preferConsecutiveDays', 'allowEngagementOverride'].every((key) => (existing[key] ?? (key === 'allowEngagementOverride')) === normalized[key])) {
          unchanged += 1;
          return;
        }
        store.staffHourPolicies[existingIndex] = normalized;
        updated += 1;
      } else {
        if (normalized.mode === 'default' && normalized.hoursValue === 0 && !normalized.excludeFromAutoSchedule && !normalized.notes && !normalized.preferConsecutiveDuties && !normalized.preferConsecutiveDays && normalized.allowEngagementOverride) {
          unchanged += 1;
          return;
        }
        store.staffHourPolicies.push(normalized);
        created += 1;
      }
    } catch (error) {
      rejected.push({
        row: Number(source.__importRow) || index + 2,
        error: error.message,
        staffId: String(row.StaffID ?? row.staffId ?? '').trim(),
      });
    }
  });

  const result = {
    success: true,
    rowsRead: rows.length,
    imported: created + updated,
    created,
    updated,
    unchanged,
    rejected: rejected.length,
    warnings: [],
    examples: rejected.slice(0, 10),
    errors: rejected,
  };
  if (rejected.length === rows.length) return res.status(400).json({ ...result, success: false, error: `No policies imported. Row ${rejected[0].row}: ${rejected[0].error}` });
  if (!created && !updated) return res.json(result);
  return persistStoreResponse(res, store, result);
});

app.post('/api/import/engagements', (req, res) => {
  const store = readStore();
  const rows = readImportRows(req, res, 'Engagements');
  if (!rows) return;
  store.engagements = rows
    .map((row, index) => normalizeEngagementRow(row, index, false))
    .filter((row) => row.staffId && row.date && row.startTime && row.endTime);
  return persistStoreResponse(res, store, { success: true, count: store.engagements.length });
});

app.post('/api/data/load-sample', (req, res) => {
  const sampleDir = path.join(__dirname, '..', 'sample');
  const sessionsPath = path.join(sampleDir, 'sessions.xlsx');
  const staffPath = path.join(sampleDir, 'staff.xlsx');
  const engagementPath = path.join(sampleDir, 'engagement.xlsx');

  if (!fs.existsSync(sessionsPath) || !fs.existsSync(staffPath) || !fs.existsSync(engagementPath)) {
    return respondError(res, 'Sample Excel files are missing from the sample folder.', 404);
  }

  const sessionsBook = XLSX.readFile(sessionsPath);
  const staffBook = XLSX.readFile(staffPath);
  const engagementBook = XLSX.readFile(engagementPath);
  const sessionsRows = XLSX.utils.sheet_to_json(sessionsBook.Sheets[sessionsBook.SheetNames[0]]);
  const staffRows = XLSX.utils.sheet_to_json(staffBook.Sheets[staffBook.SheetNames[0]]);
  const engagementRows = XLSX.utils.sheet_to_json(engagementBook.Sheets[engagementBook.SheetNames[0]]);

  const store = readStore();
  store.sessions = normalizeImportedSessions(sessionsRows, [], false);
  store.invigilators = staffRows.map((row, index) => ({
    id: generateId(`inv${index}`),
    staffId: String(row.StaffID ?? index + 1).trim(),
    name: String(row.Name ?? '').trim(),
    email: String(row.Email ?? '').trim(),
    role: 'TA',
    loadType: String(row.LoadType ?? 'full').trim() || 'full',
    maxHours: Number(row.MaxHours ?? 0),
    department: '',
    notes: ''
  }));
  store.engagements = engagementRows.map((row, index) => ({
    id: generateId(`eng${index}`),
    staffId: String(row.StaffID ?? '').trim(),
    date: normalizeDate(row.Date),
    startTime: normalizeTime(row.Start),
    endTime: normalizeTime(row.End),
    engagement: Number(row.Engagement ?? 1),
    notes: ''
  }));
  store.assignments = [];
  store.superAssignments = [];
  store.controlSessions = [];
  store.controlAssignments = [];
  store.onCallAssignments = [];
  store.staffHourPolicies = [];
  return persistStoreResponse(res, store, { success: true });
});

app.get('/api/export/workbook', (_req, res) => {
  const store = readStore();
  const file = makeWorkbookFile([
    { name: 'Sessions', rows: makeSessionIdentityRows(store.sessions) },
    { name: 'SessionNeeds', rows: makeSessionNeedRows(store.sessions) },
    { name: 'Invigilators', rows: store.invigilators.map((person) => ({
      StaffID: person.staffId || '',
      Name: person.name || '',
      Email: person.email || '',
      Role: person.role || 'TA',
      LoadType: person.loadType || 'full',
      MaxHours: Number(person.maxHours || 0),
      Department: person.department || '',
      Notes: person.notes || '',
    })) },
    { name: 'Engagements', rows: store.engagements.map((item) => ({
      StaffID: item.staffId || '',
      Date: item.date || '',
      Start: item.startTime || '',
      End: item.endTime || '',
      Engagement: Number(item.engagement ?? 1),
      Notes: item.notes || '',
    })) },
    { name: 'Assignments', rows: makeSchedulingAssignmentRows(store) },
    { name: 'StaffHourPolicies', rows: makeStaffHourPolicyRows(store) },
    { name: 'StaffHourPolicyTemplate', rows: makeStaffHourPolicyTemplateRows() },
    { name: 'OnCallNeeds', rows: makeOnCallNeedRows(store) },
    { name: 'OnCallAssignments', rows: makeOnCallAssignmentRows(store) },
    { name: 'Super', rows: makeSuperAssignmentRows(store) },
    { name: 'ControlSessions', rows: makeControlSessionRows(store.controlSessions) },
    { name: 'ControlAssignments', rows: makeControlAssignmentRows(store) }
  ], 'scheduler_export');
  res.json(file);
});

app.get('/api/export/staff-hour-policies', (_req, res) => {
  const store = readStore();
  const file = makeWorkbookFile([
    { name: 'StaffHourPolicies', rows: makeStaffHourPolicyRows(store) },
    { name: 'StaffHourPolicyTemplate', rows: makeStaffHourPolicyTemplateRows() },
    { name: 'Instructions', rows: makeStaffHourPolicyInstructions() },
  ], 'staff_hour_policies_export');
  res.json(file);
});

app.get('/api/export/staff-hour-policies/template', (_req, res) => {
  const store = readStore();
  const rows = makeStaffHourPolicyRows(store).map(({ PolicyID, InvigilatorID, StaffID, Name, Role, Mode, HoursValue, ExcludeFromAutoSchedule, Notes }) => ({
    PolicyID, InvigilatorID, StaffID, Name, Role, Mode, HoursValue, ExcludeFromAutoSchedule, Notes,
  }));
  const blank = { PolicyID: '', InvigilatorID: '', StaffID: '', Name: '', Role: '', Mode: '', HoursValue: '', ExcludeFromAutoSchedule: '', Notes: '' };
  res.json(makeWorkbookFile([
    { name: 'StaffHourPolicies', rows: rows.length ? rows : [blank] },
    { name: 'Instructions', rows: makeStaffHourPolicyInstructions() },
    { name: 'Examples', rows: makeStaffHourPolicyTemplateRows() },
  ], 'staff_hour_policy_template'));
});

app.get('/api/day-coverage', (_req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const buildStart = perfNow();
    const payload = getCachedDerivedView('dayCoverageView', () => {
      const scheduling = buildSchedulingView(store);
      const { dayWindows } = buildDutyCollections(store);
      const onCallNeeds = buildOnCallNeeds(store);
      const sessionsByDate = new Map();
      const superCountByDate = new Map();
      const controlCountByDate = new Map();
      const onCallNeedByDate = new Map();
      const onCallAssignedByDate = new Map();
      const controlSessionById = new Map(store.controlSessions.map((session) => [session.id, session]));

    scheduling.sessions.forEach((session) => {
      const rows = sessionsByDate.get(session.date) || [];
      rows.push(session);
      sessionsByDate.set(session.date, rows);
    });
    store.superAssignments.forEach((item) => {
      superCountByDate.set(item.date, (superCountByDate.get(item.date) || 0) + 1);
    });
    store.controlAssignments.forEach((item) => {
      const controlSession = controlSessionById.get(item.controlSessionId);
      if (!controlSession?.date) return;
      controlCountByDate.set(controlSession.date, (controlCountByDate.get(controlSession.date) || 0) + 1);
    });
    onCallNeeds.forEach((need) => {
      const current = onCallNeedByDate.get(need.date) || {
        ta: 0,
        doctor: 0,
      };
      current.ta += Number(need.onCallTANeeded || 0);
      current.doctor += Number(need.onCallDoctorNeeded || 0);
      onCallNeedByDate.set(need.date, current);
    });
    (store.onCallAssignments || []).forEach((item) => {
      const current = onCallAssignedByDate.get(item.date) || {
        ta: 0,
        doctor: 0,
      };
      if (item.role === 'Doctor') {
        current.doctor += 1;
      } else {
        current.ta += 1;
      }
      onCallAssignedByDate.set(item.date, current);
    });

    return dayWindows.map((window) => {
      const sessions = sessionsByDate.get(window.date) || [];
      const onCallNeed = onCallNeedByDate.get(window.date) || { ta: 0, doctor: 0 };
      const onCallAssigned = onCallAssignedByDate.get(window.date) || { ta: 0, doctor: 0 };
      return {
        ...window,
        sessionCount: sessions.length,
        taRemaining: sessions.reduce((sum, item) => sum + item.taRemaining, 0),
        doctorRemaining: sessions.reduce((sum, item) => sum + item.doctorRemaining, 0),
        superCount: superCountByDate.get(window.date) || 0,
        controlCount: controlCountByDate.get(window.date) || 0,
        onCallTANeeded: onCallNeed.ta,
        onCallDoctorNeeded: onCallNeed.doctor,
        onCallTAAssigned: onCallAssigned.ta,
        onCallDoctorAssigned: onCallAssigned.doctor,
        onCallTARemaining: Math.max(0, onCallNeed.ta - onCallAssigned.ta),
        onCallDoctorRemaining: Math.max(0, onCallNeed.doctor - onCallAssigned.doctor),
      };
    });
  });
  sendJsonWithPerf(_req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.get('/api/reports/summary', (req, res) => {
  const totalStart = perfNow();
  const readStart = perfNow();
  const store = readStore();
  const readStoreMs = perfMs(readStart);
  const buildStart = perfNow();
  const payload = getCachedDerivedView(
    'reportsSummaryView',
    () => buildReportsSummary(store, req.query),
    JSON.stringify(req.query || {})
  );
  sendJsonWithPerf(req, res, payload, {
    totalMs: perfMs(totalStart),
    readStoreMs,
    buildMs: perfMs(buildStart),
    cacheStatus: 'versioned',
  });
});

app.get('/api/reports/workload', (req, res) => {
  res.json(buildWorkloadReport(readStore(), req.query));
});

app.get('/api/reports/fairness', (req, res) => {
  res.json(buildFairnessReport(readStore(), req.query));
});

app.get('/api/reports/daily-coverage', (req, res) => {
  res.json(buildDailyCoverageReport(readStore(), req.query));
});

app.get('/api/reports/room-shortage', (req, res) => {
  res.json(buildRoomShortageReport(readStore(), req.query));
});

app.get('/api/reports/engagement-overrides', (req, res) => {
  res.json(buildEngagementOverrideReport(readStore(), req.query));
});

app.get('/api/reports/conflicts', (req, res) => {
  res.json(buildConflictReport(readStore(), req.query));
});

app.get('/api/reports/detailed-load', (req, res) => {
  res.json(buildDetailedLoadReport(readStore(), req.query));
});

app.get('/api/reports/staff/:staffId', (req, res) => {
  const report = buildStaffReport(readStore(), req.query, req.params.staffId);
  if (!report.person) {
    return respondError(res, 'Staff member not found.', 404);
  }
  return res.json(report);
});

app.get('/api/reports/session-coverage', (req, res) => {
  res.json(buildSessionCoverageReport(readStore(), req.query));
});

app.get('/api/reports/utilization', (req, res) => {
  res.json(buildUtilizationReport(readStore(), req.query));
});

app.get('/api/reports/quality-score', (req, res) => {
  res.json(buildQualityScoreReport(readStore(), req.query));
});

app.get('/api/course-room-assignment', async (_req, res) => {
  try {
    res.json(await getCourseRoomAssignmentState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/course-room-assignment/quality', async (_req, res) => {
  try {
    res.json(await getCourseRoomQuality());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/course-room-assignment/import-schedule', async (req, res) => {
  try {
    const rows = readImportRows(req, res, 'Course-room schedule');
    if (!rows) return;
    res.json(await importCourseRoomScheduleRows(rows));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/course-room-assignment/import-room-sessions', async (req, res) => {
  try {
    const rows = readImportRows(req, res, 'Course-room sessions');
    if (!rows) return;
    res.json(await importCourseRoomSessionRows(rows));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/course-room-assignment/import-room-capacity', async (req, res) => {
  try {
    const rows = readImportRows(req, res, 'Course-room capacity');
    if (!rows) return;
    res.json(await importCourseRoomCapacityRows(rows));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/course-room-assignment/run', async (req, res) => {
  try {
    res.json(await runCourseRoomAssignment(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/course-room-assignment/manual-assign', async (req, res) => {
  try {
    res.json(await manualAssignCourseRoom(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/course-room-assignment/results', async (_req, res) => {
  try {
    res.json(await clearCourseRoomResults());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/course-room-assignment/export', async (_req, res) => {
  try {
    res.json(await exportCourseRoomAssignment());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/course-room-assignment/export-unassigned', async (_req, res) => {
  try {
    res.json(await exportCourseRoomUnassigned());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/data/export', (_req, res) => {
  res.json(readStore());
});

app.post('/api/data/import', (req, res) => {
  const payload = req.body || {};
  const data = payload.data;

  if (!data || typeof data !== 'object') {
    return respondError(res, 'A valid scheduler data object is required.');
  }

  const normalized = {
    sessions: normalizeImportedSessions(Array.isArray(data.sessions) ? data.sessions : [], [], true),
    invigilators: Array.isArray(data.invigilators)
      ? data.invigilators.map((row, index) => normalizeInvigilatorRow(row, index, true)).filter((row) => row.staffId || row.name)
      : [],
    engagements: Array.isArray(data.engagements)
      ? data.engagements.map((row, index) => normalizeEngagementRow(row, index, true))
      : [],
    assignments: [],
    superAssignments: [],
    controlSessions: Array.isArray(data.controlSessions)
      ? data.controlSessions.map((row, index) => normalizeControlSessionRow(row, index, true)).filter((row) => row.date && row.startTime && row.endTime)
      : [],
    controlAssignments: [],
    onCallAssignments: [],
    schedulingConfig: normalizeSchedulingConfig(data.schedulingConfig),
    onCallConfig: normalizeOnCallConfig(data.onCallConfig),
    staffHourPolicies: []
  };

  const sessionIds = new Set(normalized.sessions.map((session) => String(session.id)));
  const sessionBlockMap = new Map(normalized.sessions.map((session) => [buildSessionRoomStartKey(session), String(session.id)]));
  const sessionBlockCourseMap = new Map(normalized.sessions.map((session) => [buildSessionBlockCourseKey(session), String(session.id)]));
  const sessionTimeRoomMap = new Map(normalized.sessions.map((session) => [buildSessionTimeRoomKey(session), String(session.id)]));
  const invigilatorIds = new Set(normalized.invigilators.map((person) => String(person.id)));
  const invigilatorByStaffId = new Map(normalized.invigilators.map((person) => [String(person.staffId), String(person.id)]));
  const staffIdByInvigilatorId = new Map(normalized.invigilators.map((person) => [String(person.id), String(person.staffId)]));
  const knownStaffIds = new Set(normalized.invigilators.map((person) => String(person.staffId)));
  const controlSessionIds = new Set(normalized.controlSessions.map((session) => String(session.id)));

  normalized.engagements = normalized.engagements
    .map((row) => ({
      ...row,
      staffId: staffIdByInvigilatorId.get(String(row.staffId)) || String(row.staffId)
    }))
    .filter((row) => row.staffId && row.date && row.startTime && row.endTime && knownStaffIds.has(String(row.staffId)));

  normalized.assignments = (Array.isArray(data.assignments) ? data.assignments : [])
    .map((row, index) => normalizeAssignmentRow(row, index, true))
    .map((row) => ({
      ...row,
      sessionId: sessionIds.has(row.sessionId) ? row.sessionId : (
        sessionBlockMap.get(buildSessionRoomStartKey({
          date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
          startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
          room: String(readRoomInput(row)).trim()
        }))
        || sessionBlockCourseMap.get(buildSessionBlockCourseKey({
          date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
          startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
          room: String(readRoomInput(row)).trim(),
          courseName: readCourseInput(row),
          courseNames: normalizeCourseNames(readCourseInput(row))
        }))
        || sessionTimeRoomMap.get(buildSessionTimeRoomKey({
          date: normalizeDate(row.Date ?? row.date, row.Day ?? row.day),
          startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
          endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
          room: String(readRoomInput(row)).trim()
        }))
        || row.sessionId
      ),
      invigilatorId: invigilatorByStaffId.get(row.invigilatorId) || row.invigilatorId
    }))
    .filter((row) => sessionIds.has(String(row.sessionId)) && invigilatorIds.has(String(row.invigilatorId)));

  normalized.superAssignments = (Array.isArray(data.superAssignments) ? data.superAssignments : [])
    .map((row, index) => normalizeSuperAssignmentRow(row, index, true))
    .map((row) => ({
      ...row,
      invigilatorId: invigilatorByStaffId.get(row.invigilatorId) || row.invigilatorId
    }))
    .filter((row) => row.date && invigilatorIds.has(String(row.invigilatorId)));

  normalized.controlAssignments = (Array.isArray(data.controlAssignments) ? data.controlAssignments : [])
    .map((row, index) => normalizeControlAssignmentRow(row, index, true))
    .map((row) => ({
      ...row,
      invigilatorId: invigilatorByStaffId.get(row.invigilatorId) || row.invigilatorId
    }))
    .filter((row) => controlSessionIds.has(String(row.controlSessionId)) && invigilatorIds.has(String(row.invigilatorId)));

  const validOnCallPeriodKeys = new Set(buildOnCallNeeds(normalized).map((item) => `${item.date}|${item.startTime}|${item.endTime}`));
  normalized.onCallAssignments = (Array.isArray(data.onCallAssignments) ? data.onCallAssignments : [])
    .map((row, index) => ({
      id: String(row.id || generateId(`oncallimp${index}`)).trim(),
      date: normalizeDate(row.Date ?? row.date),
      startTime: normalizeTime(row.Start ?? row.startTime ?? row.start_time),
      endTime: normalizeTime(row.End ?? row.endTime ?? row.end_time),
      invigilatorId: invigilatorByStaffId.get(String(row.invigilatorId || row.staffId || row.StaffID || '').trim()) || String(row.invigilatorId || '').trim(),
      role: String(row.role || row.Role || 'TA').trim() || 'TA',
      engagementOverrideReason: String(row.engagementOverrideReason || row.EngagementOverrideReason || ''),
    }))
    .filter((row) => invigilatorIds.has(String(row.invigilatorId)) && validOnCallPeriodKeys.has(`${row.date}|${row.startTime}|${row.endTime}`));

  normalized.staffHourPolicies = (Array.isArray(data.staffHourPolicies) ? data.staffHourPolicies : [])
    .map((row) => {
      try {
        return normalizeStaffHourPolicyInput(normalized, row, String(row.id || row.PolicyID || row.policyId || ''));
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);

  return persistStoreResponse(res, normalized, { success: true, counts: {
    sessions: normalized.sessions.length,
    invigilators: normalized.invigilators.length,
    engagements: normalized.engagements.length,
    assignments: normalized.assignments.length,
    superAssignments: normalized.superAssignments.length,
    controlSessions: normalized.controlSessions.length,
    controlAssignments: normalized.controlAssignments.length,
    onCallAssignments: normalized.onCallAssignments.length,
    staffHourPolicies: normalized.staffHourPolicies.length
  } });
});

app.delete('/api/data/reset', (_req, res) => {
  return persistStoreResponse(res, {
    sessions: [],
    invigilators: [],
    engagements: [],
    assignments: [],
    superAssignments: [],
    controlSessions: [],
    controlAssignments: [],
    onCallAssignments: [],
    staffHourPolicies: []
  }, { success: true });
});

const clientBuild = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuild));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.sendFile(path.join(clientBuild, 'index.html'));
});

// Keep API failures JSON-shaped. Without this handler, malformed or oversized
// JSON import payloads are rendered as Express HTML and the client can only say
// "Request failed", which makes spreadsheet problems impossible to diagnose.
app.use((error, req, res, _next) => {
  if (res.headersSent) return;

  if (error?.type === 'entity.too.large' || error?.status === 413) {
    return res.status(413).json({
      error: `Import data is too large. Reduce the worksheet size or ask an administrator to increase IMPORT_JSON_LIMIT (currently ${IMPORT_JSON_LIMIT}).`,
    });
  }

  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return res.status(400).json({ error: 'Import data is not valid JSON. Please select and import the Excel file again.' });
  }

  console.error('[api] unhandled request error:', error);
  return res.status(error?.status || 500).json({ error: 'Unexpected server error while processing the request.' });
});

async function startServer() {
  try {
    const init = await initStoreFromPrimary();
    const storageInfo = getStartupStorageInfo();
    console.log(`[storage] startup source: ${storageInfo.startupSource}`);
    console.log(`[storage] selected counts: sessions=${init.counts.sessions}, sessionNeeds=${init.counts.sessionNeeds}, invigilators=${init.counts.invigilators}, assignments=${init.counts.assignments}, superAssignments=${init.counts.superAssignments}, controlSessions=${init.counts.controlSessions}, controlAssignments=${init.counts.controlAssignments}, onCallAssignments=${init.counts.onCallAssignments || 0}`);
    if (storageInfo.jsonMirrorsRebuiltFromSqlite) {
      console.log('[storage] store.json and store.last-good.json rebuilt from sqlite');
    }
    if (storageInfo.sqlitePromotedFromJson) {
      console.log('[storage] sqlite promoted from json mirrors');
    }
    if (Array.isArray(storageInfo.corruptedSources)) {
      storageInfo.corruptedSources.forEach((warning) => console.log(`[storage] corrupted source: ${warning}`));
    }
    if (Array.isArray(storageInfo.warnings)) {
      storageInfo.warnings.forEach((warning) => console.log(`[storage] warning: ${warning}`));
    }
  } catch (error) {
    console.error('Failed to initialize app store from primary storage:', error);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`UNI scheduler web app running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
