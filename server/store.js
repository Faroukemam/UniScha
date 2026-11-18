const fs = require('fs');
const path = require('path');
const { initDb, write: writeDb, all, dbPath } = require('./db');

const dataDir = path.join(__dirname, 'data');
const storePath = path.join(dataDir, 'store.json');
const storeBackupPath = path.join(dataDir, 'store.last-good.json');
let storeState = null;
let writeQueue = Promise.resolve();
let storeVersion = 0;
const derivedViewCache = new Map();
let startupStorageInfo = {
  startupSource: 'unknown',
  startupTimestamp: null,
  sqlitePromotedFromJson: false,
  jsonMirrorsRebuiltFromSqlite: false,
  corruptedSources: [],
  selectedCounts: summarizeEmptyCounts(),
  warnings: [],
};

function isPerfLogEnabled() {
  return process.env.PERF_LOG === '1';
}

function logCache(message) {
  if (isPerfLogEnabled()) {
    console.log(message);
  }
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function clearDerivedViewCache() {
  derivedViewCache.clear();
}

function bumpStoreVersion() {
  storeVersion += 1;
  clearDerivedViewCache();
  return storeVersion;
}

function getStoreVersion() {
  return storeVersion;
}

function getCachedDerivedView(name, builder, cacheKey = 'default', sourceStore = null) {
  const key = `${name}|${cacheKey}`;
  const currentVersion = getStoreVersion();
  // Preview and eligibility calculations also operate on edited copies before
  // persistence. A global version alone cannot identify their inputs.
  const sourceSnapshot = sourceStore ? JSON.stringify(sourceStore) : null;
  const cached = derivedViewCache.get(key);
  if (cached && cached.version === currentVersion && cached.sourceSnapshot === sourceSnapshot) {
    logCache(`[cache] ${name} hit version=${currentVersion}`);
    return cached.value;
  }
  if (cached) {
    logCache(`[cache] ${name} miss oldVersion=${cached.version} currentVersion=${currentVersion}`);
  } else {
    logCache(`[cache] ${name} miss version=${currentVersion}`);
  }
  const value = builder();
  derivedViewCache.set(key, { version: currentVersion, sourceSnapshot, value });
  return value;
}

const SCHEDULING_PREFERENCES = ['engagement_overrides', 'consecutive_days', 'consecutive_duties', 'daily_soft_target'];
const SCHEDULING_WEIGHTS = { engagement_overrides: 100, consecutive_days: 50, consecutive_duties: 10, daily_soft_target: 1 };

function normalizeSchedulingConfig(config = {}) {
  const supplied = Array.isArray(config.preferenceOrder) ? config.preferenceOrder : [];
  const preferenceOrder = [...new Set(supplied.filter((key) => SCHEDULING_PREFERENCES.includes(key)))];
  SCHEDULING_PREFERENCES.forEach((key) => { if (!preferenceOrder.includes(key)) preferenceOrder.push(key); });
  const target = Number(config.dailySoftTarget ?? 2);
  const weights = Object.fromEntries(SCHEDULING_PREFERENCES.map((key) => {
    const weight = config.weights?.[key];
    return [key, Number.isInteger(weight) && weight >= 0 && weight <= 1000 ? weight : SCHEDULING_WEIGHTS[key]];
  }));
  if (!Object.values(weights).some((weight) => weight > 0)) Object.assign(weights, SCHEDULING_WEIGHTS);
  return { preferenceOrder, dailySoftTarget: Number.isInteger(target) && target >= 0 && target <= 20 ? target : 2,
    scoringMode: config.scoringMode === 'weighted' ? 'weighted' : 'ranked', weights };
}

const emptyStore = {
  sessions: [],
  invigilators: [],
  engagements: [],
  assignments: [],
  superAssignments: [],
  controlSessions: [],
  controlAssignments: [],
  onCallAssignments: [],
  onCallConfig: {},
  schedulingConfig: normalizeSchedulingConfig(),
  staffHourPolicies: []
};

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify(emptyStore, null, 2));
  }
  if (!fs.existsSync(storeBackupPath)) {
    fs.writeFileSync(storeBackupPath, JSON.stringify(emptyStore, null, 2));
  }
}

function summarizeEmptyCounts() {
  return {
    sessions: 0,
    sessionNeeds: 0,
    invigilators: 0,
    engagements: 0,
    assignments: 0,
    superAssignments: 0,
    controlSessions: 0,
    controlAssignments: 0,
    onCallAssignments: 0,
    staffHourPolicies: 0,
  };
}

function normalizeParsedStore(parsed) {
  return normalizeStoreSessions({
    ...emptyStore,
    ...parsed,
    engagements: Array.isArray(parsed.engagements) ? parsed.engagements : [],
    controlSessions: Array.isArray(parsed.controlSessions) ? parsed.controlSessions : [],
    onCallAssignments: Array.isArray(parsed.onCallAssignments) ? parsed.onCallAssignments : [],
    onCallConfig: normalizeOnCallConfig(parsed.onCallConfig || parsed.on_call_config || {}),
    schedulingConfig: normalizeSchedulingConfig(parsed.schedulingConfig || {}),
    staffHourPolicies: Array.isArray(parsed.staffHourPolicies) ? parsed.staffHourPolicies : [],
  });
}

function normalizeNonNegativeInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.round(numeric);
}

function normalizePositiveInteger(value, fallback) {
  const normalized = normalizeNonNegativeInteger(value, fallback);
  return normalized > 0 ? normalized : fallback;
}

function normalizeBelowThresholdMode(value, fallback = 'at_least_one') {
  const raw = String(value || fallback).trim().toLowerCase();
  return raw === 'zero' ? 'zero' : 'at_least_one';
}

function normalizeOnCallConfig(config = {}) {
  const rawMode = String(config.mode || config.ruleMode || 'rooms_based').trim().toLowerCase();
  const excludedInvigilatorIds = Array.isArray(config.excludedInvigilatorIds)
    ? config.excludedInvigilatorIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return {
    mode: rawMode === 'fixed_per_period' ? 'fixed_per_period' : 'rooms_based',
    fixedTAsPerPeriod: normalizeNonNegativeInteger(config.fixedTAsPerPeriod, 1),
    fixedDoctorsPerPeriod: normalizeNonNegativeInteger(config.fixedDoctorsPerPeriod, 1),
    taRoomsPerStep: normalizePositiveInteger(config.taRoomsPerStep, 3),
    taStaffPerStep: normalizePositiveInteger(config.taStaffPerStep, 1),
    taBelowThresholdMode: normalizeBelowThresholdMode(config.taBelowThresholdMode, 'at_least_one'),
    doctorRoomsPerStep: normalizePositiveInteger(config.doctorRoomsPerStep, 6),
    doctorStaffPerStep: normalizePositiveInteger(config.doctorStaffPerStep, 1),
    doctorBelowThresholdMode: normalizeBelowThresholdMode(config.doctorBelowThresholdMode, 'at_least_one'),
    excludedInvigilatorIds: [...new Set(excludedInvigilatorIds)],
  };
}

function normalizeAssignmentSource(value, fallback = 'legacy') {
  const raw = String(value || fallback || 'legacy').trim().toLowerCase();
  if (['manual', 'auto', 'import', 'legacy'].includes(raw)) {
    return raw;
  }
  return fallback || 'legacy';
}

function normalizeAssignmentLocked(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  if (['1', 'true', 'yes', 'y', 'locked'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'unlocked'].includes(raw)) return false;
  return Boolean(fallback);
}

function normalizeAssignmentMetadata(assignment, options = {}) {
  const sourceFallback = options.sourceFallback || 'legacy';
  const source = normalizeAssignmentSource(
    assignment.assignmentSource ?? assignment.assignment_source ?? assignment.source,
    sourceFallback
  );
  const lockedFallback = options.lockedFallback ?? source !== 'auto';
  const createdAt = String(assignment.createdAt ?? assignment.created_at ?? '').trim();
  const updatedAt = String(assignment.updatedAt ?? assignment.updated_at ?? createdAt).trim();
  return {
    ...assignment,
    assignmentSource: source,
    locked: normalizeAssignmentLocked(assignment.locked, lockedFallback),
    createdAt,
    updatedAt,
    notes: String(assignment.notes || '').trim(),
    engagementOverrideReason: String(assignment.engagementOverrideReason ?? assignment.engagement_override_reason ?? '').trim(),
  };
}

function readJsonStoreFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return normalizeParsedStore(parsed);
}

function cloneStore(store) {
  return JSON.parse(JSON.stringify(normalizeParsedStore(store || emptyStore)));
}

function persistStoreJson(store) {
  ensureStore();
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  fs.writeFileSync(storeBackupPath, JSON.stringify(store, null, 2));
}

function summarizeStoreCounts(store) {
  const normalized = normalizeParsedStore(store || emptyStore);
  return {
    sessions: Array.isArray(normalized.sessions) ? normalized.sessions.length : 0,
    sessionNeeds: Array.isArray(normalized.sessions)
      ? normalized.sessions.filter((item) => Number(item.taNeeded || 0) > 0 || Number(item.doctorNeeded || 0) > 0 || Number(item.totalNeeded || 0) > 0).length
      : 0,
    invigilators: Array.isArray(normalized.invigilators) ? normalized.invigilators.length : 0,
    engagements: Array.isArray(normalized.engagements) ? normalized.engagements.length : 0,
    assignments: Array.isArray(normalized.assignments) ? normalized.assignments.length : 0,
    superAssignments: Array.isArray(normalized.superAssignments) ? normalized.superAssignments.length : 0,
    controlSessions: Array.isArray(normalized.controlSessions) ? normalized.controlSessions.length : 0,
    controlAssignments: Array.isArray(normalized.controlAssignments) ? normalized.controlAssignments.length : 0,
    onCallAssignments: Array.isArray(normalized.onCallAssignments) ? normalized.onCallAssignments.length : 0,
    staffHourPolicies: Array.isArray(normalized.staffHourPolicies) ? normalized.staffHourPolicies.length : 0,
  };
}

function scoreStore(store) {
  const counts = summarizeStoreCounts(store);
  return (
    counts.sessions * 5
    + counts.invigilators * 5
    + counts.engagements * 3
    + counts.assignments * 8
    + counts.superAssignments * 4
    + counts.controlSessions * 4
    + counts.controlAssignments * 4
    + counts.onCallAssignments * 4
    + counts.staffHourPolicies * 2
  );
}

function inspectJsonStoreFile(filePath) {
  ensureStore();
  const status = {
    path: filePath,
    exists: fs.existsSync(filePath),
    readSuccess: false,
    counts: summarizeEmptyCounts(),
    error: null,
    store: cloneStore(emptyStore),
  };
  if (!status.exists) {
    status.error = 'File does not exist.';
    return status;
  }
  try {
    status.store = readJsonStoreFile(filePath);
    status.counts = summarizeStoreCounts(status.store);
    status.readSuccess = true;
  } catch (error) {
    status.error = error.message;
  }
  return status;
}

function readBestJsonStore() {
  const storeStatus = inspectJsonStoreFile(storePath);
  if (storeStatus.readSuccess) {
    return { source: 'store-json', ...storeStatus, storeStatus, backupStatus: inspectJsonStoreFile(storeBackupPath) };
  }
  const backupStatus = inspectJsonStoreFile(storeBackupPath);
  if (backupStatus.readSuccess) {
    return { source: 'last-good-json', ...backupStatus, storeStatus, backupStatus };
  }
  return {
    source: 'empty',
    path: storePath,
    exists: false,
    readSuccess: false,
    counts: summarizeEmptyCounts(),
    error: storeStatus.error || backupStatus.error || null,
    store: cloneStore(emptyStore),
    storeStatus,
    backupStatus,
  };
}

