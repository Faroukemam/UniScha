# APP_IMPLEMENTATION_REVIEW

## Scope
This document reviews the actual current implementation of the app in the active repository:

- Root: `F:\MUST_TA\schadual group\uni_scha`
- Frontend: React + Vite
- Backend: Node.js + Express
- Shared persistence: SQLite + JSON mirrors
- Solvers: Python OR-Tools CP-SAT

This is an implementation review only. No business logic changes are proposed here, and no implementation claims are made unless they are backed by the current code.

## Executive Summary

### What is already implemented
- The core exam operations platform is implemented across shared tabs:
  - Dashboard
  - Sessions
  - Session Needs
  - Invigilators
  - Engagements
  - Scheduling
  - Super Invigilators
  - Control Sessions
  - Workload
  - Day Coverage
  - Reports
  - Export / Workbook
  - Storage diagnostics
- The shared app now has a stronger storage architecture than the older repo copy:
  - SQLite is treated as a durable primary candidate at startup
  - `store.json` and `store.last-good.json` act as mirrors and recovery sources
  - startup selects the richer valid source
  - shared writes use an async central persistence path
- Scheduling supports:
  - manual assignment
  - auto-schedule via Python CP-SAT
  - locked assignments
  - fallback scheduling when CP-SAT underperforms
  - overlap blocking against engagements, super duties, and control duties
- Course Room Assignment exists as a separate SQLite-native module with:
  - imports
  - solver execution
  - result persistence
  - exports
  - quality reporting

### What is partially implemented
- Shared tabs use the strengthened storage path, but they still read from initialized in-memory state, not live-querying SQLite on every request.
- Session merging exists, but it still merges by exact `Room + Date + Start + End`, not by `Room + Date + Start` with max end-time.
- Reports are implemented, but the frontend still loads many report endpoints in parallel when filters change.
- Course Room Assignment has strong local functionality, but remains separate from shared Scheduling, Dashboard, and Reports.

### What is broken or risky
- Shared app startup and persistence are much safer than the old repo, but there is still conceptual duplication between shared scheduling sessions and course-room session concepts.
- Session/block semantics remain the biggest correctness risk for downstream scheduling and Session Needs matching.
- Course Room Assignment remains architecturally separate, so it can drift from shared operational views.

### What is slow
- Shared tab switching is improved by storage initialization, client caching, and compact scheduling payloads, but the frontend still remounts route pages.
- Reports still fire multiple API requests per filter change.
- Large tables still render whole datasets without pagination or virtualization.
- Course Room Assignment exports and quality views can still be heavy because that module is separate and richer in output detail.

### What is duplicated
- Session-like concepts exist in:
  - shared sessions
  - control sessions
  - course-room availability
- Normalization logic exists in both frontend page helpers and backend routes.
- Export logic is split between:
  - frontend-generated XLSX on several tabs
  - backend workbook generation for shared workbook and course-room workbook

### What is not connected between tabs
- Course Room Assignment does not automatically feed Scheduling, Dashboard, Reports, or Workload.
- On-call staffing is not implemented anywhere.
- Room Capability is an isolated analysis tool and does not persist into shared state.

### What should be fixed first
1. Confirm and standardize session block merge semantics.
2. Reduce duplicated room/session concepts across shared scheduling and course-room assignment.
3. Improve report loading strategy and heavy table rendering.
4. Clarify whether Course Room Assignment should remain separate or feed shared scheduling.
5. Define the on-call staffing model before more workload/report expansion.

### What should not be touched yet
- Do not merge Course Room Assignment into shared Scheduling until room-block semantics and reporting expectations are agreed.
- Do not add on-call duties before confirming how they should affect workload, overlaps, exports, and reports.
- Do not refactor all import/export paths at once before agreeing on identifier and merge rules.

---

## Phase 1 — Repo Map

| Area | File/Folder | Purpose | Notes |
|---|---|---|---|
| Frontend app shell | `client/src/App.jsx` | Routing, navigation, layout, toasts | Route-per-tab. Tabs remount on navigation. |
| Frontend API | `client/src/api.js` | Central API client | Includes GET cache and route wrappers for all shared and course-room endpoints. |
| Frontend pages | `client/src/pages/` | One page per module | Includes all main tabs except a dedicated Storage page. |
| Backend entry | `server/index.js` | Main Express app and route handlers | Shared tab orchestration lives here. |
| Shared store | `server/store.js` | Startup source selection, in-memory state, JSON mirrors, SQLite sync, derived builders | Core storage layer for shared tabs. |
| SQLite layer | `server/db.js` | `sql.js` database init, schema, persistence helpers | Stronger than old repo copy; no destructive drops found here. |
| Reports helpers | `server/reports.js` | Report builders | Uses current shared store state. |
| Course room module | `server/courseRoomAssignment.js` | Separate Course Room Assignment backend | Direct SQLite module, not shared `readStore()` / `writeStore()`. |
| Scheduling solver | `server/scripts/auto_schedule.py` | Python scheduling solver | CP-SAT plus greedy fallback path exists here. |
| Room capability solver | `server/scripts/room_capability.py` | Room capability analysis solver | Separate utility path. |
| Course room wrapper | `server/scripts/course_room_assignment.py` | Python wrapper around auto room assignment | Converts JS payload to solver format. |
| Course room solver | `server/scripts/auto_room_assignment.py` | Python course-room assignment solver | Separate from shared scheduling. |
| Shared SQLite DB | `server/data/scheduler.sqlite` | Durable persistence for shared app and course-room tables | Shared store can rebuild from this. |
| Shared JSON mirror | `server/data/store.json` | Mirror/export/recovery file | Not the only startup source. |
| Last-good mirror | `server/data/store.last-good.json` | Backup/recovery mirror | Used in startup source selection. |
| Samples | `sample/`, `sample_1/`, `sample_2/` | Import templates and scenario data | `sample_2` contains `session_needs_template.xlsx` and linked room session files. |
| Documentation | `SCHEDULING_WALKTHROUGH.md`, `STORAGE_ARCHITECTURE.md`, `COURSE_ROOM_SOLVER_PROPOSAL.txt`, `APP_WALKTHROUGH.txt`, `PROJECT_PROPOSAL.txt` | Existing design and walkthrough docs | Actual implementation should still be checked against code. |

---

## Phase 2 — Module-By-Module Implementation

## Module: Dashboard

### Frontend
- files:
  - `client/src/pages/DashboardPage.jsx`
- main state:
  - `data.totals`
  - `data.openNeeds`
  - `data.dayWindows`
- API calls:
  - `api.getDashboard()`
- render behavior:
  - Loads once on mount.
  - Shows global counts and daily windows.

### Backend
- endpoints:
  - `GET /api/dashboard`
- helper functions:
  - `readStore()`
  - `getDayWindows()`
  - `buildSchedulingView()`

