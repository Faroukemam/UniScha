const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'scheduler.sqlite');

let dbPromise;

async function initDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const SQL = await initSqlJs({
        locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
      });

      const db = fs.existsSync(dbPath)
        ? new SQL.Database(fs.readFileSync(dbPath))
        : new SQL.Database();

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

        DROP TABLE IF EXISTS invigilators;

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
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS super_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          exam_date TEXT NOT NULL,
          staff_id TEXT NOT NULL
        );

        DROP TABLE IF EXISTS control_assignments;
        DROP TABLE IF EXISTS control_sessions;

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
      `);

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
