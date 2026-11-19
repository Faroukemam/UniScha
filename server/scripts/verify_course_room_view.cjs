// Frontend summaries and loaded allocation details; no API writes or database access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');

async function main() {
  const view = await import(pathToFileURL(path.join(root, 'client/src/courseRoomView.mjs')));
  const results = [
    { placementGroupId: 'G1', courseCodes: 'CE101; CE102', date: '2026-11-18', start: '09:00', end: '10:00', totalStudents: 70, shortage: 0, roomPlacementType: 'TH', assignedRooms: 'R1, R2', status: 'AssignedWithBackup' },
    { placementGroupId: 'G2', courseCodes: 'LAB201', date: '2026-11-19', start: '09:00', end: '10:00', totalStudents: 20, shortage: 5, roomPlacementType: 'LAB', status: 'CapacityShortage' },
  ];
  const roomRows = [
    { ...results[0], room: 'R1', roomType: 'TH', autoAvailable: true, capacityMode: 'Major', roomCapacity: 50, studentsAssignedToThisBlock: 20, blockTotalAssignedStudentsAtThisTime: 40, blockRemainingCapacityAtThisTime: 10, physicalRoomTotalAssignedStudentsAtThisTime: 80 },
    { ...results[0], room: 'R2', roomType: 'TH', autoAvailable: false, capacityMode: 'Minor', roomCapacity: 50, studentsAssignedToThisRoom: 50 },
    { ...results[1], room: 'R1', roomType: 'LAB', autoAvailable: ' Yes ', capacityMode: 'Major', roomCapacity: 50, studentsAssignedToThisRoom: 15 },
  ];
  const summary = view.summarizeCourseRooms({ results, roomRows });
  assert.equal(summary.backupRooms, 1, 'Repeated use of one backup room is still one physical room');
  assert.equal(summary.backupGroups, 2, 'Backup group count is separate from physical rooms');
  assert.equal(summary.totalStudents, 90, 'Linked courses count once through their placement group');
  assert.equal(summary.shortage, 5); assert.equal(summary.seatedStudents, 85);
  assert.equal(summary.placedGroups, 1); assert.equal(summary.usedRooms, 2);
  assert.equal(view.summarizeCourseRooms({ courses: [{ students: 70 }], results: [], roomRows: [] }).shortage, null, 'No run must not imply zero shortages');
  assert.equal(view.filterCourseRoomRows(results, { search: 'ce102', date: '2026-11-18', type: 'TH', status: 'AssignedWithBackup' }).length, 1);
  assert.equal(view.filterCourseRoomRows(results, { status: 'Assigned' }).length, 0, 'Normal placements must not include backup placements');
  assert.equal(view.filterCourseRoomRows(roomRows, { roomSource: 'backup' }, 'rooms').length, 2);
  assert.equal(view.filterCourseRoomRows(roomRows, { roomSource: 'normal' }, 'rooms').length, 1);
  assert.equal(view.filterCourseRoomRows(roomRows, { search: 'R1', date: '2026-11-19' }, 'rooms').length, 1);
  const overlapping = [...roomRows, { ...roomRows[0], end: '11:00' }];
  assert.equal(view.groupRoomPeriods(overlapping).length, 3, 'Different end times must remain distinct periods');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'unisc-room-ui-'));
  try {
    const client = path.join(root, 'client');
    const clientRequire = createRequire(path.join(client, 'package.json'));
    const bundle = path.join(temporary, 'render.cjs');
    const contents = `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
      import Details, {AllocatedRoomCard, PlacementBadge} from ${JSON.stringify(path.join(client, 'src/components/CourseRoomDetails.jsx'))};
      export const detailHtml = renderToStaticMarkup(<Details result={${JSON.stringify(results[0])}} rooms={${JSON.stringify(roomRows.slice(0, 2))}} onClose={()=>{}} />);
      export const cardHtml = renderToStaticMarkup(<AllocatedRoomCard room={${JSON.stringify(roomRows[0])}} />);
      export const badgeHtml = renderToStaticMarkup(<PlacementBadge status="AssignedWithBackup" />);`;
    clientRequire('esbuild').buildSync({ stdin: { contents, resolveDir: client, loader: 'jsx' }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile: bundle, logLevel: 'silent' });
    const rendered = require(bundle);
    for (const text of ['Allocation details', 'CE101; CE102', 'R1', 'R2', 'Close details']) assert.ok(rendered.detailHtml.toLowerCase().includes(text.toLowerCase()));
    assert.match(rendered.cardHtml, /Block total used<\/dt><dd>40<\/dd>/);
    assert.match(rendered.cardHtml, /Physical room total<\/dt><dd>80<\/dd>/);
    assert.match(rendered.cardHtml, /Block seats remaining<\/dt><dd>10<\/dd>/);
    assert.match(rendered.badgeHtml, /Placed with backup/);
  } finally {
    const resolved = fs.realpathSync(temporary);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log('PASS: distinct room/group metrics, student totals, filters, period boundaries, and loaded allocation detail rendering.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