### Data Flow
- reads from:
  - initialized in-memory shared store
- writes to:
  - none
- sync behavior:
  - no writes on read

### Current Status
- implemented:
  - session/staff/assignment counts
  - open needs
  - day windows
- partially implemented:
  - no Course Room Assignment metrics
- missing:
  - no on-call metrics
- risky:
  - dashboard reflects only shared scheduling data, not course-room data

### Performance Notes
- low to medium
- depends on compact scheduling summary, not full eligibility payload

## Module: Sessions

### Frontend
- files:
  - `client/src/pages/SessionsPage.jsx`
- main state:
  - `sessions`
  - edit form state
- API calls:
  - `getSessions`
  - `createSession`
  - `updateSession`
  - `deleteSession`
  - `deleteAllSessions`
  - `importSessionsRows`
  - `importSessionNeedsRows`
- render behavior:
  - Loads list once on mount.
  - Uses frontend XLSX import/export helpers.

### Backend
- endpoints:
  - `GET /api/sessions`
  - `POST /api/sessions`
  - `PUT /api/sessions/:id`
  - `DELETE /api/sessions/:id`
  - `DELETE /api/sessions`
  - `POST /api/import/sessions`
  - `POST /api/import/session-needs`
- helper functions:
  - `normalizeImportedSessions()`
  - `mergeSessionRowsByRoomTime()`
  - `extractSessionDemand()`
  - `buildSessionTimeRoomKey()`

### Data Flow
- reads from:
  - shared initialized store
- writes to:
  - central `writeStore()`
- sync behavior:
  - persisted to SQLite and both JSON mirrors through central persistence

### Current Status
- implemented:
  - CRUD
  - sessions import
  - session needs import
  - template/export
- partially implemented:
  - merge rule is exact `date + start + end + room`, not max-end room block
- missing:
  - no dedicated Session Needs page
- risky:
  - future session-block logic change will affect imports, matching, and scheduling

### Performance Notes
- moderate for large lists
- no pagination or virtualization

## Module: Session Needs

### Frontend
- files:
  - handled inside `client/src/pages/SessionsPage.jsx`
- main state:
  - embedded in session objects
- API calls:
  - `importSessionNeedsRows`

### Backend
- endpoints:
  - `POST /api/import/session-needs`
- helper functions:
  - `extractSessionDemand()`
  - session matching logic in route

### Data Flow
- reads from:
  - current sessions
- writes to:
  - shared session rows

### Current Status
- implemented:
  - import
  - update count + unmatched summary
- partially implemented:
  - matching depends on current session identity logic
- missing:
  - no dedicated review UI
- risky:
  - merge semantics and needs matching are coupled

### Performance Notes
- low runtime cost
- correctness risk is more important than speed here

## Module: Invigilators

### Frontend
- files:
  - `client/src/pages/InvigilatorsPage.jsx`
- API calls:
  - CRUD
  - `importInvigilatorsRows`
- render behavior:
  - loads once on mount
  - splits TA and Doctor lists

### Backend
- endpoints:
  - `GET /api/invigilators`
  - `POST /api/invigilators`
  - `PUT /api/invigilators/:id`
  - `DELETE /api/invigilators/:id`
  - `DELETE /api/invigilators`
  - `POST /api/import/invigilators`
- helper functions:
  - `normalizeInvigilatorRow()`
  - `normalizeRole()`
  - `normalizeLoadType()`

### Data Flow
- reads from:
  - shared store
- writes to:
  - central `writeStore()`

### Current Status
- implemented:
  - CRUD
  - import/export/template
- partially implemented:
  - role normalization maps unknown values toward TA fallback behavior unless route validation rejects them
- missing:
  - no separate validation report UI
- risky:
  - role normalization policy should be explicitly confirmed with owner

### Performance Notes
- low backend cost
- large lists still fully rendered

## Module: Engagements

### Frontend
- files:
  - `client/src/pages/EngagementsPage.jsx`
- API calls:
  - CRUD
  - `getInvigilators`
  - `importEngagementRows`

### Backend
- endpoints:
  - `GET /api/engagements`
  - `POST /api/engagements`
  - `PUT /api/engagements/:id`
  - `DELETE /api/engagements/:id`
  - `DELETE /api/engagements`
  - `POST /api/import/engagements`
- helper functions:
  - `normalizeEngagementRow()`

### Data Flow
- reads from:
  - shared store
- writes to:
  - central `writeStore()`

### Current Status
- implemented:
  - CRUD
  - import/export/template
- partially implemented:
  - `engagement = 1` is the real blocker flag; other values remain stored but are not hard blockers
- missing:
  - no diagnostics for inactive or malformed rows
- risky:
  - staff references use `staffId`, while many other places use app invigilator ids

### Performance Notes
- low

## Module: Scheduling

### Frontend
- files:
  - `client/src/pages/SchedulingPage.jsx`
- main state:
  - compact session rows
  - selected session
  - on-demand eligibility lists
- API calls:
  - `getScheduling`
  - `getSchedulingEligible(sessionId)`
  - `assignToSession`
  - `removeSessionAssignment`
  - `removeAllSessionAssignments`
  - `autoSchedule`
- render behavior:
  - compact scheduling payload first
  - eligibility fetched only for selected session

### Backend
- endpoints:
  - `GET /api/scheduling`
  - `GET /api/scheduling/session/:sessionId/eligible`
  - `POST /api/scheduling/assign`
  - `DELETE /api/scheduling/assign/:id`
  - `DELETE /api/scheduling/assign`
  - `POST /api/scheduling/auto-schedule`
- helper functions:
  - `buildSchedulingView()`
  - `getEligibilityForSession()`
  - auto-schedule payload builder in `server/index.js`
  - Python solver: `server/scripts/auto_schedule.py`

### Data Flow
- reads from:
  - shared initialized store
- writes to:
  - central `writeStore()`
- sync behavior:
  - manual and auto assignments persist to SQLite, `store.json`, `store.last-good.json`, and in-memory state

### Current Status
- implemented:
  - manual scheduling
  - overlap checks
  - max-hours checks
  - super/control/engagement blocking
  - locked assignments
  - CP-SAT solver
  - greedy fallback schedule
  - save diagnostics from auto-schedule route
- partially implemented:
  - shortage diagnostics are basic, not deep
- missing:
  - no on-call staffing
- risky:
  - business fairness priorities inside fallback vs CP-SAT selection should be confirmed

### Performance Notes
- compacted payload reduces main tab cost
- on-demand eligibility reduces response size substantially
- remaining cost is UI rendering and repeated mount behavior

## Module: Super Invigilators

### Frontend
- files:
  - `client/src/pages/SuperInvigilatorsPage.jsx`
