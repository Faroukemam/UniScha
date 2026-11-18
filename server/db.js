const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'scheduler.sqlite');
const SQLITE_HEADER = 'SQLite format 3\u0000';

let dbPromise;

function ensureColumn(db, tableName, columnName, columnSql) {
  const rows = db.exec(`PRAGMA table_info(${tableName})`);
  const columns = new Set();
  if (rows.length && Array.isArray(rows[0].values)) {
    for (const valueRow of rows[0].values) {
      columns.add(String(valueRow[1] || ''));
    }
  }
  if (!columns.has(columnName)) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
  }
}

async function initDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const SQL = await initSqlJs({
        locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
      });

      let db;
      if (fs.existsSync(dbPath)) {
        try {
          const raw = fs.readFileSync(dbPath);
          const header = raw.subarray(0, SQLITE_HEADER.length).toString('utf8');
          if (header !== SQLITE_HEADER) {
            throw new Error('Invalid SQLite header');
          }
          db = new SQL.Database(raw);
        } catch (_error) {
          const invalidPath = `${dbPath}.invalid.${Date.now()}`;
          fs.renameSync(dbPath, invalidPath);
          db = new SQL.Database();
        }
      } else {
        db = new SQL.Database();
      }

      db.run(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course_name TEXT DEFAULT '',
          room TEXT DEFAULT '',
          exam_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          duration_hours REAL DEFAULT 0,
          ta_needed INTEGER DEFAULT 0,
          doctor_needed INTEGER DEFAULT 0,
          total_needed INTEGER DEFAULT 0,
          notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS invigilators (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          staff_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          email TEXT DEFAULT '',
          role TEXT NOT NULL DEFAULT 'TA',
          load_type TEXT DEFAULT 'full',
          max_hours REAL DEFAULT 0,
          department TEXT DEFAULT '',
          notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS engagements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          staff_id TEXT NOT NULL,
          exam_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          engagement INTEGER NOT NULL DEFAULT 1,
          notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          staff_id TEXT NOT NULL,
          role TEXT NOT NULL,
          assignment_source TEXT NOT NULL DEFAULT 'legacy',
          locked INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT '',
          updated_at TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS super_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          exam_date TEXT NOT NULL,
          staff_id TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS control_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course_name TEXT DEFAULT '',
          room TEXT DEFAULT '',
          exam_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          ta_needed INTEGER DEFAULT 0,
          doctor_needed INTEGER DEFAULT 0,
          total_needed INTEGER DEFAULT 0,
          notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS control_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          control_session_id INTEGER NOT NULL,
          staff_id TEXT NOT NULL,
          role TEXT NOT NULL,
          FOREIGN KEY (control_session_id) REFERENCES control_sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS on_call_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          exam_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          staff_id TEXT NOT NULL,
          role TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS on_call_config (
          config_key TEXT PRIMARY KEY,
          config_value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scheduling_config (
          config_key TEXT PRIMARY KEY,
          config_value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS staff_hour_policies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          staff_id TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'default',
          hours_value REAL DEFAULT 0,
          exclude_from_auto_schedule INTEGER NOT NULL DEFAULT 0,
          prefer_consecutive_duties INTEGER NOT NULL DEFAULT 0,
          prefer_consecutive_days INTEGER NOT NULL DEFAULT 0,
          allow_engagement_override INTEGER NOT NULL DEFAULT 1,
          notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS course_room_courses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_number INTEGER DEFAULT 0,
          course_code TEXT NOT NULL,
          students INTEGER NOT NULL DEFAULT 0,
          exam_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          room_placement_type TEXT NOT NULL,
          linked_group TEXT DEFAULT '',
          linked_courses TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS course_room_availability (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_number INTEGER DEFAULT 0,
          room TEXT NOT NULL,
          exam_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS course_room_capacity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_number INTEGER DEFAULT 0,
          room TEXT NOT NULL UNIQUE,
          minor_cap INTEGER NOT NULL DEFAULT 0,
          major_cap INTEGER NOT NULL DEFAULT 0,
          room_type TEXT NOT NULL,
          auto_available INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS course_room_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          placement_group_id TEXT NOT NULL UNIQUE,
          course_codes TEXT NOT NULL,
          linked_group TEXT DEFAULT '',
          total_students INTEGER NOT NULL DEFAULT 0,
          exam_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          room_placement_type TEXT NOT NULL,
          capacity_mode TEXT DEFAULT '',
          assigned_rooms TEXT DEFAULT '',
          assigned_capacity INTEGER NOT NULL DEFAULT 0,
          waste_capacity INTEGER NOT NULL DEFAULT 0,
          shortage INTEGER NOT NULL DEFAULT 0,
          auto_available_used INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS course_room_result_rooms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          placement_group_id TEXT NOT NULL,
          course_codes TEXT NOT NULL,
          linked_group TEXT DEFAULT '',
          room TEXT NOT NULL,
          exam_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          capacity_mode TEXT DEFAULT '',
          room_capacity INTEGER NOT NULL DEFAULT 0,
          students_assigned_to_this_room INTEGER NOT NULL DEFAULT 0,
          students_assigned_to_this_block INTEGER NOT NULL DEFAULT 0,
          block_total_assigned_students INTEGER NOT NULL DEFAULT 0,
          block_remaining_capacity INTEGER NOT NULL DEFAULT 0,
          physical_room_total_assigned_students INTEGER NOT NULL DEFAULT 0,
          room_type TEXT DEFAULT '',
          auto_available INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS course_room_validation_errors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          row_number INTEGER DEFAULT 0,
          field TEXT DEFAULT '',
          error_message TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS course_room_meta (
          meta_key TEXT PRIMARY KEY,
          meta_value TEXT NOT NULL
        );
      `);

      ensureColumn(db, 'sessions', 'course_name', "course_name TEXT DEFAULT ''");
      ensureColumn(db, 'sessions', 'room', "room TEXT DEFAULT ''");
      ensureColumn(db, 'sessions', 'duration_hours', 'duration_hours REAL DEFAULT 0');
      ensureColumn(db, 'sessions', 'ta_needed', 'ta_needed INTEGER DEFAULT 0');
      ensureColumn(db, 'sessions', 'doctor_needed', 'doctor_needed INTEGER DEFAULT 0');
      ensureColumn(db, 'sessions', 'total_needed', 'total_needed INTEGER DEFAULT 0');
      ensureColumn(db, 'sessions', 'notes', "notes TEXT DEFAULT ''");

      ensureColumn(db, 'invigilators', 'email', "email TEXT DEFAULT ''");
      ensureColumn(db, 'invigilators', 'role', "role TEXT NOT NULL DEFAULT 'TA'");
      ensureColumn(db, 'invigilators', 'load_type', "load_type TEXT DEFAULT 'full'");
      ensureColumn(db, 'invigilators', 'max_hours', 'max_hours REAL DEFAULT 0');
      ensureColumn(db, 'invigilators', 'department', "department TEXT DEFAULT ''");
      ensureColumn(db, 'invigilators', 'notes', "notes TEXT DEFAULT ''");

      ensureColumn(db, 'engagements', 'notes', "notes TEXT DEFAULT ''");
      ensureColumn(db, 'assignments', 'assignment_source', "assignment_source TEXT NOT NULL DEFAULT 'legacy'");
      ensureColumn(db, 'assignments', 'locked', 'locked INTEGER NOT NULL DEFAULT 1');
      ensureColumn(db, 'assignments', 'created_at', "created_at TEXT DEFAULT ''");
      ensureColumn(db, 'assignments', 'updated_at', "updated_at TEXT DEFAULT ''");
      ensureColumn(db, 'assignments', 'notes', "notes TEXT DEFAULT ''");
      ensureColumn(db, 'assignments', 'engagement_override_reason', "engagement_override_reason TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, 'on_call_assignments', 'engagement_override_reason', "engagement_override_reason TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, 'control_sessions', 'course_name', "course_name TEXT DEFAULT ''");
      ensureColumn(db, 'control_sessions', 'room', "room TEXT DEFAULT ''");
      ensureColumn(db, 'control_sessions', 'ta_needed', 'ta_needed INTEGER DEFAULT 0');
      ensureColumn(db, 'control_sessions', 'doctor_needed', 'doctor_needed INTEGER DEFAULT 0');
      ensureColumn(db, 'control_sessions', 'total_needed', 'total_needed INTEGER DEFAULT 0');
      ensureColumn(db, 'control_sessions', 'notes', "notes TEXT DEFAULT ''");
      ensureColumn(db, 'staff_hour_policies', 'hours_value', 'hours_value REAL DEFAULT 0');
      ensureColumn(db, 'staff_hour_policies', 'exclude_from_auto_schedule', 'exclude_from_auto_schedule INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'staff_hour_policies', 'prefer_consecutive_duties', 'prefer_consecutive_duties INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'staff_hour_policies', 'prefer_consecutive_days', 'prefer_consecutive_days INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'staff_hour_policies', 'allow_engagement_override', 'allow_engagement_override INTEGER NOT NULL DEFAULT 1');
      ensureColumn(db, 'staff_hour_policies', 'notes', "notes TEXT DEFAULT ''");

      persistDb(db);
      return db;
    })();
  }

  return dbPromise;
}

function persistDb(db) {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

async function all(sql, params = []) {
  const db = await initDb();
  const stmt = db.prepare(sql, params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function write(callback) {
  const db = await initDb();
  const result = await callback(db);
  persistDb(db);
  return result;
}

module.exports = {
  initDb,
  all,
  get,
  write,
  dbPath
};
