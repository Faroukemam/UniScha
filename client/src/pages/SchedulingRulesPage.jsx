import { useState } from 'react';
import { Link } from 'react-router-dom';
import SchedulingPriorities from '../components/SchedulingPriorities';
import OnCallRules from '../components/OnCallRules';

export default function SchedulingRulesPage() {
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [onCallBusy, setOnCallBusy] = useState(false);
  return <div className="page-grid rules-page">
    <section className="rules-intro">
      <div><span className="rules-eyebrow">SCHEDULER CONFIGURATION</span><h2>Set the rules. Shape the schedule.</h2><p>Choose how preferences compete, then define the reserve coverage you need.</p></div>
      <div className="action-row"><Link className="primary-btn" to="/scheduling">Open scheduling <span aria-hidden="true">→</span></Link><Link className="ghost-btn" to="/on-call">On-call coverage</Link></div>
    </section>
    <section className="panel">
      <SchedulingPriorities disabled={onCallBusy} onBusyChange={setPriorityBusy} />
    </section>
    <OnCallRules disabled={priorityBusy} onBusyChange={setOnCallBusy} />
  </div>;
}