- API calls:
  - `getSuperInvigilators`
  - `assignSuperInvigilator`
  - `removeSuperInvigilator`
  - `removeAllSuperInvigilators`

### Backend
- endpoints:
  - `GET /api/super-invigilators`
  - `POST /api/super-invigilators/assign`
  - `DELETE /api/super-invigilators/:id`
  - `DELETE /api/super-invigilators`

### Data Flow
- reads from:
  - sessions
  - invigilators
  - super assignments
- writes to:
  - shared store via central persistence

### Current Status
- implemented:
  - one or more doctor assignments per day window
  - day window derived from first session start to last session end
- partially implemented:
  - no dedicated import/export for super assignments
- missing:
  - no owner-confirmed fairness/workload treatment beyond current implementation
- risky:
  - depends on session-day model correctness

### Performance Notes
- low

## Module: Control Sessions

### Frontend
- files:
  - `client/src/pages/ControlSessionsPage.jsx`
- API calls:
  - `getControlSessions`
  - CRUD
  - `assignControlSession`
  - `removeControlSessionAssignment`
  - `removeAllControlSessions`
  - `importControlSessionsRows`

### Backend
- endpoints:
  - `GET /api/control-sessions`
  - `POST /api/control-sessions`
  - `PUT /api/control-sessions/:id`
  - `DELETE /api/control-sessions/:id`
  - `DELETE /api/control-sessions`
  - `POST /api/control-sessions/assign`
  - `DELETE /api/control-sessions/assign/:id`
  - `POST /api/import/control-sessions`
- helper functions:
  - `normalizeControlSessionRow()`
  - `normalizeControlAssignmentRow()`

### Data Flow
- reads from:
  - shared store
- writes to:
  - central `writeStore()`

### Current Status
- implemented:
  - control session CRUD
  - role-based assignment
  - import/export/template
- partially implemented:
  - separate session-like model instead of one unified session type
- missing:
  - no detailed conflict diagnostics page
- risky:
  - duplicated session concepts

### Performance Notes
- moderate due to mixed payload of sessions, staff, and assignments

## Module: Workload

### Frontend
- files:
  - `client/src/pages/WorkloadPage.jsx`
- API calls:
  - `getWorkload`

### Backend
- endpoints:
  - `GET /api/workload`
- helper functions:
  - `buildWorkloadView()`
  - `getDayWindows()`

### Data Flow
- reads from:
  - assignments
  - super assignments
  - control assignments
  - sessions/control sessions
- writes to:
  - none

### Current Status
- implemented:
  - combined workload minutes and counts
- partially implemented:
  - no on-call support
- missing:
  - no manual-vs-auto split
- risky:
  - depends on consistent persistence of all duty types

### Performance Notes
- low to moderate

## Module: Day Coverage

### Frontend
- files:
  - `client/src/pages/DayCoveragePage.jsx`
- API calls:
  - `getDayCoverage`

### Backend
- endpoints:
  - `GET /api/day-coverage`
- helper functions:
  - shared day-window + scheduling summary logic

### Data Flow
- reads from:
  - shared sessions
  - current assignments
  - super/control assignments
- writes to:
  - none

### Current Status
- implemented:
  - daily remaining TA/Doctor view
  - super/control counts
- partially implemented:
  - no on-call coverage
- missing:
  - no per-day drill-down
- risky:
  - tied to current session-day semantics

### Performance Notes
- low

## Module: Reports

### Frontend
- files:
  - `client/src/pages/ReportsPage.jsx`
- API calls:
  - `getInvigilators`
  - multiple `/api/reports/*` endpoints in parallel
- render behavior:
  - filters trigger `Promise.all` over many endpoints
  - CSV/XLSX export generated client-side

### Backend
- endpoints:
  - `/api/reports/summary`
  - `/api/reports/workload`
  - `/api/reports/fairness`
  - `/api/reports/daily-coverage`
  - `/api/reports/conflicts`
  - `/api/reports/staff/:staffId`
  - `/api/reports/session-coverage`
  - `/api/reports/utilization`
  - `/api/reports/quality-score`
- helper functions:
  - report builders in `server/reports.js`

### Data Flow
- reads from:
  - current shared store
- writes to:
  - none

### Current Status
- implemented:
  - multiple report families
- partially implemented:
  - route-level cache may exist only implicitly through current app state and endpoint structure; frontend still performs many requests
- missing:
  - no on-call reporting
  - no course-room reporting integration
- risky:
  - still the heaviest shared reporting page from a network/request-count perspective

### Performance Notes
- medium to high due to many requests, not because one response is huge

## Module: Room Capability

### Frontend
- files:
  - `client/src/pages/RoomCapabilityPage.jsx`
- API calls:
  - `optimizeRoomCapability`
- render behavior:
  - page-local imports
  - explicit optimization action

### Backend
- endpoints:
  - `POST /api/room-capability/optimize`
- helper functions:
  - Python solver invocation via `server/scripts/room_capability.py`

### Data Flow
- reads from:
  - request payload only
- writes to:
  - none

### Current Status
- implemented:
  - separate analysis tool
- partially implemented:
  - not tied to shared storage
- missing:
  - no persistent shared model
- risky:
  - duplicates room/session concepts outside scheduling and course-room assignment

### Performance Notes
- heavy only when explicitly run

## Module: Course Room Assignment

### Frontend
- files:
  - `client/src/pages/CourseRoomAssignmentPage.jsx`
- API calls:
  - `getCourseRoomAssignment`
  - `getCourseRoomQuality`
  - course-room import/run/manual/export routes

### Backend
- endpoints:
  - `/api/course-room-assignment*`
- route handlers:
  - `server/index.js` delegating to `server/courseRoomAssignment.js`
- helper functions:
  - `loadInputs()`
  - `loadResults()`
  - `runCourseRoomAssignment()`
  - `exportCourseRoomAssignment()`
  - `getCourseRoomQuality()`

### Data Flow
- reads from:
  - dedicated course-room SQLite tables
- writes to:
  - dedicated course-room SQLite tables
- sync behavior:
  - separate from shared `writeStore()`

### Current Status
- implemented:
  - imports
  - solver execution
  - results persistence
  - quality report
  - exports
- partially implemented:
  - still separate from shared tabs
- missing:
  - no direct feedback loop into shared Sessions or Reports
- risky:
  - duplicate architecture and room model

### Performance Notes
- heavier than most shared tabs
- still likely to benefit from summary-first and detail-on-demand patterns

## Module: Export / Workbook

### Frontend
- files:
  - several pages export directly with `xlsx`
- API calls:
  - `exportWorkbook`
  - `exportData`

### Backend
- endpoints:
  - `GET /api/export/workbook`
  - `GET /api/data/export`
- helper functions:
  - workbook sheet builders in `server/index.js`
  - course-room workbook builders in `server/courseRoomAssignment.js`