function readStore() {
  if (storeState) {
    return cloneStore(storeState);
  }
  ensureStore();
  try {
    const recovered = readJsonStoreFile(storePath);
    storeState = cloneStore(recovered);
    return cloneStore(storeState);
  } catch (error) {
    try {
      const recovered = readJsonStoreFile(storeBackupPath);
      persistStoreJson(recovered);
      storeState = cloneStore(recovered);
      return cloneStore(storeState);
    } catch (_backupError) {
      persistStoreJson(emptyStore);
      storeState = cloneStore(emptyStore);
      return cloneStore(storeState);
    }
  }
}

async function writeStore(data, options = {}) {
  const snapshot = cloneStore(data);
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    if (options.expectedVersion !== undefined && options.expectedVersion !== storeVersion) {
      const error = new Error('Policies, session needs, or assignments changed while scheduling. Run the scheduler again with the latest data.');
      error.status = 409;
      throw error;
    }
    await syncStoreToDb(snapshot);
    persistStoreJson(snapshot);
    storeState = cloneStore(snapshot);
    bumpStoreVersion();
    return cloneStore(storeState);
  });
  return writeQueue;
}

function looksMeaningfullyEmpty(store) {
  return !store
    || (
      (!Array.isArray(store.sessions) || store.sessions.length === 0)
      && (!Array.isArray(store.invigilators) || store.invigilators.length === 0)
      && (!Array.isArray(store.engagements) || store.engagements.length === 0)
      && (!Array.isArray(store.assignments) || store.assignments.length === 0)
      && (!Array.isArray(store.superAssignments) || store.superAssignments.length === 0)
      && (!Array.isArray(store.controlSessions) || store.controlSessions.length === 0)
      && (!Array.isArray(store.controlAssignments) || store.controlAssignments.length === 0)
      && (!Array.isArray(store.onCallAssignments) || store.onCallAssignments.length === 0)
      && (!Array.isArray(store.staffHourPolicies) || store.staffHourPolicies.length === 0)
    );
}

function splitCourseNames(value) {
  return String(value || '')
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function buildStoreFromDb() {
  await initDb();
  const [
    sessions,
    invigilators,
    engagements,
    assignments,
    superAssignments,
    controlSessions,
    controlAssignments,
    onCallAssignments,
    onCallConfigRows,
    schedulingConfigRows,
    staffHourPolicies,
  ] = await Promise.all([
    all(`
      SELECT id, course_name, room, exam_date, start_time, end_time, duration_hours,
             ta_needed, doctor_needed, total_needed, notes
      FROM sessions
      ORDER BY exam_date, start_time, room, id
    `),
    all(`
      SELECT staff_id, name, email, role, load_type, max_hours, department, notes
      FROM invigilators
      ORDER BY name, staff_id
    `),
    all(`
      SELECT id, staff_id, exam_date, start_time, end_time, engagement, notes
      FROM engagements
      ORDER BY exam_date, start_time, id
    `),
    all(`
      SELECT id, session_id, staff_id, role, assignment_source, locked, created_at, updated_at, notes, engagement_override_reason
      FROM assignments
      ORDER BY session_id, staff_id, id
    `),
    all(`
      SELECT id, exam_date, staff_id
      FROM super_assignments
      ORDER BY exam_date, staff_id, id
    `),
    all(`
      SELECT id, course_name, room, exam_date, start_time, end_time, ta_needed, doctor_needed, total_needed, notes
      FROM control_sessions
      ORDER BY exam_date, start_time, room, id
    `),
    all(`
      SELECT id, control_session_id, staff_id, role
      FROM control_assignments
      ORDER BY control_session_id, staff_id, id
    `),
    all(`
      SELECT id, exam_date, start_time, end_time, staff_id, role, engagement_override_reason
      FROM on_call_assignments
      ORDER BY exam_date, start_time, end_time, staff_id, id
    `),
    all(`
      SELECT config_key, config_value
      FROM on_call_config
      ORDER BY config_key
    `),
    all('SELECT config_key, config_value FROM scheduling_config'),
    all(`
      SELECT id, staff_id, role, mode, hours_value, exclude_from_auto_schedule, prefer_consecutive_duties, prefer_consecutive_days, allow_engagement_override, notes
      FROM staff_hour_policies
      ORDER BY staff_id, id
    `),
  ]);

  const invigilatorsNormalized = invigilators.map((row) => ({
    id: `inv_${String(row.staff_id || '').trim()}`,
    staffId: String(row.staff_id || '').trim(),
    name: String(row.name || '').trim(),
    email: String(row.email || '').trim(),
    role: String(row.role || 'TA').trim() || 'TA',
    loadType: String(row.load_type || 'full').trim() || 'full',
    maxHours: Number(row.max_hours || 0),
    department: String(row.department || '').trim(),
    notes: String(row.notes || '').trim(),
  }));

  const invigilatorIdByStaffId = new Map(invigilatorsNormalized.map((row) => [String(row.staffId), row.id]));

  const sessionsNormalized = sessions.map((row) => ({
    id: `ses_db_${row.id}`,
    courseNames: splitCourseNames(row.course_name),
    courseName: String(row.course_name || '').trim(),
    room: String(row.room || '').trim(),
    date: String(row.exam_date || '').trim(),
    startTime: String(row.start_time || '').trim(),
    endTime: String(row.end_time || '').trim(),
    durationHours: Number(row.duration_hours || 0),
    taNeeded: Number(row.ta_needed || 0),
    doctorNeeded: Number(row.doctor_needed || 0),
    totalNeeded: Number(row.total_needed || 0),
    notes: String(row.notes || '').trim(),
  }));

  const sessionIdByDbId = new Map(sessions.map((row) => [String(row.id), `ses_db_${row.id}`]));

  const controlSessionsNormalized = controlSessions.map((row) => ({
    id: `ctlses_db_${row.id}`,
    courseNames: splitCourseNames(row.course_name),
    courseName: String(row.course_name || '').trim(),
    room: String(row.room || '').trim(),
    date: String(row.exam_date || '').trim(),
    startTime: String(row.start_time || '').trim(),
    endTime: String(row.end_time || '').trim(),
    taNeeded: Number(row.ta_needed || 0),
    doctorNeeded: Number(row.doctor_needed || 0),
    totalNeeded: Number(row.total_needed || 0),
    notes: String(row.notes || '').trim(),
  }));

  const controlSessionIdByDbId = new Map(controlSessions.map((row) => [String(row.id), `ctlses_db_${row.id}`]));
  const onCallConfigRow = onCallConfigRows.find((row) => String(row.config_key || '').trim() === 'default');
  let onCallConfig = normalizeOnCallConfig({});
  if (onCallConfigRow?.config_value) {
    try {
      onCallConfig = normalizeOnCallConfig(JSON.parse(String(onCallConfigRow.config_value)));
    } catch (_error) {
      onCallConfig = normalizeOnCallConfig({});
    }
  }

  let schedulingConfig = normalizeSchedulingConfig();
  try { schedulingConfig = normalizeSchedulingConfig(JSON.parse(schedulingConfigRows.find((row) => row.config_key === 'default')?.config_value || '{}')); } catch (_) { /* Legacy data uses defaults. */ }
  return normalizeParsedStore({
    schedulingConfig,
    sessions: sessionsNormalized,
    invigilators: invigilatorsNormalized,
    engagements: engagements.map((row) => ({
      id: `eng_db_${row.id}`,
      staffId: String(row.staff_id || '').trim(),
      date: String(row.exam_date || '').trim(),
      startTime: String(row.start_time || '').trim(),
      endTime: String(row.end_time || '').trim(),
      engagement: Number(row.engagement ?? 1),
      notes: String(row.notes || '').trim(),
    })),
    assignments: assignments
      .map((row) => normalizeAssignmentMetadata({
        id: `asg_db_${row.id}`,
        sessionId: sessionIdByDbId.get(String(row.session_id)),
        invigilatorId: invigilatorIdByStaffId.get(String(row.staff_id)),
        role: String(row.role || '').trim(),
        assignmentSource: String(row.assignment_source || 'legacy').trim() || 'legacy',
        engagementOverrideReason: String(row.engagement_override_reason || ''),
        locked: Number(row.locked ?? 1) === 1,
        createdAt: String(row.created_at || '').trim(),
        updatedAt: String(row.updated_at || '').trim(),
        notes: String(row.notes || '').trim(),
      }, { sourceFallback: 'legacy', lockedFallback: true }))
      .filter((row) => row.sessionId && row.invigilatorId),
    superAssignments: superAssignments
      .map((row) => ({
        id: `sup_db_${row.id}`,
        date: String(row.exam_date || '').trim(),
        invigilatorId: invigilatorIdByStaffId.get(String(row.staff_id)),
      }))
      .filter((row) => row.date && row.invigilatorId),
    controlSessions: controlSessionsNormalized,
    controlAssignments: controlAssignments
      .map((row) => ({
        id: `ctlasg_db_${row.id}`,
        controlSessionId: controlSessionIdByDbId.get(String(row.control_session_id)),
        invigilatorId: invigilatorIdByStaffId.get(String(row.staff_id)),
        role: String(row.role || '').trim(),
      }))
      .filter((row) => row.controlSessionId && row.invigilatorId),
    onCallAssignments: onCallAssignments
      .map((row) => ({
        id: `oncall_db_${row.id}`,
        date: String(row.exam_date || '').trim(),
        startTime: String(row.start_time || '').trim(),
        endTime: String(row.end_time || '').trim(),
        invigilatorId: invigilatorIdByStaffId.get(String(row.staff_id)),
        role: String(row.role || '').trim() || 'TA',
        engagementOverrideReason: String(row.engagement_override_reason || ''),
      }))
      .filter((row) => row.date && row.startTime && row.endTime && row.invigilatorId),
    onCallConfig,
    staffHourPolicies: staffHourPolicies
      .map((row) => ({
        id: `hourpol_db_${row.id}`,
        invigilatorId: invigilatorIdByStaffId.get(String(row.staff_id)),
        staffId: String(row.staff_id || '').trim(),
        role: String(row.role || '').trim() || 'TA',
        mode: String(row.mode || 'default').trim() || 'default',
        hoursValue: Number(row.hours_value || 0),
        excludeFromAutoSchedule: Number(row.exclude_from_auto_schedule || 0) === 1,
        preferConsecutiveDuties: Number(row.prefer_consecutive_duties || 0) === 1,
        preferConsecutiveDays: Number(row.prefer_consecutive_days || 0) === 1,
        allowEngagementOverride: Number(row.allow_engagement_override ?? 1) === 1,
        notes: String(row.notes || '').trim(),
      }))
      .filter((row) => row.invigilatorId && row.staffId),
  });
}

async function restoreStoreFromDbIfNeeded() {
  ensureStore();
  const currentStore = readStore();
  if (!looksMeaningfullyEmpty(currentStore)) {
    return { restored: false, reason: 'store_json_present', counts: {
      sessions: currentStore.sessions.length,
      invigilators: currentStore.invigilators.length,
      engagements: currentStore.engagements.length,
      assignments: currentStore.assignments.length,
      superAssignments: currentStore.superAssignments.length,
      controlSessions: currentStore.controlSessions.length,
      controlAssignments: currentStore.controlAssignments.length,
      onCallAssignments: currentStore.onCallAssignments.length,
      staffHourPolicies: currentStore.staffHourPolicies.length,
    } };
  }

  const dbStore = await buildStoreFromDb();
  if (looksMeaningfullyEmpty(dbStore)) {
    return { restored: false, reason: 'sqlite_empty', counts: {
      sessions: 0,
      invigilators: 0,
      engagements: 0,
      assignments: 0,
      superAssignments: 0,
      controlSessions: 0,
      controlAssignments: 0,
      onCallAssignments: 0,
      staffHourPolicies: 0,
    } };
  }

  storeState = cloneStore(dbStore);
  persistStoreJson(storeState);
  clearDerivedViewCache();
  return { restored: true, reason: 'restored_from_sqlite', counts: {
    sessions: storeState.sessions.length,
    invigilators: storeState.invigilators.length,
    engagements: storeState.engagements.length,
    assignments: storeState.assignments.length,
    superAssignments: storeState.superAssignments.length,
    controlSessions: storeState.controlSessions.length,
    controlAssignments: storeState.controlAssignments.length,
    onCallAssignments: storeState.onCallAssignments.length,
    staffHourPolicies: storeState.staffHourPolicies.length,
  } };
}

async function initStoreFromPrimary() {
  ensureStore();
  const dbStore = await buildStoreFromDb();
  const jsonStatus = readBestJsonStore();
  const jsonStore = jsonStatus.store;

  const dbScore = scoreStore(dbStore);
  const jsonScore = scoreStore(jsonStore);
  startupStorageInfo = {
    startupSource: 'unknown',
    startupTimestamp: new Date().toISOString(),
    sqlitePromotedFromJson: false,
    jsonMirrorsRebuiltFromSqlite: false,
    corruptedSources: [],
    selectedCounts: summarizeEmptyCounts(),
    warnings: [],
  };
  if (jsonStatus.storeStatus?.error) startupStorageInfo.corruptedSources.push(`store.json: ${jsonStatus.storeStatus.error}`);
  if (jsonStatus.backupStatus?.error) startupStorageInfo.corruptedSources.push(`store.last-good.json: ${jsonStatus.backupStatus.error}`);

  if (!looksMeaningfullyEmpty(dbStore) && dbScore >= jsonScore) {
    storeState = cloneStore(dbStore);
    persistStoreJson(storeState);
    clearDerivedViewCache();
    startupStorageInfo.startupSource = 'sqlite';
    startupStorageInfo.jsonMirrorsRebuiltFromSqlite = true;
    startupStorageInfo.selectedCounts = summarizeStoreCounts(storeState);
    startupStorageInfo.warnings = buildMismatchWarnings(startupStorageInfo.selectedCounts, jsonStatus.storeStatus?.counts, jsonStatus.backupStatus?.counts);
    return {
      source: startupStorageInfo.startupSource,
      counts: startupStorageInfo.selectedCounts,
    };
  }

  storeState = cloneStore(jsonStore);
  if (!looksMeaningfullyEmpty(storeState)) {
    await syncStoreToDb(storeState);
    startupStorageInfo.sqlitePromotedFromJson = true;
  }
  persistStoreJson(storeState);
  clearDerivedViewCache();
  startupStorageInfo.startupSource = jsonStatus.source === 'store-json' ? 'store-json' : jsonStatus.source === 'last-good-json' ? 'last-good-json' : 'empty';
  startupStorageInfo.selectedCounts = summarizeStoreCounts(storeState);
  startupStorageInfo.warnings = buildMismatchWarnings(startupStorageInfo.selectedCounts, jsonStatus.storeStatus?.counts, jsonStatus.backupStatus?.counts);
  return {
    source: startupStorageInfo.startupSource,
    counts: startupStorageInfo.selectedCounts,
  };
}

function buildMismatchWarnings(sqliteCounts, storeCounts, backupCounts) {
  const warnings = [];
  const keys = Object.keys(summarizeEmptyCounts());
  for (const key of keys) {
    const sqliteValue = Number(sqliteCounts?.[key] || 0);
    const storeValue = Number(storeCounts?.[key] || 0);
    const backupValue = Number(backupCounts?.[key] || 0);
    if (sqliteValue !== storeValue) {
      warnings.push(`SQLite has ${sqliteValue} ${key} but store.json has ${storeValue} ${key}.`);
    }
    if (sqliteValue !== backupValue) {
      warnings.push(`SQLite has ${sqliteValue} ${key} but store.last-good.json has ${backupValue} ${key}.`);
    }
  }
  if (Number(sqliteCounts?.assignments || 0) === 0
    && Number(sqliteCounts?.sessions || 0) > 0
    && Number(sqliteCounts?.invigilators || 0) > 0) {
    warnings.push('Assignments are empty while sessions and invigilators exist. This may indicate unscheduled state or previous data loss.');
  }
  return warnings;
}

async function getSqliteExtendedCounts() {
  await initDb();
  const queries = {
    sessions: 'SELECT COUNT(*) AS value FROM sessions',
    sessionNeeds: 'SELECT COUNT(*) AS value FROM sessions WHERE COALESCE(ta_needed, 0) > 0 OR COALESCE(doctor_needed, 0) > 0 OR COALESCE(total_needed, 0) > 0',
    invigilators: 'SELECT COUNT(*) AS value FROM invigilators',
    engagements: 'SELECT COUNT(*) AS value FROM engagements',
    assignments: 'SELECT COUNT(*) AS value FROM assignments',
    superAssignments: 'SELECT COUNT(*) AS value FROM super_assignments',
    controlSessions: 'SELECT COUNT(*) AS value FROM control_sessions',
    controlAssignments: 'SELECT COUNT(*) AS value FROM control_assignments',
    onCallAssignments: 'SELECT COUNT(*) AS value FROM on_call_assignments',
    staffHourPolicies: 'SELECT COUNT(*) AS value FROM staff_hour_policies',
    courseRoomCourses: 'SELECT COUNT(*) AS value FROM course_room_courses',
    courseRoomAvailability: 'SELECT COUNT(*) AS value FROM course_room_availability',
    courseRoomCapacity: 'SELECT COUNT(*) AS value FROM course_room_capacity',
    courseRoomResults: 'SELECT COUNT(*) AS value FROM course_room_results',
    courseRoomResultRooms: 'SELECT COUNT(*) AS value FROM course_room_result_rooms',
    courseRoomValidationErrors: 'SELECT COUNT(*) AS value FROM course_room_validation_errors',
    courseRoomMeta: 'SELECT COUNT(*) AS value FROM course_room_meta',
  };

  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, sql]) => {
      const rows = await all(sql);
      return [key, Number(rows[0]?.value || 0)];
    })
  );
  return Object.fromEntries(entries);
}

