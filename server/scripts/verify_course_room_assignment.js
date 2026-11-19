// Run with: node server/scripts/verify_course_room_assignment.js
// Uses in-memory dependencies; the saved schedule is never modified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function loadBackend(responses) {
  const payloads = [];
  const writes = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = {
      write(value) { input += value; },
      end() {
        payloads.push(JSON.parse(input));
        const response = responses.shift();
        process.nextTick(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify(response)));
          child.emit('close', 0);
        });
      },
    };
    return child;
  };
  const db = {
    all: async () => [],
    get: async () => null,
    write: async (callback) => callback({
      run: (...args) => writes.push(args),
      prepare: () => ({ run: (...args) => writes.push(args), free() {} }),
    }),
  };
  const filename = path.join(__dirname, '..', 'courseRoomAssignment.js');
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename),
    require: (name) => name === './db' ? db : name === 'child_process' ? { spawn } : require(name),
  };
  vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports.buildQualityReport = buildQualityReport;`, context);
  return { backend: context.module.exports, payloads, writes };
}

function result(shortage) {
  return {
    status: 'FEASIBLE',
    results: [{ placementGroupId: 'PG-1', totalStudents: 20, shortage,
      status: shortage ? 'CapacityShortage' : 'AssignedWithBackup' }],
    roomRows: [{ placementGroupId: 'PG-1', room: 'R1', capacityMode: 'Minor', studentsAssignedToThisRoom: 10 }],
  };
}

async function main() {
  {
    const { backend, payloads, writes } = loadBackend([result(10), result(0)]);
    await backend.runCourseRoomAssignment();
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].options.use_auto_available_backup, false);
    assert.equal(payloads[1].options.use_auto_available_backup, true);
    assert.equal(payloads[1].lockedAssignments, undefined, 'Backup solve must be free to rearrange normal placements');
    const storedQuality = JSON.parse(writes.find((args) => args[1]?.[0] === 'course_room_quality')[1][1]);
    assert.equal(storedQuality.stageSummaries.finalChosen.totalShortageStudents, 0);
  }
  {
    const { backend, payloads } = loadBackend([result(0)]);
    await backend.runCourseRoomAssignment();
    assert.equal(payloads.length, 1, 'Do not use backup when normal rooms suffice');
  }
  for (const response of [{ status: 'ERROR', error: 'solver detail' }, { status: 'UNKNOWN' }]) {
    const { backend, writes } = loadBackend([response]);
    await assert.rejects(backend.runCourseRoomAssignment(), /solver detail|usable result/);
    assert.equal(writes.length, 0, 'Failed solve must preserve saved results');
  }
  {
    const { backend } = loadBackend([]);
    const group = { placementGroupId: 'PG-1', courseCodes: 'A', totalStudents: 60,
      shortage: 10, date: '2026-11-06', start: '09:00', end: '10:00', roomPlacementType: 'TH', status: 'CapacityShortage' };
    const state = {
      results: [group], roomRows: [], summary: {},
      capacities: [
        { room: 'R1', roomType: 'TH', majorCap: 30, minorCap: 40, autoAvailable: false },
        { room: 'R2', roomType: 'LAB', majorCap: 0, minorCap: 20, autoAvailable: true },
        { room: 'R3', roomType: 'TH', majorCap: 200, minorCap: 300, autoAvailable: false },
      ],
      availability: [
        { room: 'R1', date: group.date, start: '08:00', end: '12:00' },
        { room: 'R3', date: group.date, start: '09:00', end: '09:30' },
      ],
    };
    let diagnostic = backend.buildQualityReport(state).shortageDiagnostics[0];
    assert.equal(diagnostic.candidateRooms, 2);
    assert.equal(diagnostic.totalCompatibleNormalCapacity, 40, 'Count the imported single block, without a percentage extension');
    assert.equal(diagnostic.compatibleAutoAvailableCapacity, 20);
    assert.equal(diagnostic.theoreticallyPlaceable, true);
    assert.equal(diagnostic.shortageReason, 'Room competition or packing');
    diagnostic = backend.buildQualityReport(state, null, { allowThFallback: false }).shortageDiagnostics[0];
    assert.equal(diagnostic.compatibleAutoAvailableCapacity, 0);
    assert.equal(diagnostic.shortageReason, 'One-block capacity limit');
    diagnostic = backend.buildQualityReport(state, null, { capacityStrategy: 'major' }).shortageDiagnostics[0];
    assert.equal(diagnostic.totalCompatibleNormalCapacity, 30);
    assert.equal(diagnostic.compatibleAutoAvailableCapacity, 0);
  }
  console.log('Course-room backend checks passed: backup rearrangement, stage selection, failure preservation, shortage diagnostics.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