### Data Flow
- reads from:
  - shared store for main workbook
  - course-room SQLite for course-room workbook

### Current Status
- implemented:
  - shared workbook export
  - course-room workbook export
  - page-level frontend exports
- partially implemented:
  - duplicated export strategies remain
- missing:
  - unified export architecture
- risky:
  - drift between frontend and backend export formats

### Performance Notes
- explicit on demand
- should not be part of normal tab-load path

## Module: Storage Status / Debug Tools

### Frontend
- files:
  - `client/src/api.js` contains `getStorageStatus()`
- note:
  - no dedicated UI page found in current frontend pages

### Backend
- endpoints:
  - `GET /api/system/storage-status`
- helper functions:
  - `getStorageStatus()`
  - `getStartupStorageInfo()`

### Data Flow
- reads from:
  - startup storage metadata
  - SQLite counts
  - `store.json`
  - `store.last-good.json`
- writes to:
  - none

### Current Status
- implemented:
  - full diagnostic endpoint with source selection, file state, counts, warnings, and health
- partially implemented:
  - no visible frontend dashboard/debug card found yet
- missing:
  - no dedicated admin UI for this endpoint
- risky:
  - none relative to old repo; this area is materially stronger here

### Performance Notes
- low

---

## Phase 3 — Storage Implementation Review

### What is the current source of truth?
For shared tabs, the live runtime source is the initialized in-memory `storeState` in `server/store.js`.

At startup, that in-memory state is selected from the richer valid source by `initStoreFromPrimary()`, comparing:
- SQLite-derived store
- `store.json`
- `store.last-good.json`

### Is SQLite truly the primary live source?
Not as a direct live read source for every request.

In this repo, SQLite is:
- a startup-primary candidate
- the durable persistence layer for shared data
- the direct read/write store for Course Room Assignment

During normal tab switching, shared tabs read from initialized memory through `readStore()`, not by querying SQLite every time.

### What does `readStore()` actually do?
`readStore()`:
- returns a clone of in-memory `storeState` if already initialized
- if not initialized:
  - attempts `store.json`
  - then `store.last-good.json`
  - otherwise seeds empty store

### What does `writeStore()` actually do?
`writeStore(data)`:
1. clones and normalizes the snapshot
2. serializes writes through `writeQueue`
3. syncs SQLite first
4. writes `store.json`
5. writes `store.last-good.json`
6. updates in-memory `storeState`

This is materially stronger than the old repo copy.

### Does `readStore()` read from memory, JSON, or SQLite during normal tab switching?
- after startup initialization: memory
- it does not re-read JSON or reconstruct SQLite on each tab switch

### Does `writeStore()` update SQLite, JSON mirrors, and memory?
Yes.
- SQLite: yes
- `store.json`: yes
- `store.last-good.json`: yes
- in-memory state: yes

### Is `writeStore()` async?
Yes.

### Are all `writeStore()` calls awaited?
Shared app write routes in `server/index.js` generally use:
- `persistStoreResponse(res, store, payload)`

That function waits on `writeStore(store)` and returns a write error if persistence fails.

### Which routes still bypass central persistence?
Shared app routes generally do not bypass it.

The intentional separate path is:
- `server/courseRoomAssignment.js`
  - direct SQLite reads/writes
  - not part of shared `readStore()` / `writeStore()`

### Does Course Room Assignment use separate SQLite logic?
Yes.

It reads/writes course-room tables directly and maintains its own metadata and results.

### What happens when JSON is corrupted?
Shared startup logic can recover using:
- `store.last-good.json`
- SQLite if it is richer or if JSON is meaningfully empty

### What happens when SQLite is empty?
If SQLite is empty but JSON mirrors are richer:
- `initStoreFromPrimary()` promotes JSON into SQLite

### What happens on startup?
1. `server/index.js` calls `initStoreFromPrimary()`
2. Startup source is selected by comparing JSON and SQLite richness
3. JSON mirrors may be rebuilt from SQLite
4. SQLite may be promoted from JSON
5. Startup summary is logged

### What happens on normal writes?
Shared write route:
- mutates store snapshot
- calls `persistStoreResponse()`
- that awaits `writeStore()`
- persistence updates SQLite, both JSON mirrors, then memory

### Storage Diagram

```mermaid
flowchart TD
  A[Frontend Tab] --> B[Express Route]
  B --> C[readStore()]
  C --> D[Initialized in-memory storeState]
  D --> E[Derived builder / route response]
  E --> F[JSON response]

  G[Write Route] --> H[Mutate shared store snapshot]
  H --> I[persistStoreResponse]
  I --> J[writeStore async]
  J --> K[SQLite sync]
  J --> L[store.json mirror]
  J --> M[store.last-good.json mirror]
  J --> N[storeState update]

  O[Course Room Routes] --> P[server/courseRoomAssignment.js]
  P --> K
```

### Storage Review Conclusion
- This repo has the stronger storage architecture.
- SQLite is not used as a per-request live read source for shared tabs, but it is a startup-primary candidate and durable store.
- Shared tab reads use initialized in-memory state after startup.
- Course Room Assignment is still intentionally separate.

---

## Phase 4 — API Endpoint Inventory

The main endpoint inventory is below. Shared write routes generally use `persistStoreResponse()` and therefore await central persistence.

