import { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import SessionsPage from './pages/SessionsPage.jsx';
import InvigilatorsPage from './pages/InvigilatorsPage.jsx';
import SchedulingPage from './pages/SchedulingPage.jsx';
import SuperInvigilatorsPage from './pages/SuperInvigilatorsPage.jsx';
import ControlSessionsPage from './pages/ControlSessionsPage.jsx';
import WorkloadPage from './pages/WorkloadPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import DayCoveragePage from './pages/DayCoveragePage.jsx';
import EngagementsPage from './pages/EngagementsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import RoomCapabilityPage from './pages/RoomCapabilityPage.jsx';

const ToastContext = createContext(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const navItems = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/sessions', label: 'Sessions', icon: 'sessions' },
  { to: '/invigilators', label: 'Invigilators', icon: 'staff' },
  { to: '/engagements', label: 'Engagements', icon: 'engagements' },
  { to: '/scheduling', label: 'Scheduling', icon: 'schedule' },
  { to: '/room-capability', label: 'Room Capability', icon: 'capacity' },
  { to: '/day-coverage', label: 'Day Coverage', icon: 'coverage' },
  { to: '/super-invigilators', label: 'Super Invigilators', icon: 'super' },
  { to: '/control-sessions', label: 'CONTROL Session', icon: 'control' },
  { to: '/workload', label: 'Work Load', icon: 'workload' },
  { to: '/reports', label: 'Reports', icon: 'reports' }
];

const pageTitles = {
  '/': 'Dashboard',
  '/sessions': 'Sessions',
  '/invigilators': 'Invigilators',
  '/engagements': 'Engagements',
  '/scheduling': 'Scheduling',
  '/room-capability': 'Room Capability',
  '/day-coverage': 'Day Coverage',
  '/super-invigilators': 'Super Invigilators',
  '/control-sessions': 'CONTROL Session',
  '/workload': 'Work Load',
  '/reports': 'Reports'
};

const pageDescriptions = {
  '/': 'Live overview of staffing coverage, workloads, and exam activity.',
  '/sessions': 'Define rooms, dates, periods, and role-based staffing needs.',
  '/invigilators': 'Manage TA and Doctor pools with workload limits.',
  '/engagements': 'Block unavailable periods before assignment and optimization.',
  '/scheduling': 'Review the assignment grid and run auto-scheduling.',
  '/room-capability': 'Check room capacity, course loads, and session conflicts before assignment.',
  '/day-coverage': 'Inspect daily gaps and pressure points before publishing.',
  '/super-invigilators': 'Manage doctor-only full-day supervision windows.',
  '/control-sessions': 'Assign full-day control coverage for each exam day.',
  '/workload': 'Compare assigned effort and identify imbalance early.',
  '/reports': 'Audit fairness, conflicts, coverage, and schedule readiness.'
};

function NavIcon({ type }) {
  const icons = {
    dashboard: <path d="M4 4h7v7H4zm9 0h7v4h-7zM4 13h4v7H4zm6 3h10v4H10z" />,
    sessions: <path d="M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1m2 6h4m2 0h4m-10 4h4m2 0h4" />,
    staff: <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-7 8a7 7 0 0 1 14 0M19 11a3 3 0 1 0-2.6-4.5M19 20a5 5 0 0 0-3-4.58" />,
    engagements: <path d="M12 7v5l3 3M4 12a8 8 0 1 0 8-8 8 8 0 0 0-8 8m14-8 2 2m-2 16 2-2" />,
    schedule: <path d="M3 5h18v14H3zM3 10h18M8 5v14M14 5v14" />,
    capacity: <path d="M4 20V8l8-4 8 4v12M8 20v-7h8v7M9 9h.01M15 9h.01M12 9h.01M7 20h10" />,
    coverage: <path d="M4 18h16M6 18V9m6 9V5m6 13v-7" />,
    super: <path d="M12 3l2.7 5.46L21 9.27l-4.5 4.39 1.06 6.22L12 17l-5.56 2.88 1.06-6.22L3 9.27l6.3-.81z" />,
    control: <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zm-3 9 2 2 4-4" />,
    workload: <path d="M4 19h16M7 16V9m5 7V5m5 11v-4" />,
    reports: <path d="M5 4h10l4 4v12H5zm10 0v4h4M8 12h8M8 16h8M8 8h3" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    collapse: <path d="M15 6l-6 6 6 6M9 6l-6 6 6 6" />,
    expand: <path d="M9 6l6 6-6 6M15 6l6 6-6 6" />
  };

  return (
    <svg viewBox="0 0 24 24" className="app-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[type]}
    </svg>
  );
}

function Layout({ children }) {
  const location = useLocation();
  const title = pageTitles[location.pathname] || 'Exam Staff Scheduler';
  const description = pageDescriptions[location.pathname] || 'Exam scheduling workspace';
  const [sidebarHidden, setSidebarHidden] = useState(false);

  return (
    <div className={`app-layout${sidebarHidden ? ' sidebar-hidden' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <button
            type="button"
            className="sidebar-toggle sidebar-toggle-desktop"
            onClick={() => setSidebarHidden((current) => !current)}
            aria-label={sidebarHidden ? 'Show navigation' : 'Hide navigation'}
          >
            <NavIcon type={sidebarHidden ? 'expand' : 'collapse'} />
          </button>
        </div>
        <nav className="sidebar-nav">
          <div className="nav-section-label">Main Menu</div>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon-wrap">
                <NavIcon type={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="sidebar-toggle sidebar-toggle-mobile"
              onClick={() => setSidebarHidden((current) => !current)}
              aria-label={sidebarHidden ? 'Show navigation' : 'Hide navigation'}
            >
              <NavIcon type="menu" />
            </button>
            <div className="page-heading">
              <p className="page-eyebrow">MUST Staff Scheduler</p>
              <h1 className="page-title">{title}</h1>
              <p className="page-description">{description}</p>
            </div>
          </div>
          <div className="topbar-right">
            <div className="topbar-badge">
              <span className="topbar-badge-dot" />
              Academic Exam Operations
            </div>
            <div className="topbar-meta">Web Control Panel</div>
          </div>
        </header>
        <div className="content-area">{children}</div>
      </main>
    </div>
  );
}

function Toasts({ toasts, dismissToast }) {
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div className={`toast ${toast.type}`} key={toast.id}>
          <div className="toast-copy">
            <strong className="toast-title">
              {toast.type === 'success' ? 'Success' : toast.type === 'error' ? 'Error' : 'Notice'}
            </strong>
            <span>{toast.message}</span>
          </div>
          <button type="button" onClick={() => dismissToast(toast.id)}>x</button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [toasts, setToasts] = useState([]);

  function addToast(message, type = 'info') {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current, { id, message, type }]);
  }

  function dismissToast(id) {
    setToasts((current) => current.filter((item) => item.id !== id));
  }

  useEffect(() => {
    if (!toasts.length) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  return (
    <ToastContext.Provider value={addToast}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/invigilators" element={<InvigilatorsPage />} />
            <Route path="/engagements" element={<EngagementsPage />} />
            <Route path="/scheduling" element={<SchedulingPage />} />
            <Route path="/room-capability" element={<RoomCapabilityPage />} />
            <Route path="/day-coverage" element={<DayCoveragePage />} />
            <Route path="/super-invigilators" element={<SuperInvigilatorsPage />} />
            <Route path="/control-sessions" element={<ControlSessionsPage />} />
            <Route path="/workload" element={<WorkloadPage />} />
            <Route path="/reports" element={<ReportsPage />} />
          </Routes>
        </Layout>
        <Toasts toasts={toasts} dismissToast={dismissToast} />
      </BrowserRouter>
    </ToastContext.Provider>
  );
}
