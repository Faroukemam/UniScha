import { Link } from 'react-router-dom';

export default function OperationsOverview({ eyebrow, title, description, metrics = [], loading, children }) {
  return <><section className="rules-intro"><div><span className="rules-eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div><div className="action-row">{children}<Link className="ghost-btn" to="/conflict-dashboard">Conflict dashboard</Link></div></section>
    {metrics.length ? <section className="ops-metrics" aria-label={`${title} summary`}>{metrics.map(([label, value, note]) => <div className="ops-metric" key={label}><span>{label}</span><strong>{loading ? '...' : value}</strong>{note ? <small>{note}</small> : null}</div>)}</section> : null}</>;
}

export function CollectionToolbar({ search, onSearch, date, onDate, role, onRole, children }) {
  return <div className="form-grid ops-filters collection-toolbar"><label><span>Search records</span><input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Name, ID, room, or course" /></label>{onDate ? <label><span>Date</span><input type="date" value={date} onChange={(event) => onDate(event.target.value)} /></label> : null}{onRole ? <label><span>Role</span><select value={role} onChange={(event) => onRole(event.target.value)}><option value="">All roles</option><option value="TA">TA</option><option value="Doctor">Doctor</option></select></label> : null}{children}</div>;
}