async function getStorageStatus() {
  ensureStore();
  const storeJsonStatus = inspectJsonStoreFile(storePath);
  const lastGoodStatus = inspectJsonStoreFile(storeBackupPath);
  const enrichMirrorCounts = (counts) => ({
    ...summarizeEmptyCounts(),
    ...(counts || {}),
    courseRoomCourses: null,
    courseRoomAvailability: null,
    courseRoomCapacity: null,
    courseRoomResults: null,
    courseRoomResultRooms: null,
    courseRoomValidationErrors: null,
    courseRoomMeta: null,
    onCallNeeds: buildOnCallNeeds(readStore()).length,
    onCallAssignments: Number(counts?.onCallAssignments || 0),
    staffHourPolicies: Number(counts?.staffHourPolicies || 0),
    auditLogs: null,
  });

  let sqliteCounts = {
    ...summarizeEmptyCounts(),
    courseRoomCourses: 0,
    courseRoomAvailability: 0,
    courseRoomCapacity: 0,
    courseRoomResults: 0,
    courseRoomResultRooms: 0,
    courseRoomValidationErrors: 0,
    courseRoomMeta: 0,
    onCallNeeds: buildOnCallNeeds(readStore()).length,
    onCallAssignments: 0,
    staffHourPolicies: 0,
    auditLogs: null,
  };
  let sqliteReadSuccess = false;
  let sqliteError = null;

  try {
    sqliteCounts = {
      ...sqliteCounts,
      ...(await getSqliteExtendedCounts()),
    };
    sqliteReadSuccess = true;
  } catch (error) {
    sqliteError = error.message;
  }

  const warnings = [
    ...startupStorageInfo.warnings,
    ...buildMismatchWarnings(sqliteCounts, enrichMirrorCounts(storeJsonStatus.counts), enrichMirrorCounts(lastGoodStatus.counts)),
  ];
  if (!sqliteReadSuccess) {
    warnings.push(`SQLite read failed: ${sqliteError}`);
  }
  if (!storeJsonStatus.readSuccess && storeJsonStatus.error) {
    warnings.push(`store.json read failed: ${storeJsonStatus.error}`);
  }
  if (!lastGoodStatus.readSuccess && lastGoodStatus.error) {
    warnings.push(`store.last-good.json read failed: ${lastGoodStatus.error}`);
  }

  let health = 'ok';
  if (!sqliteReadSuccess && !storeJsonStatus.readSuccess && !lastGoodStatus.readSuccess) {
    health = 'error';
  } else if (warnings.length > 0) {
    health = 'warning';
  }

  return {
    health,
    startup: {
      startupSource: startupStorageInfo.startupSource || 'unknown',
      startupTimestamp: startupStorageInfo.startupTimestamp,
      sqlitePromotedFromJson: Boolean(startupStorageInfo.sqlitePromotedFromJson),
      jsonMirrorsRebuiltFromSqlite: Boolean(startupStorageInfo.jsonMirrorsRebuiltFromSqlite),
      corruptedSources: startupStorageInfo.corruptedSources || [],
      selectedCounts: startupStorageInfo.selectedCounts || summarizeEmptyCounts(),
    },
    sqlite: {
      exists: fs.existsSync(dbPath),
      path: dbPath,
      readSuccess: sqliteReadSuccess,
      error: sqliteError,
      counts: sqliteCounts,
    },
    storeJson: {
      exists: storeJsonStatus.exists,
      path: storePath,
      readSuccess: storeJsonStatus.readSuccess,
      error: storeJsonStatus.error,
      counts: enrichMirrorCounts(storeJsonStatus.counts),
    },
    storeLastGoodJson: {
      exists: lastGoodStatus.exists,
      path: storeBackupPath,
      readSuccess: lastGoodStatus.readSuccess,
      error: lastGoodStatus.error,
      counts: enrichMirrorCounts(lastGoodStatus.counts),
    },
    warnings: Array.from(new Set(warnings)),
  };
}

function getStartupStorageInfo() {
  return {
    ...startupStorageInfo,
    corruptedSources: Array.isArray(startupStorageInfo.corruptedSources) ? [...startupStorageInfo.corruptedSources] : [],
    selectedCounts: { ...(startupStorageInfo.selectedCounts || summarizeEmptyCounts()) },
    warnings: Array.isArray(startupStorageInfo.warnings) ? [...startupStorageInfo.warnings] : [],
  };
}

function getSessionRoomStartKey(session) {
  return [
    String(session.date || session.exam_date || '').trim(),
    String(session.startTime || session.start_time || '').trim(),
    String(session.room || '').trim().toLowerCase()
  ].join('|');
}

function getSessionRoomStartCourseKey(session) {
  const courses = normalizeCourseList(session)
    .map((item) => item.toLowerCase())
    .sort()
    .join(';');
  return `${getSessionRoomStartKey(session)}|${courses}`;
}

function getSessionRoomTimeKey(session) {
  return `${getSessionRoomStartKey(session)}|${String(session.endTime || session.end_time || '').trim()}`;
}