| Method | Path | Module | Reads | Writes | Uses readStore? | Uses writeStore? | Heavy? | Notes |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/dashboard` | Dashboard | shared store | no | yes | no | medium | Uses scheduling summary. |
| GET | `/api/system/storage-status` | Storage | SQLite + JSON mirrors + startup info | no | no | no | low | Full diagnostics endpoint. |
| GET | `/api/sessions` | Sessions | shared store | no | yes | no | low | Returns current shared sessions. |
| POST | `/api/sessions` | Sessions | shared store | shared store | yes | yes | low | Central persistence. |
| PUT | `/api/sessions/:id` | Sessions | shared store | shared store | yes | yes | low | Central persistence. |
| DELETE | `/api/sessions/:id` | Sessions | shared store | shared store | yes | yes | low | Also clears related assignments. |
| DELETE | `/api/sessions` | Sessions | shared store | shared store | yes | yes | low | Also clears assignments and super assignments. |
| GET | `/api/invigilators` | Invigilators | shared store | no | yes | no | low | |
| POST | `/api/invigilators` | Invigilators | shared store | shared store | yes | yes | low | |
| PUT | `/api/invigilators/:id` | Invigilators | shared store | shared store | yes | yes | low | |
| DELETE | `/api/invigilators/:id` | Invigilators | shared store | shared store | yes | yes | low | Also clears linked duties/engagements. |
| DELETE | `/api/invigilators` | Invigilators | shared store | shared store | yes | yes | low | |
| GET | `/api/engagements` | Engagements | shared store | no | yes | no | low | |
| POST | `/api/engagements` | Engagements | shared store | shared store | yes | yes | low | |
| PUT | `/api/engagements/:id` | Engagements | shared store | shared store | yes | yes | low | |
| DELETE | `/api/engagements/:id` | Engagements | shared store | shared store | yes | yes | low | |
| DELETE | `/api/engagements` | Engagements | shared store | shared store | yes | yes | low | |
| GET | `/api/scheduling` | Scheduling | shared store | no | yes | no | medium | Compact scheduling view. |
| POST | `/api/scheduling/assign` | Scheduling | shared store | shared store | yes | yes | medium | Manual assignment. |
| DELETE | `/api/scheduling/assign/:id` | Scheduling | shared store | shared store | yes | yes | medium | Manual unassign. |
| DELETE | `/api/scheduling/assign` | Scheduling | shared store | shared store | yes | yes | medium | Clear all assignments. |
| POST | `/api/scheduling/auto-schedule` | Scheduling | shared store + Python | shared store | yes | yes | heavy | CP-SAT + fallback save path. |
| GET | `/api/super-invigilators` | Super | shared store | no | yes | no | low | |
| POST | `/api/super-invigilators/assign` | Super | shared store | shared store | yes | yes | low | |
| DELETE | `/api/super-invigilators/:id` | Super | shared store | shared store | yes | yes | low | |
| DELETE | `/api/super-invigilators` | Super | shared store | shared store | yes | yes | low | |
| GET | `/api/control-sessions` | Control | shared store | no | yes | no | medium | Returns sessions, invigilators, assignments. |
| POST | `/api/control-sessions` | Control | shared store | shared store | yes | yes | medium | |
| PUT | `/api/control-sessions/:id` | Control | shared store | shared store | yes | yes | medium | |
| DELETE | `/api/control-sessions/:id` | Control | shared store | shared store | yes | yes | medium | |
| DELETE | `/api/control-sessions` | Control | shared store | shared store | yes | yes | medium | |
| POST | `/api/control-sessions/assign` | Control | shared store | shared store | yes | yes | medium | |
| DELETE | `/api/control-sessions/assign/:id` | Control | shared store | shared store | yes | yes | medium | |
| GET | `/api/workload` | Workload | shared store | no | yes | no | medium | |
| GET | `/api/day-coverage` | Day Coverage | shared store | no | yes | no | medium | |
| POST | `/api/import/sessions` | Sessions import | request rows | shared store | yes | yes | medium | Merge + normalization path. |
| POST | `/api/import/session-needs` | Session Needs import | request rows + shared sessions | shared store | yes | yes | medium | Matching-sensitive. |
| POST | `/api/import/control-sessions` | Control import | request rows | shared store | yes | yes | medium | |
| POST | `/api/import/invigilators` | Invigilators import | request rows | shared store | yes | yes | medium | |
| POST | `/api/import/engagements` | Engagements import | request rows | shared store | yes | yes | medium | |
| POST | `/api/data/load-sample` | Sample loader | files + shared store | shared store | yes | yes | medium | |
| GET | `/api/export/workbook` | Workbook export | shared store | no | yes | no | heavy on demand | Shared workbook builder. |
| GET | `/api/data/export` | Data export | shared store | no | yes | no | medium | |
| POST | `/api/data/import` | Workbook import | request workbook data | shared store | yes | yes | medium | Central workbook import. |
| DELETE | `/api/data/reset` | Global reset | shared store | shared store | yes | yes | medium | |
| GET | `/api/reports/summary` | Reports | shared store | no | yes | no | medium | |
| GET | `/api/reports/workload` | Reports | shared store | no | yes | no | medium | |
| GET | `/api/reports/fairness` | Reports | shared store | no | yes | no | medium | |
| GET | `/api/reports/daily-coverage` | Reports | shared store | no | yes | no | medium | |
| GET | `/api/reports/conflicts` | Reports | shared store | no | yes | no | medium | |
| GET | `/api/reports/staff/:staffId` | Reports | shared store | no | yes | no | medium | |
| GET | `/api/reports/session-coverage` | Reports | shared store | no | yes | no | medium | |
| GET | `/api/reports/utilization` | Reports | shared store | no | yes | no | medium | |
| GET | `/api/reports/quality-score` | Reports | shared store | no | yes | no | medium | |
| POST | `/api/room-capability/optimize` | Room Capability | request payload + Python | no | no | no | heavy | Separate analysis tool. |
| GET | `/api/course-room-assignment` | Course Room | dedicated SQLite | no | no | no | medium | Separate module. |
| GET | `/api/course-room-assignment/quality` | Course Room | dedicated SQLite | no | no | no | medium | |
| POST | `/api/course-room-assignment/import-schedule` | Course Room | dedicated SQLite | dedicated SQLite | no | no | medium | |
| POST | `/api/course-room-assignment/import-room-sessions` | Course Room | dedicated SQLite | dedicated SQLite | no | no | medium | |
| POST | `/api/course-room-assignment/import-room-capacity` | Course Room | dedicated SQLite | dedicated SQLite | no | no | medium | |
| POST | `/api/course-room-assignment/run` | Course Room | dedicated SQLite + Python | dedicated SQLite | no | no | heavy | |
| POST | `/api/course-room-assignment/manual-assign` | Course Room | dedicated SQLite | dedicated SQLite | no | no | medium | |
| DELETE | `/api/course-room-assignment/results` | Course Room | dedicated SQLite | dedicated SQLite | no | no | low | |
| GET | `/api/course-room-assignment/export` | Course Room | dedicated SQLite | no | no | no | heavy on demand | |
| GET | `/api/course-room-assignment/export-unassigned` | Course Room | dedicated SQLite | no | no | no | medium | |

### Endpoint Review Notes
- Shared write routes are materially safer here because they await central persistence.
- Storage diagnostics are implemented.
- Course Room Assignment intentionally bypasses shared `readStore()` / `writeStore()`.

---

## Phase 5 — Data Model Review

| Entity | Fields | ID/key | Stored in SQLite? | Stored in JSON? | Used by tabs |
|---|---|---|---|---|---|
| Session | `id`, `courseName`, `courseNames`, `room`, `date`, `startTime`, `endTime`, `taNeeded`, `doctorNeeded`, `totalNeeded`, `notes` | app session id | yes | yes | Sessions, Scheduling, Dashboard, Workload, Day Coverage, Reports |
| SessionNeed | embedded in Session | session id | yes as session columns | yes as session fields | Sessions, Scheduling, Dashboard, Day Coverage |
| Invigilator | `id`, `staffId`, `name`, `email`, `role`, `loadType`, `maxHours`, `department`, `notes` | app invigilator id + business `staffId` | yes | yes | Invigilators, Scheduling, Engagements, Super, Control, Workload, Reports |
| Engagement | `id`, `staffId`, `date`, `startTime`, `endTime`, `engagement`, `notes` | app engagement id | yes | yes | Engagements, Scheduling, Reports |
| Assignment | `id`, `sessionId`, `invigilatorId`, `role` | app assignment id | yes | yes | Scheduling, Dashboard, Workload, Day Coverage, Reports |
| SuperAssignment | `id`, `date`, `invigilatorId` | app assignment id | yes | yes | Super, Scheduling blocking, Workload, Day Coverage, Reports |
| ControlSession | `id`, `courseName`, `courseNames`, `room`, `date`, `startTime`, `endTime`, `taNeeded`, `doctorNeeded`, `totalNeeded`, `notes` | app control session id | yes | yes | Control Sessions, Scheduling blocking, Workload, Day Coverage, Reports |
| ControlAssignment | `id`, `controlSessionId`, `invigilatorId`, `role` | app assignment id | yes | yes | Control Sessions, Scheduling blocking, Workload, Day Coverage, Reports |
| Workload summary | `rows`, `dayWindows` | derived | no | no | Workload |
| Day coverage summary | per-day rows | derived | no | no | Day Coverage |
| Report data | summary/workload/fairness/etc | derived | no | no | Reports |
| Course room input course row | course code, students, period, placement type, linking fields | SQLite row id | yes | no | Course Room Assignment |
| Course room input availability row | room/date/start/end | SQLite row id | yes | no | Course Room Assignment |
| Course room input capacity row | room, caps, room type, autoAvailable | SQLite row id | yes | no | Course Room Assignment |
| Course room result | placement group summary | `placement_group_id` | yes | no | Course Room Assignment |
| Course room result room row | placement group + room detail | SQLite row id | yes | no | Course Room Assignment |
| On-call data | not found | n/a | no | no | none |

### Entity linkage notes
- Shared sessions use app-generated ids like `ses...` or restored DB-derived ids like `ses_db_<id>`.
- Assignments link to sessions by `sessionId` and staff by `invigilatorId`.
- Engagements use `staffId`, not app invigilator `id`.
- Super and Control duties are converted into busy-time constraints for Scheduling.
- Course Room Assignment data is separated from the shared scheduling model.

---

## Phase 6 — Import And Normalization Review

### Sessions import
- endpoint:
  - `POST /api/import/sessions`
- expected columns:
  - room
  - date
  - start
  - end
- optional:
  - course codes/names
  - notes
  - needs if present
- normalization:
  - `normalizeDate()`
  - `normalizeTime()`
  - `normalizeCourseNames()`
  - `extractSessionDemand()`
- merge:
  - `normalizeImportedSessions()` / `mergeSessionRowsByRoomTime()`
  - key = exact `date + start + end + room`

### Session Needs import
- endpoint:
  - `POST /api/import/session-needs`
- expected columns:
  - `SessionID`
  - `Room`
  - `Date`
  - `Start`
  - `End`
  - `TANeeded`
  - `DoctorNeeded`
  - `InvigilatorsNeeded`
- matching:
  - by id if possible
  - by exact room/time key fallback
  - course-aware matching support exists in route logic
- summary:
  - updated count
  - unmatched rows

### Invigilators import
- endpoint:
  - `POST /api/import/invigilators`
- expected columns:
  - `StaffID`, `Name`, `Email`, `Role`, `LoadType`, `MaxHours`, `Department`, `Notes`
- normalization:
  - `normalizeInvigilatorRow()`
  - `normalizeRole()`
  - `normalizeLoadType()`

### Engagements import
- endpoint:
  - `POST /api/import/engagements`
- expected columns:
  - `StaffID`, `Date`, `Start`, `End`, `Engagement`, `Notes`
- normalization:
  - `normalizeEngagementRow()`

### Workbook import
- endpoint:
  - `POST /api/data/import`
- behavior:
  - accepts workbook-like payload and normalizes it into shared entities
- storage path:
  - central `writeStore()`

### Control Sessions import
- endpoint:
  - `POST /api/import/control-sessions`
- normalization:
  - `normalizeControlSessionRow()`

### Assignments import
- no dedicated separate assignments import route found

### Super import
- no dedicated separate super import route found

### Control Assignments import
- no dedicated separate control assignment import route found

### Course Room Assignment imports
- endpoints:
  - `/api/course-room-assignment/import-schedule`
  - `/api/course-room-assignment/import-room-sessions`
  - `/api/course-room-assignment/import-room-capacity`
- handled separately in `server/courseRoomAssignment.js`

### Import review conclusions
1. Date/time normalization is present on backend and in some frontend import helpers.
2. Session demand extraction is more explicit here than in the old repo copy.
3. Session Needs import is still tightly coupled to session identity semantics.
4. Unknown-role policy should still be owner-confirmed even though normalization exists.
5. Course Room imports are separate and do not share the shared-store normalization path.

---

## Phase 7 — Scheduling Implementation Review

### 1. How sessions are loaded
- `GET /api/scheduling`
- backend calls `buildSchedulingView(readStore())`

### 2. How TA/Doctor needs are calculated
- stored on session rows:
  - `taNeeded`
  - `doctorNeeded`
  - `totalNeeded`
- scheduling view computes assigned vs remaining per role

### 3. How current assignments are loaded
- from `store.assignments`

### 4. How remaining needs are calculated
- in `buildSchedulingView()`
- `taRemaining` and `doctorRemaining` are computed per session

### 5. How eligible candidates are calculated
- current shared helper:
  - `getEligibilityForSession(store, session, person, assignedMinutesByInvigilator)`
- checks:
  - already assigned
  - blocked engagement
  - overlapping session assignment
  - overlapping super duty
  - overlapping control duty
  - max-hours overflow

### 6. How manual assignment works
- route:
  - `POST /api/scheduling/assign`
- behavior:
  - role capacity checked
  - duplicate checked
  - overlap and max-hours checked through eligibility
  - assignment persisted through central write path

### 7. What hard checks exist
- manual path:
  - duplicate
  - role count full
  - overlap
  - engagement
  - max-hours
- solver path:
  - role-specific demand
  - blocked engagements
  - no overlapping duties
  - max-hours
  - locked assignment validity

### 8. How auto-schedule builds solver payload
- route:
  - `POST /api/scheduling/auto-schedule`
- payload includes:
  - shared sessions
  - invigilators
  - engagements
  - synthetic busy duties from super assignments
  - synthetic busy duties from control assignments
  - `locked_assignments` from current assignments

### 9. How locked assignments are passed
- current assignments are converted to solver format with:
  - `staff_id`
  - `session_id`
  - `role`

### 10. How solver result is selected
- `auto_schedule.py` can produce:
  - CP-SAT result
  - fallback greedy result
- helper `is_better_schedule(candidate, baseline)` compares:
  - lower shortage
  - fewer uncovered sessions
  - more placed assignments

### 11. How CP-SAT and greedy fallback interact
- if CP-SAT does not produce a strong enough result, fallback can be used
- fallback respects:
  - locked assignments
  - overlap
  - max-hours
  - engagements

### 12. How solver results are persisted
- shared route maps solver assignments back to app ids
- updates `store.assignments`
- persists through `writeStore()`

### 13. How shortages are calculated
- Python solver returns `uncovered_sessions`
- JS route returns uncovered sessions and save summary

### 14. Whether shortage diagnostics exist
- basic diagnostics exist:
  - uncovered sessions
  - missing TA/Doctor counts
  - route returns assignment counts before/after and remaining shortages
- no deep diagnostic model per rejection path

### 15. Whether manual assignments survive auto-schedule
- yes, because they are passed as locked assignments

### 16. Whether super/control duties block scheduling
- yes
- both in JS eligibility checks and solver payload generation

### 17. Whether max-hours are enforced
- yes

### Scheduling Flow Diagram

```mermaid
flowchart TD
  A[Scheduling Page] --> B[GET /api/scheduling]
  B --> C[buildSchedulingView(readStore())]
  C --> D[Compact session view]

  A --> E[Select session]
  E --> F[Client-side eligibility lookup from current payload / helper usage]

  A --> G[POST /api/scheduling/assign]
  G --> H[persistStoreResponse]
  H --> I[writeStore]

  A --> J[POST /api/scheduling/auto-schedule]
  J --> K[Build Python payload]
  K --> L[auto_schedule.py]
  L --> M[CP-SAT result]
  L --> N[Greedy fallback result]
  M --> O[Best result selection]
  N --> O
  O --> I
