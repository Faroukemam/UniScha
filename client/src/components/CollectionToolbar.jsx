export default function CollectionToolbar({ search, onSearch, date, onDate, role, onRole, count, children }) {
  return <div className="collection-toolbar"><div className="form-grid ops-filters">
    <label><span>Search records</span><input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Name, ID, room, or course" /></label>
    {onDate ? <label><span>Date</span><input type="date" value={date} onChange={(event) => onDate(event.target.value)} /></label> : null}
    {onRole ? <label><span>Role</span><select value={role} onChange={(event) => onRole(event.target.value)}><option value="">All roles</option><option value="TA">TA</option><option value="Doctor">Doctor</option></select></label> : null}
    {children}
  </div><p className="ops-help">{count} matching records. Imports and exports use their original full-data scope.</p></div>;
}