function normalizeCourseList(session) {
  if (Array.isArray(session.courseNames)) {
    return session.courseNames.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(session.courseName || session.course_name || '')
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStoreSessions(store) {
  if (!Array.isArray(store.sessions) || store.sessions.length < 2) {
    return {
      ...store,
      assignments: (Array.isArray(store.assignments) ? store.assignments : []).map((assignment) =>
        normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true })
      ),
    };
  }

  const hasLegacySampleDateBug = store.sessions.some((session) => {
    const match = String(session.date || '').match(/^(\d{4})-(\d{2})-06$/);
    return match && Number(match[2]) > 12;
  });

  const groups = new Map();
  const sessionIdRemap = new Map();

  store.sessions.forEach((session) => {
    const normalizedSession = hasLegacySampleDateBug ? repairLegacySampleDate(session) : session;
    const key = getSessionRoomStartKey(normalizedSession);
    if (!key.replace(/\|/g, '').trim()) {
      groups.set(`${key}|${normalizedSession.id}`, { ...normalizedSession });
      return;
    }

    if (!groups.has(key)) {
      groups.set(key, {
        ...normalizedSession,
        courseNames: [],
        courseName: '',
        taNeeded: Number(normalizedSession.taNeeded ?? normalizedSession.ta_needed ?? 0),
        doctorNeeded: Number(normalizedSession.doctorNeeded ?? normalizedSession.doctor_needed ?? 0),
        totalNeeded: Number(normalizedSession.totalNeeded ?? normalizedSession.total_needed ?? 0)
      });
    }

    const merged = groups.get(key);
    sessionIdRemap.set(String(normalizedSession.id), merged.id);
    const existingCourses = new Set(merged.courseNames.map((item) => item.toLowerCase()));
    normalizeCourseList(normalizedSession).forEach((course) => {
      const normalized = course.toLowerCase();
      if (!existingCourses.has(normalized)) {
        merged.courseNames.push(course);
        existingCourses.add(normalized);
      }
    });

    merged.courseName = merged.courseNames.join('; ');
    if (parseTimeToMinutes(normalizedSession.endTime || normalizedSession.end_time || '') > parseTimeToMinutes(merged.endTime || merged.end_time || '')) {
      merged.endTime = normalizedSession.endTime || normalizedSession.end_time || merged.endTime;
    }
    merged.taNeeded = Math.max(Number(merged.taNeeded || 0), Number(normalizedSession.taNeeded ?? normalizedSession.ta_needed ?? 0));
    merged.doctorNeeded = Math.max(Number(merged.doctorNeeded || 0), Number(normalizedSession.doctorNeeded ?? normalizedSession.doctor_needed ?? 0));
    merged.totalNeeded = Math.max(
      Number(merged.totalNeeded || 0),
      Number(normalizedSession.totalNeeded ?? normalizedSession.total_needed ?? ((normalizedSession.taNeeded || 0) + (normalizedSession.doctorNeeded || 0)))
    );
    if (!merged.notes && normalizedSession.notes) {
      merged.notes = normalizedSession.notes;
    }
  });

  const seenAssignments = new Set();
  const assignments = (Array.isArray(store.assignments) ? store.assignments : [])
    .map((assignment) => normalizeAssignmentMetadata({
      ...assignment,
      sessionId: sessionIdRemap.get(String(assignment.sessionId)) || assignment.sessionId
    }, { sourceFallback: 'legacy', lockedFallback: true }))
    .filter((assignment) => {
      const key = `${assignment.sessionId}|${assignment.invigilatorId}|${assignment.role || ''}`;
      if (seenAssignments.has(key)) return false;
      seenAssignments.add(key);
      return true;
    });

  return {
    ...store,
    sessions: Array.from(groups.values()),
    assignments
  };
}

function repairLegacySampleDate(session) {
  const match = String(session.date || '').match(/^(\d{4})-(\d{2})-06$/);
  if (!match) return session;
  const [, year, misplacedDay] = match;
  const day = Number(misplacedDay);
  if (day < 1 || day > 31) return session;
  return {
    ...session,
    date: `${year}-06-${String(day).padStart(2, '0')}`
  };
}