```

### Scheduling Performance Bottlenecks
- still likely:
  - frontend full table rendering
  - session-by-session interactions
  - large datasets under route remounts
- improved already:
  - compact scheduling representation
  - fallback avoids some zero-duty solver failures

---

## Phase 8 — Session Merging And Room Block Logic

Expected target operational rule from owner notes:
- same `Room + Date + Start` should be one room occupation block
- end should be max end
- course codes merged uniquely

### Current implementation
That is **not** what the code currently does.

Current merge key:
- `date`
- `start`
- `end`
- `room`

Found in:
- `server/index.js`
  - `buildSessionTimeRoomKey()`
  - `normalizeImportedSessions()`
  - `mergeSessionRowsByRoomTime()`
- `server/store.js`
  - `normalizeStoreSessions()`

### Does it apply to dedicated sessions import?
Yes.

### Does it apply to workbook import?
Yes, because workbook import ultimately normalizes into shared session entities using the same key pattern.

### Does it apply to scheduling view?
Yes. Scheduling reads already-normalized shared sessions.

### Does it apply to export?
Yes. Shared exports reflect the current session objects after exact-end merge.

### Does Session Needs matching still work after max-end merging?
Current Session Needs matching is tied to the current identity model. If session merge becomes `same room/date/start => max end`, Session Needs matching must change with it.

### Review conclusion
- Desired room-block merging is not currently implemented.
- Current behavior is exact window merging.
- This is a high-priority correctness decision because it affects:
  - session import
  - session needs matching
  - scheduling
  - exports
  - control of day windows

---

## Phase 9 — On-Call Staffing Review

Expected operational rule from owner notes:
- 1 on-call TA for every 3 active rooms
- 1 on-call Doctor for every 6 active rooms

### Review result
1. On-call data model present?
   - no
2. On-call need calculation present?
   - no
3. On-call assignment present?
   - no
4. On-call included in workload?
   - no
5. On-call included in reports?
   - no
6. On-call exported?
   - no
7. On-call respects overlaps and max-hours?
   - not applicable; no model exists

### Recommended implementation path
Do not implement now. When added, likely change areas:
- `server/store.js`
- `server/index.js`
- `server/reports.js`
- `server/scripts/auto_schedule.py`
- Scheduling, Workload, Day Coverage, and Reports frontend pages

---

## Phase 10 — Reports / Dashboard / Workload Review

### Dashboard
- counts shown:
  - sessions
  - invigilators
  - doctors
  - TAs
  - assigned session duties
  - super assignments
  - control assignments
  - engagements
  - open needs
- uses current assignments?
  - yes
- uses current sessions?
  - yes

### Workload
- counts all assignment types?
  - yes:
    - session duties
    - super duties
    - control duties
- includes manual and auto assignments?
  - yes
- includes on-call?
  - no

### Day Coverage
- calculates shortages?
  - yes
- grouped by day?
  - yes
- includes super/control counts?
  - yes

### Reports
- reports exist for:
  - summary
  - workload
  - fairness
  - daily coverage
  - conflicts
  - staff
  - session coverage
  - utilization
  - quality score
- uses current persisted data?
  - yes
- heavy?
  - moderate to high due to many API calls
- cached?
  - storage path is efficient; frontend still issues many requests

| Tab | Uses current assignments? | Uses current sessions? | Uses current staff? | Performance risk | Notes |
|---|---|---|---|---|---|
| Dashboard | yes | yes | yes | low-medium | Shared summary only. |
| Workload | yes | yes | yes | medium | Includes super/control duties. |
| Day Coverage | yes | yes | indirectly | medium | Uses shared scheduling state. |
| Reports | yes | yes | yes | high | Multiple endpoint fan-out on filter change. |

---

## Phase 11 — Course Room Assignment Review

### 1. Shared store or separate?
Separate SQLite-native module.

### 2. Input tables
- `course_room_courses`
- `course_room_availability`
- `course_room_capacity`

### 3. Result tables
- `course_room_results`
- `course_room_result_rooms`
- `course_room_validation_errors`
- `course_room_meta`

### 4. Endpoints
- `/api/course-room-assignment`
- `/api/course-room-assignment/quality`
- `/api/course-room-assignment/import-schedule`
- `/api/course-room-assignment/import-room-sessions`
- `/api/course-room-assignment/import-room-capacity`
- `/api/course-room-assignment/run`
- `/api/course-room-assignment/manual-assign`
- `/api/course-room-assignment/results`
- `/api/course-room-assignment/export`
- `/api/course-room-assignment/export-unassigned`

### 5. Solver script
- JS backend module calls:
  - `server/scripts/course_room_assignment.py`
- wrapper delegates to:
  - `server/scripts/auto_room_assignment.py`

### 6. Linked groups
- passed through wrapper fields:
  - `LinkedGroup`
  - `LinkedCourses`
- actual grouping handled in Python solver

### 7. Major/minor capacity
- stored in capacity rows:
  - `MinorCap`
  - `MajorCap`
- solver logic lives in `auto_room_assignment.py`

### 8. AutoAvailable backup rooms
- stored in capacity rows
- quality report and solver settings include backup usage logic

### 9. Exports
- backend workbook generation exists in `server/courseRoomAssignment.js`
- unassigned export exists separately

### 10. Does it affect Scheduling sessions?
No direct linkage found.

### 11. Does its data appear in Dashboard/Reports/Room Capability?
- Dashboard: no direct integration
- Reports: no direct integration
- Room Capability: no direct integration

### Risks
- separate architecture
- duplicated room/session concepts
- duplicate reporting/export patterns
- no automatic operational synchronization with shared scheduling

---

## Phase 12 — Performance Review

| Area | Potential bottleneck | Evidence from code | Severity | Suggested fix |
|---|---|---|---|---|
| Reports page | Many parallel API calls on filter change | `ReportsPage.jsx` `Promise.all` over many endpoints | P2 | Bundle or stage report loading. |
| Route remounting | Tabs remount on navigation | `App.jsx` route-per-page mount pattern | P2 | Preserve tab state or strengthen client cache usage. |
| Large tables | Full render without pagination | Sessions, Workload, Control, Reports tables render all rows | P2 | Add pagination or virtualization. |
| Session semantics | Exact-end merge may be wrong for room blocks | exact key in `buildSessionTimeRoomKey()` and `normalizeStoreSessions()` | P1 | Confirm and align room-block rule. |
| Course Room module | Separate heavy module | direct SQLite path + rich results/exports | P2 | Summary-first loading and clear module boundary. |
| Export duplication | Frontend and backend both generate workbooks | page-local `xlsx` plus backend workbook routes | P3 | Unify export strategy later. |
| On-call gap | Not implemented | no model found in store, routes, solver, or reports | P2 | Add only after core model is stable. |

### Existing performance support
- Shared storage reads are now cheap after startup because `readStore()` serves initialized memory.
- `client/src/api.js` has GET cache.
- Scheduling is no longer dependent on full embedded eligible lists for all sessions.

### Suggested performance strategy
- keep storage initialization model
- add pagination/virtualization
- reduce report endpoint fan-out
- keep export generation on explicit user action only

---

## Phase 13 — Current Risks And Bug List

| Priority | Area | Issue | Impact | Suggested fix |
|---|---|---|---|---|
| P1 | Session model | Session merge is still exact-window, not start-block max-end | wrong room-block semantics can propagate to needs and scheduling | confirm and align merge/matching/export logic |
| P1 | Architecture | Course Room Assignment remains disconnected from shared tabs | inconsistent operational picture across modules | define integration boundary |
| P2 | Reports | Reports page performs many API calls on each filter change | slow tab experience | stage or bundle report loads |
| P2 | UI rendering | Large tables render all rows | tab switching and render lag | add pagination/virtualization |
| P2 | On-call | No on-call model exists | operational gap | add in later phase after model decisions |
| P2 | Export strategy | Mixed frontend/backend workbook generation | maintenance drift | unify later |
| P3 | Normalization duplication | Similar date/time/course parsing exists in multiple files | inconsistent handling risk | centralize utilities later |
| P3 | Session/control duplication | Control sessions are a separate model | duplicated logic and potential drift | decide whether to unify or keep separate |

---

## Phase 14 — Implementation Roadmap

## Phase 1 — Confirm session block semantics
- tasks:
  - decide whether session blocks merge by `Room + Date + Start`
  - update imports, normalization, and needs matching accordingly
- files:
  - `server/index.js`
  - `server/store.js`
  - `client/src/pages/SessionsPage.jsx`
- risk:
  - high correctness sensitivity
- expected output:
  - one consistent room occupation model
- verification:
  - import scenarios with same room/date/start and different end

## Phase 2 — Clarify module boundaries
- tasks:
  - decide whether Course Room Assignment stays separate
  - document what, if anything, should flow into Scheduling, Dashboard, and Reports
- files:
  - `server/courseRoomAssignment.js`
  - `server/index.js`
  - documentation
- risk:
  - medium-high
- expected output:
  - explicit integration contract

## Phase 3 — Optimize tab loading and rendering
- tasks:
  - reduce report fan-out
  - add pagination/virtualization to large tables
  - preserve useful tab state where possible
- files:
  - `client/src/pages/ReportsPage.jsx`
  - `client/src/pages/SessionsPage.jsx`
  - `client/src/pages/WorkloadPage.jsx`
  - `client/src/pages/ControlSessionsPage.jsx`
- risk:
  - medium
- expected output:
  - faster tab switching and data appearance

## Phase 4 — Improve scheduling diagnostics
- tasks:
  - deepen shortage diagnostics
  - expose clearer reasons for uncovered sessions
  - document fallback vs CP-SAT result selection clearly in UI
- files:
  - `server/index.js`
  - `server/scripts/auto_schedule.py`
  - `client/src/pages/SchedulingPage.jsx`
- risk:
  - medium
- expected output:
  - more explainable scheduling outcomes

## Phase 5 — Add on-call staffing
- tasks:
  - add data model
  - add calculations
  - integrate into solver, workload, day coverage, reports, exports
- files:
  - `server/store.js`
  - `server/index.js`
  - `server/reports.js`
  - `server/scripts/auto_schedule.py`
  - frontend pages
- risk:
  - medium-high
- expected output:
  - operationally complete staffing model

## Phase 6 — Cleanup reports and exports
- tasks:
  - unify export strategy
  - reduce duplicate workbook builders
  - decide how course-room data should appear in broader reporting
- files:
  - `server/index.js`
  - `server/reports.js`
  - `server/courseRoomAssignment.js`
  - frontend export code
- risk:
  - medium
- expected output:
  - more maintainable reporting/export surface

---

## Questions For Owner Review

1. Should sessions always merge by `Room + Date + Start` with `End = max(End)`?
2. Should Session Needs attach to room blocks or original course rows?
3. Should on-call staff count as workload hours?
4. Should on-call staff block normal invigilation at the same time?
5. Should Course Room Assignment feed Sessions automatically?
6. Should Reports include Course Room Assignment data?
7. Should Super Invigilators count in Doctor workload and fairness?
8. Should Control Session duties count in workload and fairness exactly like session duties?
9. Should fallback scheduling be accepted if it improves coverage but is less fair?
10. Should unknown staff roles be rejected or mapped manually during import?
11. Should Control Sessions remain a separate model or become a specialized session type?
12. Should Room Capability remain a standalone analysis tool or write back into shared room/session planning?

---

## Final Review Position

This repo is in a better implementation state than the old copy in two important ways:
- shared storage is materially safer
- scheduling has fallback logic and stronger persistence handling

The main remaining risks are no longer basic persistence failures. They are:
- room/session semantics
- duplicated module boundaries
- missing on-call model
- multi-request report loading
- large-table rendering

Those are the next decisions that should be made before broader feature expansion.
