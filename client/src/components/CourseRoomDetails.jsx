import { isBackupRoom, placementStatusLabels } from '../courseRoomView.mjs';

export function PlacementBadge({ status }) {
  const tone = status === 'Assigned' ? 'success' : status === 'AssignedWithBackup' ? 'warning' : 'danger';
  return <span className={`ops-badge tone-${tone}`}>{placementStatusLabels[status] || status || 'Not placed'}</span>;
}

export function CourseRoomPager({ page, totalPages, total, onPage, label }) {
  if (totalPages <= 1) return null;
  return <nav className="cr-pagination" aria-label={`${label} pages`}>
    <span>{total} {label.toLowerCase()} · Page {page} of {totalPages}</span>
    <div className="action-row"><button type="button" className="ghost-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button><button type="button" className="ghost-btn" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button></div>
  </nav>;
}

export function AllocatedRoomCard({ room }) {
  const used = Number(room.studentsAssignedToThisBlock ?? room.studentsAssignedToThisRoom ?? 0);
  const capacity = Number(room.roomCapacity || 0);
  const percent = capacity > 0 ? Math.min(100, Math.max(0, used / capacity * 100)) : 0;
  return <article className="cr-room-card">
    <div className="panel-head"><strong>{room.room}</strong><span className={`ops-badge ${isBackupRoom(room) ? 'tone-warning' : 'tone-neutral'}`}>{isBackupRoom(room) ? 'Backup' : 'Normal'}</span></div>
    <p className="cr-room-course">{room.courseCodes || room.placementGroupId}</p>
    <div className="cr-room-seat-count"><strong>{used}</strong><span>students in this allocation</span></div>
    <div className="cr-seat-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
    <dl className="cr-room-facts"><div><dt>Capacity block</dt><dd>{room.capacityMode} · {capacity} seats</dd></div><div><dt>Block total used</dt><dd>{room.blockTotalAssignedStudentsAtThisTime ?? room.roomTotalAssignedStudentsAtThisTime ?? used}</dd></div><div><dt>Block seats remaining</dt><dd>{room.blockRemainingCapacityAtThisTime ?? room.roomRemainingCapacityAtThisTime ?? '—'}</dd></div><div><dt>Physical room total</dt><dd>{room.physicalRoomTotalAssignedStudentsAtThisTime ?? '—'}</dd></div></dl>
  </article>;
}

export default function CourseRoomDetails({ result, rooms, onClose }) {
  if (!result) return null;
  return <section className="panel cr-details" aria-label={`Allocation details for ${result.courseCodes}`}>
    <div className="panel-head"><div><span className="rules-eyebrow">ALLOCATION DETAILS</span><h3>{result.courseCodes}</h3><p>{result.placementGroupId} · {result.date} · {result.start} – {result.end}</p></div><div className="action-row"><PlacementBadge status={result.status} /><button type="button" className="ghost-btn" onClick={onClose}>Close details</button></div></div>
    <div className="cr-detail-summary"><span><strong>{result.totalStudents}</strong> students</span><span><strong>{rooms.length}</strong> room allocations</span><span><strong>{result.shortage || 0}</strong> without seats</span><span><strong>{result.roomPlacementType}</strong> requested type</span></div>
    {result.notes ? <p className="ops-help">{result.notes}</p> : null}
    <div className="cr-room-grid">{rooms.map((room, index) => <AllocatedRoomCard key={`${room.room}|${room.capacityMode}|${index}`} room={room} />)}</div>
    {!rooms.length ? <p className="empty-state">No rooms have been allocated to this group.</p> : null}
  </section>;
}