async function syncStoreToDb(store) {
  await initDb();
  await writeDb((db) => {
    db.run('DELETE FROM staff_hour_policies');
    db.run('DELETE FROM on_call_config');
    db.run('DELETE FROM scheduling_config');
    db.run('INSERT INTO scheduling_config (config_key, config_value) VALUES (?, ?)', ['default', JSON.stringify(normalizeSchedulingConfig(store.schedulingConfig))]);
    db.run('DELETE FROM on_call_assignments');
    db.run('DELETE FROM assignments');
    db.run('DELETE FROM super_assignments');
    db.run('DELETE FROM control_assignments');
    db.run('DELETE FROM control_sessions');
    db.run('DELETE FROM engagements');
    db.run('DELETE FROM sessions');
    db.run('DELETE FROM invigilators');

    const sessionDbIdByAppId = new Map();
    const sessionStmt = db.prepare(`
      INSERT INTO sessions (id, course_name, room, exam_date, start_time, end_time, duration_hours, ta_needed, doctor_needed, total_needed, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    store.sessions.forEach((session, index) => {
      const dbId = index + 1;
      sessionDbIdByAppId.set(String(session.id), dbId);
      const taNeeded = Number(session.taNeeded ?? session.ta_needed ?? 0);
      const doctorNeeded = Number(session.doctorNeeded ?? session.doctor_needed ?? 0);
      const totalNeeded = Number(session.totalNeeded ?? session.total_needed ?? 0);
      sessionStmt.run([
        dbId,
        getCourseLabel(session, ''),
        String(session.room || ''),
        String(session.date || session.exam_date || ''),
        String(session.startTime || session.start_time || ''),
        String(session.endTime || session.end_time || ''),
        Number(session.durationHours || session.duration_hours || 0),
        taNeeded,
        doctorNeeded,
        totalNeeded,
        String(session.notes || '')
      ]);
    });
    sessionStmt.free();

    const invigilatorStmt = db.prepare(`
      INSERT INTO invigilators (staff_id, name, email, role, load_type, max_hours, department, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const invigilator of store.invigilators) {
      invigilatorStmt.run([
        String(invigilator.staffId || invigilator.staff_id || invigilator.id || ''),
        String(invigilator.name || ''),
        String(invigilator.email || ''),
        String(invigilator.role || 'TA'),
        String(invigilator.loadType || invigilator.load_type || 'full'),
        Number(invigilator.maxHours || invigilator.max_hours || 0),
        String(invigilator.department || ''),
        String(invigilator.notes || '')
      ]);
    }
    invigilatorStmt.free();

    const engagementStmt = db.prepare(`
      INSERT INTO engagements (staff_id, exam_date, start_time, end_time, engagement, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const engagement of store.engagements) {
      engagementStmt.run([
        String(engagement.staffId || engagement.staff_id || ''),
        String(engagement.date || engagement.exam_date || ''),
        String(engagement.startTime || engagement.start_time || ''),
        String(engagement.endTime || engagement.end_time || ''),
        Number(engagement.engagement ?? 1),
        String(engagement.notes || '')
      ]);
    }
    engagementStmt.free();

    const invigilatorById = new Map(
      store.invigilators.map((item) => [String(item.id || ''), String(item.staffId || item.staff_id || item.id || '')])
    );

    const assignmentStmt = db.prepare(`
      INSERT INTO assignments (session_id, staff_id, role, assignment_source, locked, created_at, updated_at, notes, engagement_override_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const assignment of store.assignments) {
      const sessionDbId = sessionDbIdByAppId.get(String(assignment.sessionId || assignment.session_id || ''));
      if (!sessionDbId) continue;
      const normalizedAssignment = normalizeAssignmentMetadata(assignment, { sourceFallback: 'legacy', lockedFallback: true });
      assignmentStmt.run([
        sessionDbId,
        String(
          normalizedAssignment.staffId
          || normalizedAssignment.staff_id
          || invigilatorById.get(String(normalizedAssignment.invigilatorId || ''))
          || normalizedAssignment.invigilatorId
          || ''
        ),
        String(normalizedAssignment.role || ''),
        String(normalizedAssignment.assignmentSource || 'legacy'),
        normalizedAssignment.locked ? 1 : 0,
        String(normalizedAssignment.createdAt || ''),
        String(normalizedAssignment.updatedAt || ''),
        String(normalizedAssignment.notes || ''),
        String(normalizedAssignment.engagementOverrideReason || '')
      ]);
    }
    assignmentStmt.free();

    const superStmt = db.prepare(`
      INSERT INTO super_assignments (exam_date, staff_id)
      VALUES (?, ?)
    `);
    for (const row of store.superAssignments) {
      superStmt.run([
        String(row.date || row.exam_date || ''),
        String(
          row.staffId
          || row.staff_id
          || invigilatorById.get(String(row.invigilatorId || ''))
          || row.invigilatorId
          || ''
        )
      ]);
    }
    superStmt.free();

    const controlSessionDbIdByAppId = new Map();
    const controlSessionStmt = db.prepare(`
      INSERT INTO control_sessions (id, course_name, room, exam_date, start_time, end_time, ta_needed, doctor_needed, total_needed, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    store.controlSessions.forEach((session, index) => {
      const dbId = index + 1;
      controlSessionDbIdByAppId.set(String(session.id), dbId);
      controlSessionStmt.run([
        dbId,
        getCourseLabel(session, ''),
        String(session.room || ''),
        String(session.date || session.exam_date || ''),
        String(session.startTime || session.start_time || ''),
        String(session.endTime || session.end_time || ''),
        Number(session.taNeeded || session.ta_needed || 0),
        Number(session.doctorNeeded || session.doctor_needed || 0),
        Number(session.totalNeeded || session.total_needed || 0),
        String(session.notes || '')
      ]);
    });
    controlSessionStmt.free();

    const controlStmt = db.prepare(`
      INSERT INTO control_assignments (control_session_id, staff_id, role)
      VALUES (?, ?, ?)
    `);
    for (const row of store.controlAssignments) {
      const controlSessionDbId = controlSessionDbIdByAppId.get(String(row.controlSessionId || row.control_session_id || ''));
      if (!controlSessionDbId) continue;
      controlStmt.run([
        controlSessionDbId,
        String(
          row.staffId
          || row.staff_id
          || invigilatorById.get(String(row.invigilatorId || ''))
          || row.invigilatorId
          || ''
        ),
        String(row.role || '')
      ]);
    }
    controlStmt.free();

    const onCallStmt = db.prepare(`
      INSERT INTO on_call_assignments (exam_date, start_time, end_time, staff_id, role, engagement_override_reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of store.onCallAssignments || []) {
      onCallStmt.run([
        String(row.date || row.exam_date || ''),
        String(row.startTime || row.start_time || ''),
        String(row.endTime || row.end_time || ''),
        String(
          row.staffId
          || row.staff_id
          || invigilatorById.get(String(row.invigilatorId || ''))
          || row.invigilatorId
          || ''
        ),
        String(row.role || 'TA'),
        String(row.engagementOverrideReason || '')
      ]);
    }
    onCallStmt.free();

    const onCallConfigStmt = db.prepare(`
      INSERT INTO on_call_config (config_key, config_value)
      VALUES (?, ?)
    `);
    onCallConfigStmt.run([
      'default',
      JSON.stringify(normalizeOnCallConfig(store.onCallConfig || {})),
    ]);
    onCallConfigStmt.free();

    const policyStmt = db.prepare(`
      INSERT INTO staff_hour_policies (staff_id, role, mode, hours_value, exclude_from_auto_schedule, prefer_consecutive_duties, prefer_consecutive_days, allow_engagement_override, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of store.staffHourPolicies || []) {
      policyStmt.run([
        String(
          row.staffId
          || row.staff_id
          || invigilatorById.get(String(row.invigilatorId || ''))
          || row.invigilatorId
          || ''
        ),
        String(row.role || 'TA'),
        String(row.mode || 'default'),
        Number(row.hoursValue || row.hours_value || 0),
        row.excludeFromAutoSchedule ? 1 : 0,
        row.preferConsecutiveDuties ? 1 : 0,
        row.preferConsecutiveDays ? 1 : 0,
        row.allowEngagementOverride === false ? 0 : 1,
        String(row.notes || ''),
      ]);
    }
    policyStmt.free();
  });
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTimeToMinutes(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return 0;
  }
  if (raw.includes(':')) {
    const [hours, minutes] = raw.split(':').map(Number);
    return (hours * 60) + minutes;
  }
  const numeric = Number(raw);
  const hours = Math.floor(numeric / 100);
  const minutes = numeric % 100;
  return (hours * 60) + minutes;
}

function getDurationMinutes(start, end) {
  return Math.max(0, parseTimeToMinutes(end) - parseTimeToMinutes(start));
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function getCourseLabel(session, fallback = 'Session') {
  if (Array.isArray(session.courseNames) && session.courseNames.length) {
    return session.courseNames.join('; ');
  }
  return String(session.courseName || session.course_name || fallback || '').trim();
}

function getDayWindows(sessions) {
  const grouped = new Map();
  for (const session of sessions) {
    if (!session.date) {
      continue;
    }
    const start = parseTimeToMinutes(session.startTime);
    const end = parseTimeToMinutes(session.endTime);
    if (!grouped.has(session.date)) {
      grouped.set(session.date, { date: session.date, start, end });
      continue;
    }
    const current = grouped.get(session.date);
    current.start = Math.min(current.start, start);
    current.end = Math.max(current.end, end);
  }

  return Array.from(grouped.values())
    .map((item) => ({
      date: item.date,
      startTime: minutesToTime(item.start),
      endTime: minutesToTime(item.end),
      durationMinutes: Math.max(0, item.end - item.start)
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function buildOnCallPeriodKey(value) {
  return [
    String(value.date || value.exam_date || '').trim(),
    String(value.startTime || value.start_time || '').trim(),
    String(value.endTime || value.end_time || '').trim(),
  ].join('|');
}

function computeOnCallRoleNeed(activeRoomCount, config, role) {
  const normalizedConfig = normalizeOnCallConfig(config);
  if (normalizedConfig.mode === 'fixed_per_period') {
    return role === 'Doctor'
      ? Number(normalizedConfig.fixedDoctorsPerPeriod || 0)
      : Number(normalizedConfig.fixedTAsPerPeriod || 0);
  }

  const roomsPerStep = role === 'Doctor'
    ? Number(normalizedConfig.doctorRoomsPerStep || 6)
    : Number(normalizedConfig.taRoomsPerStep || 3);
  const staffPerStep = role === 'Doctor'
    ? Number(normalizedConfig.doctorStaffPerStep || 1)
    : Number(normalizedConfig.taStaffPerStep || 1);
  const belowThresholdMode = role === 'Doctor'
    ? normalizedConfig.doctorBelowThresholdMode
    : normalizedConfig.taBelowThresholdMode;

  if (activeRoomCount <= 0) return 0;
  if (activeRoomCount < roomsPerStep) {
    return belowThresholdMode === 'zero' ? 0 : staffPerStep;
  }
  return Math.ceil(activeRoomCount / roomsPerStep) * staffPerStep;
}

function buildOnCallNeedsUncached(store) {
  const onCallConfig = normalizeOnCallConfig(store.onCallConfig || {});
  const grouped = new Map();
  for (const session of Array.isArray(store.sessions) ? store.sessions : []) {
    const date = String(session.date || session.exam_date || '').trim();
    const startTime = String(session.startTime || session.start_time || '').trim();
    const endTime = String(session.endTime || session.end_time || '').trim();
    const room = String(session.room || '').trim();
    if (!date || !startTime || !endTime || !room) continue;
    const key = buildOnCallPeriodKey({ date, startTime, endTime });
    if (!grouped.has(key)) {
      grouped.set(key, {
        periodKey: key,
        date,
        startTime,
        endTime,
        durationMinutes: getDurationMinutes(startTime, endTime),
        roomKeys: new Set(),
        rooms: [],
      });
    }
    const period = grouped.get(key);
    const normalizedRoomKey = room.toLowerCase();
    if (!period.roomKeys.has(normalizedRoomKey)) {
      period.roomKeys.add(normalizedRoomKey);
      period.rooms.push(room);
    }
  }

  return Array.from(grouped.values())
    .map((period) => {
      const activeRoomCount = period.rooms.length;
      return {
        periodKey: period.periodKey,
        date: period.date,
        startTime: period.startTime,
        endTime: period.endTime,
        durationMinutes: period.durationMinutes,
        activeRoomCount,
        onCallTANeeded: computeOnCallRoleNeed(activeRoomCount, onCallConfig, 'TA'),
        onCallDoctorNeeded: computeOnCallRoleNeed(activeRoomCount, onCallConfig, 'Doctor'),
        configMode: onCallConfig.mode,
        rooms: [...period.rooms].sort((a, b) => a.localeCompare(b)),
      };
    })
    .sort((a, b) => `${a.date} ${a.startTime} ${a.endTime}`.localeCompare(`${b.date} ${b.startTime} ${b.endTime}`));
}

function buildOnCallNeeds(store) {
  return getCachedDerivedView('onCallNeedsCore', () => buildOnCallNeedsUncached(store), 'default', store);
}

function rangesOverlap(startA, endA, startB, endB) {
  return parseTimeToMinutes(startA) < parseTimeToMinutes(endB)
    && parseTimeToMinutes(startB) < parseTimeToMinutes(endA);
}

function getAssignedMinutesByInvigilator(store) {
  const totals = new Map();
  const { sessionDuties, superDuties, controlDuties, onCallDuties } = buildDutyCollections(store);

  [...sessionDuties, ...superDuties, ...controlDuties, ...onCallDuties].forEach((duty) => {
    totals.set(duty.invigilatorId, (totals.get(duty.invigilatorId) || 0) + Number(duty.durationMinutes || 0));
  });

  return totals;
}

function pushToMapArray(map, key, value) {
  const current = map.get(key) || [];
  current.push(value);
  map.set(key, current);
}

const STAFF_HOUR_POLICY_MODES = new Set(['default', 'exact', 'add', 'reduce', 'exclude']);

function normalizeStaffHourPolicyRow(row, invigilatorMap = new Map()) {
  const invigilatorId = row.invigilatorId || invigilatorMap.get(String(row.staffId || row.staff_id || '').trim());
  const staffId = String(row.staffId || row.staff_id || '').trim();
  const role = String(row.role || 'TA').trim() || 'TA';
  const mode = String(row.mode || 'default').trim().toLowerCase() || 'default';
  return {
    id: row.id || generateId('hourpol'),
    invigilatorId,
    staffId,
    role,
    mode: STAFF_HOUR_POLICY_MODES.has(mode) ? mode : 'default',
    hoursValue: Math.max(0, Number(row.hoursValue ?? row.hours_value ?? 0) || 0),
    excludeFromAutoSchedule: Boolean(row.excludeFromAutoSchedule),
    preferConsecutiveDuties: ['true', '1', 'yes', 'y'].includes(String(row.preferConsecutiveDuties ?? row.prefer_consecutive_duties ?? false).trim().toLowerCase()),
    preferConsecutiveDays: ['true', '1', 'yes', 'y'].includes(String(row.preferConsecutiveDays ?? row.prefer_consecutive_days ?? false).trim().toLowerCase()),
    allowEngagementOverride: ['true', '1', 'yes', 'y'].includes(String(row.allowEngagementOverride ?? row.allow_engagement_override ?? true).trim().toLowerCase()),
    notes: String(row.notes || '').trim(),
  };
}

function buildStaffHourPolicySummary(store) {
  return getCachedDerivedView('staffHourPolicySummaryCore', () => {
    const invigilatorMap = new Map((store.invigilators || []).map((item) => [item.id, item]));
    const policyByInvigilatorId = new Map();
    const policyByStaffId = new Map();

    (store.staffHourPolicies || []).forEach((raw) => {
      const normalized = normalizeStaffHourPolicyRow(raw, new Map());
      if (normalized.invigilatorId) {
        policyByInvigilatorId.set(normalized.invigilatorId, normalized);
      }
      if (normalized.staffId) {
        policyByStaffId.set(normalized.staffId, normalized);
      }
    });

    const totalRequiredMinutesByRole = { TA: 0, Doctor: 0 };
    const onCallRequiredMinutesByRole = { TA: 0, Doctor: 0 };
    (store.sessions || []).forEach((session) => {
      const durationMinutes = getDurationMinutes(session.startTime, session.endTime);
      totalRequiredMinutesByRole.TA += Number(session.taNeeded || 0) * durationMinutes;
      totalRequiredMinutesByRole.Doctor += Number(session.doctorNeeded || 0) * durationMinutes;
    });
    (store.controlSessions || []).forEach((session) => {
      const durationMinutes = getDurationMinutes(session.startTime, session.endTime);
      totalRequiredMinutesByRole.TA += Number(session.taNeeded || 0) * durationMinutes;
      totalRequiredMinutesByRole.Doctor += Number(session.doctorNeeded || 0) * durationMinutes;
    });
    buildOnCallNeeds(store).forEach((need) => {
      const durationMinutes = Number(need.durationMinutes || getDurationMinutes(need.startTime, need.endTime));
      onCallRequiredMinutesByRole.TA += Number(need.onCallTANeeded || 0) * durationMinutes;
      onCallRequiredMinutesByRole.Doctor += Number(need.onCallDoctorNeeded || 0) * durationMinutes;
    });
    totalRequiredMinutesByRole.TA += onCallRequiredMinutesByRole.TA;
    totalRequiredMinutesByRole.Doctor += onCallRequiredMinutesByRole.Doctor;

    const availableStaffByRole = { TA: [], Doctor: [] };
    (store.invigilators || []).forEach((person) => {
      const policy = policyByInvigilatorId.get(person.id) || policyByStaffId.get(String(person.staffId || '')) || null;
      const excluded = policy?.mode === 'exclude' || policy?.excludeFromAutoSchedule;
      if (!excluded) {
        (availableStaffByRole[person.role] || availableStaffByRole.TA).push(person);
      }
    });

    const rawAverageMinutesByRole = {
      TA: availableStaffByRole.TA.length ? Math.round(totalRequiredMinutesByRole.TA / availableStaffByRole.TA.length) : 0,
      Doctor: availableStaffByRole.Doctor.length ? Math.round(totalRequiredMinutesByRole.Doctor / availableStaffByRole.Doctor.length) : 0,
    };

    const effectivePolicyByInvigilatorId = new Map();
    const effectivePolicyRows = [];
    (store.invigilators || []).forEach((person) => {
      const role = person.role === 'Doctor' ? 'Doctor' : 'TA';
      const rawAverageMinutes = rawAverageMinutesByRole[role] || 0;
      const policy = policyByInvigilatorId.get(person.id) || policyByStaffId.get(String(person.staffId || '')) || null;
      const mode = policy?.mode || 'default';
      const hoursValue = Math.max(0, Number(policy?.hoursValue || 0));
      const valueMinutes = Math.round(hoursValue * 60);
      let allowedMinutes = rawAverageMinutes;
      let excluded = false;

      if (mode === 'exact') {
        allowedMinutes = valueMinutes;
      } else if (mode === 'add') {
        allowedMinutes = rawAverageMinutes + valueMinutes;
      } else if (mode === 'reduce') {
        allowedMinutes = Math.max(0, rawAverageMinutes - valueMinutes);
      } else if (mode === 'exclude') {
        excluded = true;
        allowedMinutes = 0;
      }
      if (policy?.excludeFromAutoSchedule) {
        excluded = true;
        allowedMinutes = 0;
      }

      const maxMinutes = Number(person.maxHours || 0) > 0 ? Math.round(Number(person.maxHours || 0) * 60) : 0;
      const hasPolicyLimit = ['exact', 'add', 'reduce'].includes(mode);
      const hasHardLimit = excluded || hasPolicyLimit || maxMinutes > 0;
      const hardLimitMinutes = excluded
        ? 0
        : (hasPolicyLimit ? (maxMinutes > 0 ? Math.min(maxMinutes, allowedMinutes) : allowedMinutes) : maxMinutes);

      const effective = {
        invigilatorId: person.id,
        staffId: String(person.staffId || ''),
        role,
        mode,
        hoursValue,
        rawAverageMinutes,
        rawAverageHours: Math.round((rawAverageMinutes / 60) * 100) / 100,
        allowedMinutes,
        allowedHours: Math.round((allowedMinutes / 60) * 100) / 100,
        hardLimitMinutes,
        hardLimitHours: Math.round((hardLimitMinutes / 60) * 100) / 100,
        hasHardLimit,
        hasPolicyLimit,
        excluded,
        notes: policy?.notes || '',
        hasCustomPolicy: Boolean(policy),
        excludeFromAutoSchedule: excluded,
        preferConsecutiveDuties: Boolean(policy?.preferConsecutiveDuties),
        preferConsecutiveDays: Boolean(policy?.preferConsecutiveDays),
        allowEngagementOverride: policy?.allowEngagementOverride ?? true,
      };
      effectivePolicyByInvigilatorId.set(person.id, effective);
      effectivePolicyRows.push(effective);
    });

    return {
      rawAverageMinutesByRole,
      rawAverageHoursByRole: {
        TA: Math.round((rawAverageMinutesByRole.TA / 60) * 100) / 100,
        Doctor: Math.round((rawAverageMinutesByRole.Doctor / 60) * 100) / 100,
      },
      totalRequiredMinutesByRole,
      onCallRequiredHoursByRole: {
        TA: Math.round((onCallRequiredMinutesByRole.TA / 60) * 100) / 100,
        Doctor: Math.round((onCallRequiredMinutesByRole.Doctor / 60) * 100) / 100,
      },
      totalRequiredHoursByRole: {
        TA: Math.round((totalRequiredMinutesByRole.TA / 60) * 100) / 100,
        Doctor: Math.round((totalRequiredMinutesByRole.Doctor / 60) * 100) / 100,
      },
      availableStaffCountByRole: {
        TA: availableStaffByRole.TA.length,
        Doctor: availableStaffByRole.Doctor.length,
      },
      effectivePolicyByInvigilatorId,
      effectivePolicyRows,
    };
  }, 'default', store);
}

function getStaffHourPolicyCheck(person, currentMinutes, additionalMinutes, context) {
  const summary = context?.staffHourPolicySummary || buildStaffHourPolicySummary(context?.store || { invigilators: [person], sessions: [], staffHourPolicies: [] });
  const effective = summary.effectivePolicyByInvigilatorId.get(person.id) || {
    mode: 'default',
    excluded: false,
    allowedMinutes: 0,
    hardLimitMinutes: 0,
    rawAverageMinutes: 0,
  };
  const projectedMinutes = Number(currentMinutes || 0) + Number(additionalMinutes || 0);
  if (effective.excluded) {
    return {
      blocked: true,
      reason: 'policy_excluded',
      currentMinutes,
      projectedMinutes,
      allowedMinutes: effective.allowedMinutes,
      hardLimitMinutes: effective.hardLimitMinutes,
      policyMode: effective.mode,
      effective,
    };
  }

  const hardLimitMinutes = Number(effective.hardLimitMinutes || 0);
  if (effective.hasHardLimit && projectedMinutes > hardLimitMinutes) {
    return {
      blocked: true,
      reason: 'policy_limit',
      currentMinutes,
      projectedMinutes,
      allowedMinutes: effective.allowedMinutes,
      hardLimitMinutes,
      policyMode: effective.mode,
      effective,
    };
  }

  return {
    blocked: false,
    currentMinutes,
    projectedMinutes,
    allowedMinutes: effective.allowedMinutes,
    hardLimitMinutes,
    policyMode: effective.mode,
    effective,
  };
}

function buildSchedulingIndexes(store) {
  const sessionById = new Map(store.sessions.map((item) => [item.id, item]));
  const controlSessionById = new Map(store.controlSessions.map((item) => [item.id, item]));
  const invigilatorById = new Map(store.invigilators.map((item) => [item.id, item]));
  const invigilatorsByRole = { TA: [], Doctor: [] };
  const assignmentsBySessionId = new Map();
  const assignmentsByInvigilatorId = new Map();
  const engagementsByStaffDate = new Map();
  const superAssignmentsByInvigilatorDate = new Map();
  const controlSessionsByInvigilatorDate = new Map();
  const onCallAssignmentsByInvigilatorDate = new Map();
  const onCallAssignmentsByPeriodKey = new Map();
  const onCallNeeds = buildOnCallNeeds(store);
  const staffHourPolicySummary = buildStaffHourPolicySummary(store);
  const onCallNeedByPeriodKey = new Map(onCallNeeds.map((item) => [item.periodKey, item]));
  const dayWindows = getDayWindows(store.sessions);
  const dayWindowByDate = new Map(dayWindows.map((item) => [item.date, item]));
  const sessionDurationById = new Map(store.sessions.map((item) => [item.id, getDurationMinutes(item.startTime, item.endTime)]));
  const assignedMinutesByInvigilator = new Map();

  store.invigilators.forEach((person) => {
    if (person.role === 'Doctor') {
      invigilatorsByRole.Doctor.push(person);
    } else {
      invigilatorsByRole.TA.push(person);
    }
  });

  store.assignments.forEach((assignment) => {
    pushToMapArray(assignmentsBySessionId, assignment.sessionId, assignment);
    pushToMapArray(assignmentsByInvigilatorId, assignment.invigilatorId, assignment);
    assignedMinutesByInvigilator.set(
      assignment.invigilatorId,
      (assignedMinutesByInvigilator.get(assignment.invigilatorId) || 0) + Number(sessionDurationById.get(assignment.sessionId) || 0)
    );
  });

  store.engagements.forEach((engagement) => {
    pushToMapArray(engagementsByStaffDate, `${engagement.staffId}|${engagement.date}`, engagement);
  });

  store.superAssignments.forEach((assignment) => {
    pushToMapArray(superAssignmentsByInvigilatorDate, `${assignment.invigilatorId}|${assignment.date}`, assignment);
    const durationMinutes = Number(dayWindowByDate.get(assignment.date)?.durationMinutes || 0);
    assignedMinutesByInvigilator.set(
      assignment.invigilatorId,
      (assignedMinutesByInvigilator.get(assignment.invigilatorId) || 0) + durationMinutes
    );
  });

  store.controlAssignments.forEach((assignment) => {
    const controlSession = controlSessionById.get(assignment.controlSessionId);
    if (controlSession) {
      pushToMapArray(controlSessionsByInvigilatorDate, `${assignment.invigilatorId}|${controlSession.date}`, controlSession);
      assignedMinutesByInvigilator.set(
        assignment.invigilatorId,
        (assignedMinutesByInvigilator.get(assignment.invigilatorId) || 0) + getDurationMinutes(controlSession.startTime, controlSession.endTime)
      );
    }
  });

  store.onCallAssignments.forEach((assignment) => {
    pushToMapArray(onCallAssignmentsByInvigilatorDate, `${assignment.invigilatorId}|${assignment.date}`, assignment);
    pushToMapArray(onCallAssignmentsByPeriodKey, buildOnCallPeriodKey(assignment), assignment);
    assignedMinutesByInvigilator.set(
      assignment.invigilatorId,
      (assignedMinutesByInvigilator.get(assignment.invigilatorId) || 0) + getDurationMinutes(assignment.startTime, assignment.endTime)
    );
  });

  return {
    sessionById,
    controlSessionById,
    invigilatorById,
    invigilatorsByRole,
    assignmentsBySessionId,
    assignmentsByInvigilatorId,
    engagementsByStaffDate,
    superAssignmentsByInvigilatorDate,
    controlSessionsByInvigilatorDate,
    onCallAssignmentsByInvigilatorDate,
    onCallAssignmentsByPeriodKey,
    onCallNeedByPeriodKey,
    dayWindowByDate,
    assignedMinutesByInvigilator,
    staffHourPolicySummary,
    store,
  };
}

function resolveEligibilityContext(store, contextOrMinutes) {
  if (
    contextOrMinutes
    && typeof contextOrMinutes === 'object'
    && contextOrMinutes.assignmentsBySessionId
    && contextOrMinutes.assignmentsByInvigilatorId
  ) {
    return contextOrMinutes;
  }
  return {
    ...buildSchedulingIndexes(store),
    assignedMinutesByInvigilator: contextOrMinutes instanceof Map ? contextOrMinutes : getAssignedMinutesByInvigilator(store),
  };
}

function getEligibilityForSession(store, session, person, contextOrMinutes) {
  const context = resolveEligibilityContext(store, contextOrMinutes);
  const sessionAssignments = context.assignmentsBySessionId.get(session.id) || [];
  const alreadyAssignedToSession = sessionAssignments.some((item) => item.invigilatorId === person.id);
  if (alreadyAssignedToSession) {
    return { eligible: false, reason: 'already_assigned', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const blockedByEngagement = (context.engagementsByStaffDate.get(`${person.staffId}|${session.date}`) || []).some((item) =>
    Number(item.engagement ?? 1) === 1
    && rangesOverlap(session.startTime, session.endTime, item.startTime, item.endTime)
  );
  if (blockedByEngagement) {
    return { eligible: false, reason: 'engagement', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingAssignment = (context.assignmentsByInvigilatorId.get(person.id) || []).some((assignment) => {
    const otherSession = context.sessionById.get(assignment.sessionId);
    if (!otherSession || otherSession.id === session.id || otherSession.date !== session.date) return false;
    return rangesOverlap(session.startTime, session.endTime, otherSession.startTime, otherSession.endTime);
  });
  if (overlappingAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingSuperAssignment = (context.superAssignmentsByInvigilatorDate.get(`${person.id}|${session.date}`) || []).some((assignment) => {
    const window = context.dayWindowByDate.get(assignment.date);
    if (!window) return false;
    return rangesOverlap(session.startTime, session.endTime, window.startTime, window.endTime);
  });
  if (overlappingSuperAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingControlAssignment = (context.controlSessionsByInvigilatorDate.get(`${person.id}|${session.date}`) || []).some((controlSession) => {
    return rangesOverlap(session.startTime, session.endTime, controlSession.startTime, controlSession.endTime);
  });
  if (overlappingControlAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingOnCallAssignment = (context.onCallAssignmentsByInvigilatorDate.get(`${person.id}|${session.date}`) || []).some((assignment) =>
    rangesOverlap(session.startTime, session.endTime, assignment.startTime, assignment.endTime)
  );
  if (overlappingOnCallAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const currentMinutes = context.assignedMinutesByInvigilator.get(person.id) || 0;
  const additionalMinutes = getDurationMinutes(session.startTime, session.endTime);
  const projectedMinutes = currentMinutes + additionalMinutes;
  const maxMinutes = Number(person.maxHours || 0) * 60;
  if (maxMinutes > 0 && projectedMinutes > maxMinutes) {
    return { eligible: false, reason: 'max_hours', currentMinutes, projectedMinutes, maxMinutes };
  }

  const policyCheck = getStaffHourPolicyCheck(person, currentMinutes, additionalMinutes, context);
  if (policyCheck.blocked) {
    return {
      eligible: false,
      reason: policyCheck.reason,
      currentMinutes,
      projectedMinutes,
      maxMinutes,
      allowedMinutes: policyCheck.allowedMinutes,
      hardLimitMinutes: policyCheck.hardLimitMinutes,
      policyMode: policyCheck.policyMode,
    };
  }

  return {
    eligible: true,
    currentMinutes,
    projectedMinutes,
    maxMinutes,
    allowedMinutes: policyCheck.allowedMinutes,
    hardLimitMinutes: policyCheck.hardLimitMinutes,
    policyMode: policyCheck.policyMode,
  };
}

function getEligibilityForOnCall(store, need, person, contextOrMinutes) {
  const context = resolveEligibilityContext(store, contextOrMinutes);
  const onCallConfig = normalizeOnCallConfig(store.onCallConfig || {});
  if ((onCallConfig.excludedInvigilatorIds || []).includes(String(person.id || '').trim())) {
    return { eligible: false, reason: 'on_call_excluded', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }
  const periodKey = buildOnCallPeriodKey(need);
  const periodAssignments = context.onCallAssignmentsByPeriodKey.get(periodKey) || [];
  const alreadyAssignedToPeriod = periodAssignments.some((item) => item.invigilatorId === person.id);
  if (alreadyAssignedToPeriod) {
    return { eligible: false, reason: 'already_assigned', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const blockedByEngagement = (context.engagementsByStaffDate.get(`${person.staffId}|${need.date}`) || []).some((item) =>
    Number(item.engagement ?? 1) === 1
    && rangesOverlap(need.startTime, need.endTime, item.startTime, item.endTime)
  );
  if (blockedByEngagement) {
    return { eligible: false, reason: 'engagement', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingAssignment = (context.assignmentsByInvigilatorId.get(person.id) || []).some((assignment) => {
    const otherSession = context.sessionById.get(assignment.sessionId);
    if (!otherSession || otherSession.date !== need.date) return false;
    return rangesOverlap(need.startTime, need.endTime, otherSession.startTime, otherSession.endTime);
  });
  if (overlappingAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingSuperAssignment = (context.superAssignmentsByInvigilatorDate.get(`${person.id}|${need.date}`) || []).some((assignment) => {
    const window = context.dayWindowByDate.get(assignment.date);
    if (!window) return false;
    return rangesOverlap(need.startTime, need.endTime, window.startTime, window.endTime);
  });
  if (overlappingSuperAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingControlAssignment = (context.controlSessionsByInvigilatorDate.get(`${person.id}|${need.date}`) || []).some((controlSession) =>
    rangesOverlap(need.startTime, need.endTime, controlSession.startTime, controlSession.endTime)
  );
  if (overlappingControlAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const overlappingOnCallAssignment = (context.onCallAssignmentsByInvigilatorDate.get(`${person.id}|${need.date}`) || []).some((assignment) =>
    rangesOverlap(need.startTime, need.endTime, assignment.startTime, assignment.endTime)
  );
  if (overlappingOnCallAssignment) {
    return { eligible: false, reason: 'overlap', currentMinutes: context.assignedMinutesByInvigilator.get(person.id) || 0 };
  }

  const currentMinutes = context.assignedMinutesByInvigilator.get(person.id) || 0;
  const additionalMinutes = getDurationMinutes(need.startTime, need.endTime);
  const projectedMinutes = currentMinutes + additionalMinutes;
  const maxMinutes = Number(person.maxHours || 0) * 60;
  if (maxMinutes > 0 && projectedMinutes > maxMinutes) {
    return { eligible: false, reason: 'max_hours', currentMinutes, projectedMinutes, maxMinutes };
  }

  const policyCheck = getStaffHourPolicyCheck(person, currentMinutes, additionalMinutes, context);
  if (policyCheck.blocked) {
    return {
      eligible: false,
      reason: policyCheck.reason,
      currentMinutes,
      projectedMinutes,
      maxMinutes,
      allowedMinutes: policyCheck.allowedMinutes,
      hardLimitMinutes: policyCheck.hardLimitMinutes,
      policyMode: policyCheck.policyMode,
    };
  }

  return {
    eligible: true,
    currentMinutes,
    projectedMinutes,
    maxMinutes,
    allowedMinutes: policyCheck.allowedMinutes,
    hardLimitMinutes: policyCheck.hardLimitMinutes,
    policyMode: policyCheck.policyMode,
  };
}

function summarizeEligibility(candidates) {
  return candidates.reduce((acc, item) => {
    const reason = item.reason || 'unknown';
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});
}

function buildSchedulingViewUncached(store) {
  const context = buildSchedulingIndexes(store);
  const sessions = store.sessions.map((session) => {
    const assignments = context.assignmentsBySessionId.get(session.id) || [];
    const taAssignments = assignments
      .filter((item) => item.role === 'TA')
      .map((item) => ({ ...item, invigilator: context.invigilatorById.get(item.invigilatorId) }));
    const doctorAssignments = assignments
      .filter((item) => item.role === 'Doctor')
      .map((item) => ({ ...item, invigilator: context.invigilatorById.get(item.invigilatorId) }));

    const eligibleTACount = context.invigilatorsByRole.TA.reduce((count, person) => (
      getEligibilityForSession(store, session, person, context).eligible ? count + 1 : count
    ), 0);
    const eligibleDoctorCount = context.invigilatorsByRole.Doctor.reduce((count, person) => (
      getEligibilityForSession(store, session, person, context).eligible ? count + 1 : count
    ), 0);
    const taRemaining = Math.max(0, Number(session.taNeeded || 0) - taAssignments.length);
    const doctorRemaining = Math.max(0, Number(session.doctorNeeded || 0) - doctorAssignments.length);

    return {
      ...session,
      durationMinutes: getDurationMinutes(session.startTime, session.endTime),
      taAssignments,
      doctorAssignments,
      assignedTACount: taAssignments.length,
      assignedDoctorCount: doctorAssignments.length,
      assignmentCount: assignments.length,
      eligibleTACount,
      eligibleDoctorCount,
      taRemaining,
      doctorRemaining,
      shortageStatus: taRemaining > 0 || doctorRemaining > 0 ? 'Shortage' : 'Covered'
    };
  });

  return {
    sessions,
    taInvigilators: [...context.invigilatorsByRole.TA].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    doctorInvigilators: [...context.invigilatorsByRole.Doctor].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
  };
}

function buildSchedulingView(store) {
  return getCachedDerivedView('schedulingCompactCore', () => buildSchedulingViewUncached(store), 'default', store);
}

function buildSchedulingEligibilityView(store, sessionId) {
  const context = buildSchedulingIndexes(store);
  const session = context.sessionById.get(sessionId);
  if (!session) {
    return null;
  }

  const buildEligibleList = (people) => {
    const eligible = [];
    const ineligible = [];

    people.forEach((person) => {
      const eligibility = getEligibilityForSession(store, session, person, context);
      const row = { ...person, ...eligibility };
      if (eligibility.eligible) {
        eligible.push(row);
      } else {
        ineligible.push(row);
      }
    });

    eligible.sort((a, b) => (a.projectedMinutes || 0) - (b.projectedMinutes || 0) || String(a.name || '').localeCompare(String(b.name || '')));
    return {
      eligible,
      ineligibleSummary: summarizeEligibility(ineligible),
      ineligibleCount: ineligible.length,
    };
  };

  const ta = buildEligibleList(context.invigilatorsByRole.TA);
  const doctor = buildEligibleList(context.invigilatorsByRole.Doctor);

  return {
    sessionId: session.id,
    eligibleTAs: ta.eligible,
    eligibleDoctors: doctor.eligible,
    ineligibleSummary: {
      TA: ta.ineligibleSummary,
      Doctor: doctor.ineligibleSummary,
    },
    ineligibleCounts: {
      TA: ta.ineligibleCount,
      Doctor: doctor.ineligibleCount,
    },
  };
}

function buildOnCallView(store) {
  const context = buildSchedulingIndexes(store);
  const periods = buildOnCallNeeds(store).map((need) => {
    const assignments = context.onCallAssignmentsByPeriodKey.get(need.periodKey) || [];
    const taAssignments = assignments
      .filter((item) => item.role === 'TA')
      .map((item) => ({ ...item, invigilator: context.invigilatorById.get(item.invigilatorId) }));
    const doctorAssignments = assignments
      .filter((item) => item.role === 'Doctor')
      .map((item) => ({ ...item, invigilator: context.invigilatorById.get(item.invigilatorId) }));

    const eligibleTACount = context.invigilatorsByRole.TA.reduce((count, person) => (
      getEligibilityForOnCall(store, need, person, context).eligible ? count + 1 : count
    ), 0);
    const eligibleDoctorCount = context.invigilatorsByRole.Doctor.reduce((count, person) => (
      getEligibilityForOnCall(store, need, person, context).eligible ? count + 1 : count
    ), 0);

    return {
      ...need,
      taAssignments,
      doctorAssignments,
      assignedTACount: taAssignments.length,
      assignedDoctorCount: doctorAssignments.length,
      onCallTARemaining: Math.max(0, Number(need.onCallTANeeded || 0) - taAssignments.length),
      onCallDoctorRemaining: Math.max(0, Number(need.onCallDoctorNeeded || 0) - doctorAssignments.length),
      eligibleTACount,
      eligibleDoctorCount,
    };
  });

  return {
    config: normalizeOnCallConfig(store.onCallConfig || {}),
    periods,
    taInvigilators: [...context.invigilatorsByRole.TA]
      .map((item) => ({
        ...item,
        onCallExcluded: normalizeOnCallConfig(store.onCallConfig || {}).excludedInvigilatorIds.includes(String(item.id || '').trim()),
      }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    doctorInvigilators: [...context.invigilatorsByRole.Doctor]
      .map((item) => ({
        ...item,
        onCallExcluded: normalizeOnCallConfig(store.onCallConfig || {}).excludedInvigilatorIds.includes(String(item.id || '').trim()),
      }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    assignments: store.onCallAssignments.map((item) => ({
      ...item,
      invigilator: context.invigilatorById.get(item.invigilatorId) || null,
      periodKey: buildOnCallPeriodKey(item),
    })),
  };
}

function buildOnCallSummary(store) {
  return getCachedDerivedView('onCallSummaryCore', () => {
    const context = buildSchedulingIndexes(store);
    const periods = buildOnCallNeeds(store);
    const shortage = periods.reduce((acc, need) => {
      const assignments = context.onCallAssignmentsByPeriodKey.get(need.periodKey) || [];
      const taAssigned = assignments.reduce((count, item) => count + (item.role === 'TA' ? 1 : 0), 0);
      const doctorAssigned = assignments.reduce((count, item) => count + (item.role === 'Doctor' ? 1 : 0), 0);
      acc.ta += Math.max(0, Number(need.onCallTANeeded || 0) - taAssigned);
      acc.doctor += Math.max(0, Number(need.onCallDoctorNeeded || 0) - doctorAssigned);
      return acc;
    }, { ta: 0, doctor: 0 });

    return {
      periodCount: periods.length,
      assignmentCount: Array.isArray(store.onCallAssignments) ? store.onCallAssignments.length : 0,
      shortage,
      totalShortage: shortage.ta + shortage.doctor,
    };
  }, 'default', store);
}

function buildOnCallEligibilityView(store, date, startTime, endTime) {
  const context = buildSchedulingIndexes(store);
  const periodKey = buildOnCallPeriodKey({ date, startTime, endTime });
  const need = context.onCallNeedByPeriodKey.get(periodKey);
  if (!need) {
    return null;
  }

  const buildEligibleList = (people) => {
    const eligible = [];
    const ineligible = [];

    people.forEach((person) => {
      const eligibility = getEligibilityForOnCall(store, need, person, context);
      const row = { ...person, ...eligibility };
      if (eligibility.eligible) {
        eligible.push(row);
      } else {
        ineligible.push(row);
      }
    });

    eligible.sort((a, b) => (a.projectedMinutes || 0) - (b.projectedMinutes || 0) || String(a.name || '').localeCompare(String(b.name || '')));
    return {
      eligible,
      ineligibleSummary: summarizeEligibility(ineligible),
      ineligibleCount: ineligible.length,
    };
  };

  const ta = buildEligibleList(context.invigilatorsByRole.TA);
  const doctor = buildEligibleList(context.invigilatorsByRole.Doctor);

  return {
    periodKey,
    date: need.date,
    startTime: need.startTime,
    endTime: need.endTime,
    eligibleTAs: ta.eligible,
    eligibleDoctors: doctor.eligible,
    ineligibleSummary: {
      TA: ta.ineligibleSummary,
      Doctor: doctor.ineligibleSummary,
    },
    ineligibleCounts: {
      TA: ta.ineligibleCount,
      Doctor: doctor.ineligibleCount,
    },
  };
}

function listEligibleOnCallAutoCandidates(store, need, role, context) {
  const people = role === 'Doctor' ? context.invigilatorsByRole.Doctor : context.invigilatorsByRole.TA;
  return people
    .map((person) => {
      const eligibility = getEligibilityForOnCall(store, need, person, context);
      return {
        person,
        eligibility,
      };
    })
    .filter((row) => row.eligibility.eligible)
    .sort((a, b) => {
      const projectedDiff = Number(a.eligibility.projectedMinutes || 0) - Number(b.eligibility.projectedMinutes || 0);
      if (projectedDiff !== 0) return projectedDiff;
      const currentDiff = Number(a.eligibility.currentMinutes || 0) - Number(b.eligibility.currentMinutes || 0);
      if (currentDiff !== 0) return currentDiff;
      return String(a.person.name || '').localeCompare(String(b.person.name || ''));
    });
}

function buildOnCallAutoScheduleResult(store, options = {}) {
  const workingStore = cloneStore(store);
  const previousAssignments = Array.isArray(workingStore.onCallAssignments)
    ? [...workingStore.onCallAssignments]
    : [];
  workingStore.onCallAssignments = [];
  const createdAssignments = [];
  let iterations = 0;
  let madeChange = true;

  while (madeChange && iterations < 2000) {
    iterations += 1;
    madeChange = false;
    const context = buildSchedulingIndexes(workingStore);
    const tasks = [];

    buildOnCallNeeds(workingStore).forEach((need) => {
      const assignments = context.onCallAssignmentsByPeriodKey.get(need.periodKey) || [];
      const assignedTACount = assignments.filter((item) => item.role === 'TA').length;
      const assignedDoctorCount = assignments.filter((item) => item.role === 'Doctor').length;
      const taRemaining = Math.max(0, Number(need.onCallTANeeded || 0) - assignedTACount);
      const doctorRemaining = Math.max(0, Number(need.onCallDoctorNeeded || 0) - assignedDoctorCount);

      if (taRemaining > 0) {
        const eligible = listEligibleOnCallAutoCandidates(workingStore, need, 'TA', context);
        const best = eligible[0] || null;
        tasks.push({
          need,
          role: 'TA',
          remaining: taRemaining,
          eligibleCount: eligible.length,
          best,
        });
      }

      if (doctorRemaining > 0) {
        const eligible = listEligibleOnCallAutoCandidates(workingStore, need, 'Doctor', context);
        const best = eligible[0] || null;
        tasks.push({
          need,
          role: 'Doctor',
          remaining: doctorRemaining,
          eligibleCount: eligible.length,
          best,
        });
      }
    });

    tasks.sort((a, b) => {
      const eligibleDiff = Number(a.eligibleCount || 0) - Number(b.eligibleCount || 0);
      if (eligibleDiff !== 0) return eligibleDiff;
      const remainingDiff = Number(b.remaining || 0) - Number(a.remaining || 0);
      if (remainingDiff !== 0) return remainingDiff;
      const roomDiff = Number(b.need.activeRoomCount || 0) - Number(a.need.activeRoomCount || 0);
      if (roomDiff !== 0) return roomDiff;
      return `${a.need.date} ${a.need.startTime} ${a.role}`.localeCompare(`${b.need.date} ${b.need.startTime} ${b.role}`);
    });

    const target = tasks.find((item) => item.best);
    if (!target) {
      break;
    }

    const assignment = {
      id: generateId('oncall'),
      date: target.need.date,
      startTime: target.need.startTime,
      endTime: target.need.endTime,
      invigilatorId: target.best.person.id,
      role: target.role,
    };
    workingStore.onCallAssignments.push(assignment);
    createdAssignments.push({
      ...assignment,
      invigilator: target.best.person,
      projectedHours: Math.round((Number(target.best.eligibility.projectedMinutes || 0) / 60) * 100) / 100,
    });
    madeChange = true;
  }

  const finalView = buildOnCallView(workingStore);
  const finalSummary = buildOnCallSummary(workingStore);
  return {
    nextStore: workingStore,
    summary: {
      dryRun: Boolean(options.dryRun),
      rebalanced: true,
      previousAssignmentCount: previousAssignments.length,
      addedCount: createdAssignments.length,
      remainingTAShortage: Number(finalSummary.shortage?.ta || 0),
      remainingDoctorShortage: Number(finalSummary.shortage?.doctor || 0),
      totalRemainingShortage: Number(finalSummary.totalShortage || 0),
      createdAssignments,
      periods: finalView.periods,
      config: finalView.config,
    },
  };
}

function buildDutyCollectionsUncached(store) {
  const invigilatorMap = new Map(store.invigilators.map((item) => [item.id, item]));
  const sessionMap = new Map(store.sessions.map((item) => [item.id, item]));
  const controlSessionMap = new Map(store.controlSessions.map((item) => [item.id, item]));
  const dayWindows = getDayWindows(store.sessions);
  const dayWindowMap = new Map(dayWindows.map((item) => [item.date, item]));
  const onCallNeedMap = new Map(buildOnCallNeeds(store).map((item) => [item.periodKey, item]));

  const sessionDuties = store.assignments.map((item) => {
    const session = sessionMap.get(item.sessionId);
    return {
      ...item,
      dutyType: 'Session',
      date: session?.date || '',
      startTime: session?.startTime || '',
      endTime: session?.endTime || '',
      durationMinutes: session ? getDurationMinutes(session.startTime, session.endTime) : 0,
      invigilator: invigilatorMap.get(item.invigilatorId),
      label: session ? `${getCourseLabel(session, session.room || 'Session')} (${session.room || 'No room'})` : 'Session'
    };
  });

  const superDuties = store.superAssignments.map((item) => {
    const window = dayWindowMap.get(item.date);
    return {
      ...item,
      dutyType: 'Super',
      date: item.date,
      startTime: window?.startTime || '',
      endTime: window?.endTime || '',
      durationMinutes: window?.durationMinutes || 0,
      invigilator: invigilatorMap.get(item.invigilatorId),
      label: 'Super Invigilator'
    };
  });

  const controlDuties = store.controlAssignments.map((item) => {
    const session = controlSessionMap.get(item.controlSessionId);
    const window = session ? null : dayWindowMap.get(item.date);
    return {
      ...item,
      dutyType: 'Control',
      date: session?.date || item.date,
      startTime: session?.startTime || window?.startTime || '',
      endTime: session?.endTime || window?.endTime || '',
      durationMinutes: session ? getDurationMinutes(session.startTime, session.endTime) : (window?.durationMinutes || 0),
      invigilator: invigilatorMap.get(item.invigilatorId),
      label: session ? `${getCourseLabel(session, 'Control')} (${session.room || 'Control'})` : 'Control Session'
    };
  });

  const onCallDuties = store.onCallAssignments.map((item) => {
    const need = onCallNeedMap.get(buildOnCallPeriodKey(item));
    return {
      ...item,
      dutyType: 'OnCall',
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      durationMinutes: getDurationMinutes(item.startTime, item.endTime),
      invigilator: invigilatorMap.get(item.invigilatorId),
      label: need ? `On-Call (${need.activeRoomCount} rooms)` : 'On-Call'
    };
  });

  return { dayWindows, sessionDuties, superDuties, controlDuties, onCallDuties };
}

function buildDutyCollections(store) {
  return getCachedDerivedView('dutyCollectionsCore', () => buildDutyCollectionsUncached(store), 'default', store);
}

function buildStaffContinuityView(store) {
  const summary = buildStaffHourPolicySummary(store);
  const { sessionDuties, onCallDuties, controlDuties, superDuties } = buildDutyCollections(store);
  const byStaff = new Map();
  for (const duty of [...sessionDuties, ...onCallDuties, ...controlDuties, ...superDuties]) {
    if (!duty.date || !duty.startTime || !duty.endTime) continue;
    if (!byStaff.has(duty.invigilatorId)) byStaff.set(duty.invigilatorId, new Map());
    const dates = byStaff.get(duty.invigilatorId);
    if (!dates.has(duty.date)) dates.set(duty.date, []);
    dates.get(duty.date).push([parseTimeToMinutes(duty.startTime), parseTimeToMinutes(duty.endTime)]);
  }
  return store.invigilators.flatMap((person) => {
    const policy = summary.effectivePolicyByInvigilatorId.get(person.id);
    if (!policy?.preferConsecutiveDuties && !policy?.preferConsecutiveDays) return [];
    const dates = byStaff.get(person.id) || new Map();
    let idleMinutes = 0;
    for (const intervals of dates.values()) {
      intervals.sort((a, b) => a[0] - b[0]);
      let end = intervals[0][1];
      for (const [nextStart, nextEnd] of intervals.slice(1)) {
        idleMinutes += Math.max(0, nextStart - end);
        end = Math.max(end, nextEnd);
      }
    }
    const days = [...dates.keys()].map((value) => Date.parse(`${value}T00:00:00Z`) / 86400000).sort((a, b) => a - b);
    const workingDayGaps = days.length ? days[days.length - 1] - days[0] + 1 - days.length : 0;
    return [{ invigilatorId: person.id, staffId: String(person.staffId || person.id), name: person.name,
      preferConsecutiveDuties: policy.preferConsecutiveDuties, preferConsecutiveDays: policy.preferConsecutiveDays,
      workingDayGaps, idleMinutes }];
  });
}

function buildWorkloadView(store) {
  const { sessionDuties, superDuties, controlDuties, onCallDuties } = buildDutyCollections(store);
  const policySummary = buildStaffHourPolicySummary(store);
  const allDuties = [...sessionDuties, ...superDuties, ...controlDuties, ...onCallDuties];
  const dutiesByInvigilator = new Map();

  allDuties.forEach((item) => {
    pushToMapArray(dutiesByInvigilator, item.invigilatorId, item);
  });

  const rows = store.invigilators.map((person) => {
    const effectivePolicy = policySummary.effectivePolicyByInvigilatorId.get(person.id) || null;
    const duties = dutiesByInvigilator.get(person.id) || [];
    let sessionCount = 0;
    let superCount = 0;
    let controlCount = 0;
    let sessionMinutes = 0;
    let superMinutes = 0;
    let controlMinutes = 0;
    let onCallCount = 0;
    let onCallMinutes = 0;

    duties.forEach((item) => {
      if (item.dutyType === 'Session') {
        sessionCount += 1;
        sessionMinutes += item.durationMinutes;
      } else if (item.dutyType === 'Super') {
        superCount += 1;
        superMinutes += item.durationMinutes;
      } else if (item.dutyType === 'Control') {
        controlCount += 1;
        controlMinutes += item.durationMinutes;
      } else if (item.dutyType === 'OnCall') {
        onCallCount += 1;
        onCallMinutes += item.durationMinutes;
      }
    });

    const targetMinutes = Number(effectivePolicy?.allowedMinutes || 0);
    const differenceFromTargetMinutes = sessionMinutes + superMinutes + controlMinutes + onCallMinutes - targetMinutes;
    const totalMinutes = sessionMinutes + superMinutes + controlMinutes + onCallMinutes;
    let policyStatus = effectivePolicy?.mode || 'default';
    if (effectivePolicy?.excluded) {
      policyStatus = 'excluded';
    } else if (targetMinutes > 0) {
      if (totalMinutes > targetMinutes) {
        policyStatus = 'over target';
      } else if (Math.abs(totalMinutes - targetMinutes) <= 30) {
        policyStatus = 'near target';
      } else if (totalMinutes < targetMinutes) {
        policyStatus = 'under target';
      }
    }

    return {
      ...person,
      sessionCount,
      superCount,
      controlCount,
      sessionMinutes,
      superMinutes,
      controlMinutes,
      onCallCount,
      onCallMinutes,
      totalMinutes,
      roleAverageHours: Number(effectivePolicy?.rawAverageHours || 0),
      effectiveAllowedHours: Number(effectivePolicy?.allowedHours || 0),
      differenceFromTargetHours: Math.round((differenceFromTargetMinutes / 60) * 100) / 100,
      policyMode: effectivePolicy?.mode || 'default',
      policyStatus,
      excludeFromAutoSchedule: Boolean(effectivePolicy?.excluded),
    };
  });

  return rows.sort((a, b) => b.totalMinutes - a.totalMinutes || a.name.localeCompare(b.name));
}

module.exports = {
  SCHEDULING_PREFERENCES,
  normalizeSchedulingConfig,
  readStore,
  writeStore,
  initStoreFromPrimary,
  restoreStoreFromDbIfNeeded,
  getStorageStatus,
  getStartupStorageInfo,
  summarizeStoreCounts,
  normalizeAssignmentMetadata,
  generateId,
  getDayWindows,
  getSessionRoomStartKey,
  getSessionRoomStartCourseKey,
  getSessionRoomTimeKey,
  normalizeStoreSessions,
  parseTimeToMinutes,
  getDurationMinutes,
  rangesOverlap,
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
  buildOnCallAutoScheduleResult,
  buildStaffHourPolicySummary,
  normalizeOnCallConfig,
  normalizeStaffHourPolicyRow,
  buildDutyCollections,
  buildStaffContinuityView,
  buildWorkloadView
};
