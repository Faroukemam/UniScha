// Run: node server/scripts/verify_session_needs_import.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, '../..');
  const { readSessionNeedsWorkbook } = await import(pathToFileURL(path.join(root, 'client/src/sessionNeedsWorkbook.mjs')));
  const fixtures = ['sample_2/session_needs_template.xlsx', 'sample_1/room_staff_needs.xlsx', 'sample_1/room_staff_needs_updated.xlsx'];
  const fixtureRows = fixtures.map((file) => readSessionNeedsWorkbook(XLSX.readFile(path.join(root, file))));
  assert.ok(fixtureRows.every((rows) => rows.length > 300));
  assert.equal(fixtureRows[2][0]['TAs Needed'], 2);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Room: 'R', Date: '2026-06-01' }]), 'Sessions');
  assert.throws(() => readSessionNeedsWorkbook(workbook), /No session needs table/);

  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uni-scha-needs-'));
  const server = path.join(isolatedRoot, 'server');
  fs.mkdirSync(path.join(server, 'data'), { recursive: true });
  for (const file of ['index.js', 'store.js', 'db.js', 'reports.js', 'courseRoomAssignment.js']) {
    fs.copyFileSync(path.join(root, 'server', file), path.join(server, file));
  }
  fs.cpSync(path.join(root, 'node_modules/sql.js'), path.join(isolatedRoot, 'node_modules/sql.js'), { recursive: true });
  const sessions = fixtureRows[0].map((row, i) => {
    const date = XLSX.SSF.parse_date_code(row.Date);
    return { id: `S${i}`, room: row.Room, date: `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`,
      startTime: row.Start, endTime: row.End, taNeeded: 7, doctorNeeded: 2, totalNeeded: 9 };
  });
  const seed = { sessions, invigilators: [], assignments: [], engagements: [], superAssignments: [], controlSessions: [], controlAssignments: [], onCallAssignments: [] };
  for (const file of ['store.json', 'store.last-good.json']) fs.writeFileSync(path.join(server, 'data', file), JSON.stringify(seed));
  const child = spawn(process.execPath, [path.join(server, 'index.js')], {
    cwd: isolatedRoot, env: { ...process.env, PORT: '3194', NODE_PATH: path.join(root, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = 'http://127.0.0.1:3194';
  const get = async () => (await fetch(base + '/api/sessions')).json();
  const post = async (rows, status = 200) => {
    const response = await fetch(base + '/api/import/session-needs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    return payload;
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/sessions')).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, stderr);
    for (const rows of fixtureRows) {
      const result = await post(rows);
      assert.ok(result.updated > 300, JSON.stringify(result));
    }
    let session = (await get())[0];
    const result = await post([{ ' Session ID ': session.id, 'TAs Needed': 4, 'Doctors Needed': '', 'Total Staff': 999 }]);
    assert.equal(result.updated, 1);
    const after = (await get()).find((row) => row.id === session.id);
    assert.equal(after.taNeeded, 4);
    assert.equal(after.doctorNeeded, session.doctorNeeded);
    assert.equal(after.totalNeeded, 4 + after.doctorNeeded);
    await post([{ SessionID: session.id, TANeeded: 0, DoctorNeeded: 0 }]);
    session = (await get()).find((row) => row.id === session.id);
    assert.equal(session.totalNeeded, 0);
    for (const row of [
      { SessionID: session.id }, { SessionID: session.id, TANeeded: -1 },
      { SessionID: session.id, TANeeded: 'bad' }, { SessionID: session.id, TANeeded: 1.5 },
      { SessionID: session.id, InvigilatorsNeeded: 5 },
    ]) await post([row], 400);
    assert.deepEqual((await get()).find((row) => row.id === session.id), session);
    await post([{ Room: session.room, Date: '1999-01-01', Start: session.startTime, TANeeded: 3 }], 400);
    const fallback = await post([{ SessionID: 'old-id', Room: session.room, Date: session.date, Start: session.startTime, End: '23:59', TANeeded: 3 }]);
    assert.equal(fallback.updated, 1);
    const partial = await post([{ SessionID: session.id, TANeeded: 2 }, { SessionID: session.id, TANeeded: 'bad' }]);
    assert.equal(partial.updated, 1);
    assert.equal(partial.rejected[0].row, 3);
    console.log('PASS: all three sample workbooks, header detection, column aliases, ID/block matching, blanks, zero, invalid counts, totals, partial imports, persistence.');
  } finally {
    child.kill();
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const resolved = fs.realpathSync(isolatedRoot);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
