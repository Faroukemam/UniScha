# Full App Project Proposal

## 1. Executive Summary

This project delivers a University Exam Operations Management System designed to centralize and control the operational workflow for exam sessions, invigilator staffing, workload balancing, reporting, and room-based scheduling support. The platform combines a React frontend, a Node.js/Express backend, SQLite persistence, mirrored JSON recovery files, and Python-based optimization for safe scheduling analysis and controlled assignment workflows.

The system is needed because university exam operations are typically managed through fragmented spreadsheets, manual coordination, and ad hoc last-minute changes. That approach increases the risk of staffing conflicts, unfair workload distribution, poor reporting visibility, inconsistent room usage, and difficult recovery when data is edited incorrectly.

The current implementation provides operational value in five main areas:
- reducing manual scheduling effort through structured assignment workflows and solver-assisted planning
- improving fairness by moving scheduling analysis toward actual hours, not only duty counts
- preventing conflicts across exam duties, engagements, on-call duties, super duties, and control duties
- improving reporting, coverage visibility, and workload analysis
- supporting Excel-based university workflows while adding safe preview and dry-run review before applying changes

The app is already implemented as a working operational platform with shared scheduling modules, separate course-room assignment support, safe preview/export paths, assignment locking controls, staff hour policy management, and recovery-aware storage.

## 2. Background and Problem Statement

University exam operations usually involve a large number of sessions across different dates, rooms, and durations. Staffing is not uniform because some sessions are short while others are much longer, some dates have dense room activity, and TAs and Doctors have different responsibilities and expected workloads.

The main operational challenges addressed by this system are:
- a large number of exam sessions across many rooms and days
- sessions with different durations, meaning equal duty counts do not imply equal workload
- multiple room periods that must be represented correctly by actual occupied room blocks
- TAs and Doctors with different workload expectations and constraints
- staff unavailability on specific dates and times
- unfair manual distribution when scheduling is based on visibility rather than measured load
- error-prone spreadsheet editing and duplication
- difficult last-minute changes when preserving some assignments but changing others
- inconsistent reporting across staffing, coverage, and fairness dimensions

The system also distinguishes three different operational concepts that are often confused in manual workflows:

- **Engagements**: specific dates and time ranges during which a staff member is unavailable
- **Staff Hour Policy**: total workload targets, limits, exclusions, or adjustments at the staff level
- **Locking**: protection for existing assignments so they are preserved during selective rebalance workflows

Those distinctions are important because they affect different parts of the assignment logic. An engagement blocks a specific period. A staff hour policy shapes total load. A lock protects an existing assignment from solver replacement.

## 3. Project Goals

The current project goals are:

1. Centralize exam operations data in one managed platform.
2. Import and export Excel files safely for operational use.
3. Manage sessions and staffing needs consistently.
4. Manage invigilators and their TA/Doctor roles.
5. Prevent scheduling conflicts before assignments are applied.
6. Support both manual assignment and automatic scheduling.
7. Balance workload by actual hours, not only number of duties.
8. Support staff-specific hour policies and exclusions.
9. Support on-call staffing as a first-class operational workflow.
10. Support preview and dry-run analysis before applying auto-schedule changes.
11. Preserve locked, manual, imported, and legacy assignments where required.
12. Generate operational reports, summaries, and exports.
13. Keep storage safe, inspectable, and recoverable.

## 4. System Modules

### 4.1 Dashboard

**Purpose**
- Provide an operational summary of the current exam scheduling state.

**Key features**
- session and assignment counts
- shared scheduling summary metrics
- on-call summary metrics
- staff hour policy summary metrics

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: shared store sessions, assignments, on-call summary, staff hour policy summary
- Outputs: summary cards and dashboard metrics

### 4.2 Sessions

**Purpose**
- Manage the master set of exam session blocks used by shared scheduling.

**Key features**
- create, edit, delete sessions
- Excel import/export support
- normalized block-based session representation

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: session data, imported workbook rows
- Outputs: normalized shared session list

### 4.3 Session Needs

**Purpose**
- Represent TA and Doctor staffing requirements attached to sessions.

**Key features**
- per-session TA need
- per-session Doctor need
- total need support
- matching logic across imports and normalized blocks

**Current implementation status**
- Implemented as part of shared session import/normalization flow

**Key inputs / outputs**
- Inputs: session needs workbook rows
- Outputs: normalized need values attached to shared sessions

### 4.4 Invigilators

**Purpose**
- Maintain the staff roster used by scheduling and reporting.

**Key features**
- staff ID, name, role, department, max hours, notes
- TA and Doctor role separation
- Excel import/export support

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: staff rows, invigilator management UI
- Outputs: invigilator records used across scheduling, workload, and reports

### 4.5 Engagements

**Purpose**
- Record date/time-specific staff unavailability.

**Key features**
- engagement creation and deletion
- date/time conflict blocking
- Excel import/export support

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: date/time engagement rows
- Outputs: unavailability periods used by assignment validation and solver payloads

### 4.6 Scheduling

**Purpose**
- Operate the main exam assignment workflow.

**Key features**
- compact scheduling API
- session-level assignment display
- manual assignment and removal
- per-session eligible candidates on demand
- source and lock metadata display

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: sessions, assignments, invigilators, policies, engagements
- Outputs: compact scheduling view and session-level assignment actions

### 4.7 Auto-Schedule Preview

**Purpose**
- Run safe solver previews without changing live assignments.

**Key features**
- dry-run preview endpoint
- preview mode support
- role-scope support
- preview export workbook
- solver diagnostics

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: current store, preview mode, role scope
- Outputs: solver diagnostics, assignment comparison, preview export workbook

### 4.8 Assignment Lock Management

**Purpose**
- Control which existing assignments are protected from solver replacement.

**Key features**
- per-assignment lock/unlock
- bulk lock/unlock by assignment ids
- bulk lock/unlock by filter
- lock plan Excel export/import

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: assignment metadata, lock filters, lock plan workbook
- Outputs: updated `locked` metadata used by `preserve_manual_only`

### 4.9 Staff Hour Policy

**Purpose**
- Control staff-level workload targets, limits, and exclusions.

**Key features**
- policy modes: default, exact, add, reduce, exclude
- workload target calculation
- import/export support
- workload/dashboard/report integration

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: staff hour policy records and workbook rows
- Outputs: effective allowed/target workload model per staff member

### 4.10 On-Call Staffing

**Purpose**
- Manage reserve staffing by active room periods.

**Key features**
- exact-period need calculation
- on-call assignments
- eligibility and conflict validation
- export integration
- dedicated UI

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: active room periods, on-call assignments, invigilators
- Outputs: on-call periods, shortages, and assignments

### 4.11 Super Invigilators

**Purpose**
- Manage doctor-only super invigilator duties by day window.

**Key features**
- per-day assignment
- doctor-only eligibility enforcement
- conflict validation

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: doctor roster, day windows
- Outputs: super assignment records and conflicts

### 4.12 Control Sessions

**Purpose**
- Manage control sessions and control-session assignments separately from regular exam sessions.

**Key features**
- control session CRUD
- TA/Doctor assignment handling
- conflict validation

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: control sessions, control assignments
- Outputs: control session scheduling state

### 4.13 Workload

**Purpose**
- Show the total assigned load per staff member.

**Key features**
- assignment minutes and hours
- session, on-call, super, and control counts
- staff hour policy comparison
- target difference reporting

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: all shared duty sources
- Outputs: per-staff workload rows

### 4.14 Day Coverage

**Purpose**
- Summarize daily staffing coverage and shortage.

**Key features**
- daily aggregate session needs
- daily aggregate on-call need summary
- assigned vs remaining need

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: sessions, assignments, on-call periods, on-call assignments
- Outputs: daily aggregate coverage rows

### 4.15 Reports

**Purpose**
- Provide decision-support views for scheduling quality and workload fairness.

**Key features**
- summary
- workload
- fairness
- daily coverage
- conflicts
- session coverage
- utilization
- quality score
- staff-specific reporting

**Current implementation status**
- Implemented, with progressive frontend loading

**Key inputs / outputs**
- Inputs: shared store and derived workload/coverage views
- Outputs: report sections and export-ready metrics

### 4.16 Room Capability

**Purpose**
- Support room capability optimization workflows.

**Key features**
- room capability optimizer endpoint

**Current implementation status**
- Implemented as a separate backend flow

**Key inputs / outputs**
- Inputs: room capability payload
- Outputs: optimization result

### 4.17 Course Room Assignment

**Purpose**
- Allocate courses to rooms using a separate room-capacity and placement workflow.

**Key features**
- separate data import
- room capacities
- linked groups
- quality report
- exports

**Current implementation status**
- Implemented as a separate module

**Key inputs / outputs**
- Inputs: course schedule rows, room availability, room capacity
- Outputs: room assignment results, quality analysis, exports

### 4.18 Excel Import / Export

**Purpose**
- Maintain compatibility with operational spreadsheet workflows.

**Key features**
- shared workbook export
- shared workbook import
- preview export
- staff hour policy import/export
- lock plan export/import
- course-room exports

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: workbook rows, import templates
- Outputs: operational workbooks and validated import summaries

### 4.19 Storage Status / Recovery

**Purpose**
- Show system storage health and support recovery visibility.

**Key features**
- startup source detection
- SQLite / JSON mirror counts
- warnings and health output
- recovery-aware initialization

**Current implementation status**
- Implemented

**Key inputs / outputs**
- Inputs: SQLite state, store.json, store.last-good.json
- Outputs: storage health report and startup selection summary

## 5. Scheduling Logic

The current scheduling logic is based on normalized room occupation blocks, not raw unmerged import rows.

### Session Block Logic

Shared scheduling sessions use the block key:
- `Room + Date + Start`

Within a merged block:
- `End` becomes the maximum `End`
- course codes/names are merged uniquely
- Session Needs are attached to the normalized session

This means the shared scheduling model treats a room occupied from the same start time as a single operational block for assignment purposes.

### Need Logic

Each session stores:
- `taNeeded`
- `doctorNeeded`
- `totalNeeded`

The current real dataset is already normalized to this block model.

### Assignment Creation and Validation

Manual assignment creation validates:
- role compatibility
- session overlap with existing exam assignments
- engagements
- super duties
- control duties
- on-call duties
- max hours
- staff hour policy exclusion or limit checks

### Assignment Metadata

Assignments currently include:
- `assignmentSource`
  - `manual`
  - `auto`
  - `import`
  - `legacy`
- `locked`
- `createdAt`
- `updatedAt`
- `notes`

### Preservation Behavior

Locked assignments are preserved by protected modes.
Unlocked assignments may be replaced depending on:
- preview mode
- role scope

The explicit `locked` field is the preservation decision for `preserve_manual_only`.

## 6. Staff Hour Policy

This feature exists because balancing only by duty count is not operationally fair when sessions have different durations. A staff member assigned two short sessions may have much less real workload than another staff member assigned one long session and one medium session.

### Why Hour-Based Fairness Is Needed

The system therefore calculates fairness using actual assigned minutes and hours. This affects workload visibility and auto-schedule behavior.

### Role-Based Average Hours

Average hours are calculated separately for:
- TAs
- Doctors

The system calculates total required minutes by role using actual session duration and session staffing demand.

### Policy Modes

Supported policy modes are:
- `default`
- `exact`
- `add`
- `reduce`
- `exclude`

### Operational Meaning

- `default`: use the role average
- `exact`: set an exact allowed or target hours value
- `add`: role average plus added hours
- `reduce`: role average minus reduced hours, not below zero
- `exclude`: exclude from auto-schedule and block manual assignment

### Effects on the System

Staff hour policy affects:
- manual assignment validation
- auto-schedule solver payload and fairness behavior
- workload reporting
- dashboard metrics
- reports summary and fairness visibility

### Excel Support

The feature has import/export support with workbook-driven policy rows.

### Difference From Engagements

This distinction is important:
- **Engagements** block specific times.
- **Staff Hour Policy** controls total workload or exclusion.

They are separate operational controls and are not treated as the same feature.

## 7. Auto-Schedule and Solver Behavior

The auto-schedule engine uses a Python OR-Tools CP-SAT solver with a greedy fallback solver. The backend builds the solver payload from the current normalized shared store.

### Current Solver Behavior

The solver payload includes:
- sessions
- invigilators
- engagements
- busy-time equivalents generated from:
  - super duties
  - control duties
  - on-call assignments
- locked assignments
- staff hour policies
- solver options

### Result Selection Safety

The current solver path restores CP-SAT versus fallback comparison:
- CP-SAT runs when available
- fallback also runs
- both results are compared
- the better result is selected by priority

### Result Selection Priority

Comparison priority is:
1. lower total staffing shortage
2. fewer uncovered sessions
3. more placed duties
4. fewer policy violations
5. fewer over-limit staff
6. better hour spread
7. lower duty count spread only after hours are considered

Coverage dominates fairness. The system does not prefer a fairer result if it leaves more shortage than another valid result.

### Solver Diagnostics

The system returns:
- `selectedSolver`
- `cpSatStatus`
- `fallbackStatus`
- `selectionReason`
- selected, CP-SAT, and fallback metrics

### Role Scope

The current implementation supports:
- `both`
- `ta_only`
- `doctor_only`

### Preview Mode

The current implementation supports:
- `preserve_all`
- `preserve_manual_only`
- `rebalance_all`

### Safe Usage Note

The save-based auto-schedule route exists, but it should be used only after preview review, export review, and backup confirmation. This proposal does not assume approved live use of save-based auto-schedule.

## 8. Auto-Schedule Preview and Safe Workflow

The current platform supports a safe dry-run workflow:

1. Review current assignments.
2. Lock assignments that must not change.
3. Unlock assignments that may be rebalanced.
4. Run preview using one of:
   - `preserve_all`
   - `preserve_manual_only`
   - `rebalance_all`
5. Select role scope:
   - both
   - TAs only
   - Doctors only
6. Export preview result to Excel.
7. Review:
   - assignments to keep
   - assignments to create
   - assignments to remove
   - staff hour comparison
   - over-target staff
   - under-target staff
   - solver diagnostics
8. Apply only after approval and backup.

Important safety points:
- preview does not write data
- preview export does not write data
- dry-run does not modify SQLite
- dry-run does not modify `store.json`
- dry-run does not modify `store.last-good.json`

## 9. Assignment Lock Management

Assignment lock management exists to control preservation before selective rebalance.

### Purpose

- locked assignment = protected from change in protected modes
- unlocked assignment = eligible for solver replacement when mode and role scope allow it

### Source Types

Assignments can be labeled as:
- `legacy`
- `manual`
- `auto`
- `import`

### Current Tools

Implemented tools include:
- per-assignment lock/unlock
- bulk lock/unlock by assignment ids
- bulk lock/unlock by filter
- lock plan export
- lock plan import

### Lock Plan Workflow

The lock plan export includes an `AssignmentLockPlan` workbook sheet. Users can edit `NewLocked` in Excel and re-import the plan. This is intended to make large-scale preservation planning practical.

### Operational Benefit

This is especially important for `preserve_manual_only` preview, because that mode depends on the `locked` field to decide which assignments stay fixed and which can be rebalanced.

## 10. On-Call Staffing

The platform supports operational on-call staffing using exact active room periods.

### On-Call Rule

- 1 on-call TA for every 3 active rooms
- 1 on-call Doctor for every 6 active rooms

### Exact Period Logic

Active room periods are calculated using:
- `Date + Start + End`

The system does not stretch all rooms to the longest day window when calculating on-call needs.

### Day Coverage Behavior

On-call needs are exact-period in the on-call module and daily aggregate in Day Coverage.

### On-Call Assignments

On-call assignments are persisted and are treated as busy time in scheduling validation.

### Integration

On-call is integrated into:
- workload
- day coverage
- reports
- workbook export

## 11. Course Room Assignment

Course Room Assignment is implemented as a separate but related operational module.

### Purpose

Its purpose is to allocate exam courses into physical rooms based on:
- room capacities
- room types
- availability
- linked groups
- shortage handling

### Current Capabilities

- import course schedule rows
- import room availability
- import room capacities
- solver-based assignment run
- manual adjustment support
- quality reporting
- export and unassigned export

### Separate Status

This module currently remains separate from shared staffing scheduling:
- it has its own SQLite-native tables
- it has a distinct solver and result model
- it is not yet merged into the shared scheduling store

### Future Integration

A future architectural decision can determine whether Course Room Assignment remains separate or is integrated more deeply with shared scheduling workflows.

## 12. Reporting and Dashboards

The current reporting layer supports operational decision-making through:
- dashboard metrics
- workload reports
- fairness reports
- daily coverage
- session coverage
- utilization
- quality score
- conflicts
- on-call shortage
- staff hour policy metrics

These outputs support:
- leadership review
- committee planning
- staffing fairness analysis
- operational shortage visibility
- export-driven formal review

The frontend report loading has already been improved so summary data appears first and detail sections load progressively.

## 13. Data Storage and Recovery

The current storage architecture is recovery-oriented.

### Shared Scheduling Storage

Shared tabs use a central store backed by:
- SQLite durable persistence: `server/data/scheduler.sqlite`
- JSON mirror: `server/data/store.json`
- backup JSON mirror: `server/data/store.last-good.json`

### In-Memory Runtime State

The backend initializes in-memory shared state from the selected startup source and uses central write persistence for updates.

### Startup Source Selection

The system records startup source and storage health, including:
- startup source
- SQLite counts
- JSON mirror counts
- warnings

### Storage Status Endpoint

The backend exposes:
- `GET /api/system/storage-status`

This is used to verify alignment and health.

### Recovery Characteristics

The current codebase includes recovery-aware initialization and health verification. This supports operational confidence, especially before major scheduling changes.

### Separate Course Room Storage

Course Room Assignment uses separate SQLite-native tables even though it lives in the same backend project.

## 14. Excel Import / Export Workflows

Excel compatibility is a major requirement because university operations often depend on spreadsheet-based review and signoff.

The current implementation supports major workflows including:
- sessions import/export
- session needs support through workbook flows
- invigilators import/export
- engagements import/export
- staff hour policies import/export
- on-call needs/assignments export
- assignment lock plan export/import
- auto-schedule preview export
- full shared workbook export
- Course Room Assignment import/export

This allows the platform to integrate into existing university administrative processes instead of replacing them abruptly.

## 15. Technology Stack

Current implementation stack:
- React + Vite frontend
- Node.js + Express backend
- SQLite persistence
- JSON mirrors for shared store recovery
- Python OR-Tools CP-SAT solver
- greedy fallback scheduler
- Excel workbook import/export using `xlsx`
- local deployment and local operation workflow

## 16. Current Implementation Status

| Feature | Status | Notes |
|---|---|---|
| Dashboard | Implemented | Includes on-call and staff hour policy summary metrics |
| Sessions | Implemented | Shared normalized session blocks |
| Session Needs | Implemented | Attached through normalized session logic |
| Invigilators | Implemented | TA/Doctor roster with Excel support |
| Engagements | Implemented | Time-based unavailability |
| Scheduling UI | Implemented | Compact API, manual assignment, eligible-on-demand |
| Auto-Schedule Preview | Implemented | Dry-run only, no persistence |
| Preview Export | Implemented | Multi-sheet workbook export |
| Save-Based Auto-Schedule | Implemented | Should be used only after preview and backup approval |
| Assignment Metadata | Implemented | Source, lock, timestamps, notes |
| Assignment Lock Management | Implemented | Per-assignment, bulk, filter, lock plan export/import |
| Staff Hour Policy | Implemented | Policy model, API, UI, workload/report/dashboard integration |
| Hour-Based Solver Fairness | Implemented | Uses assigned minutes/hours, not only duty count |
| Solver Result Comparison | Implemented | CP-SAT vs fallback result selection restored |
| Role Scope | Implemented | both / ta_only / doctor_only for preview and future save use |
| On-Call Staffing | Implemented | Exact-period derived need and assignment support |
| Super Invigilators | Implemented | Doctor-only daily supervision |
| Control Sessions | Implemented | Separate control-session assignment flow |
| Workload | Implemented | Includes on-call, super, control, and hour policy context |
| Day Coverage | Implemented | Daily aggregate coverage including on-call summary |
| Reports | Implemented | Progressive frontend loading already added |
| Room Capability | Implemented | Separate optimizer endpoint |
| Course Room Assignment | Implemented | Separate module with its own solver and exports |
| Storage Status / Recovery | Implemented | SQLite + JSON mirror health and startup selection |
| Frontend Bundle Optimization | Partially implemented | Functional build passes, but Vite bundle warning remains |
| On-Call Assignment Import | Planned / Future | Export exists; import flow is limited |
| Live Auto-Schedule Validation | Needs validation | Dry-run and preview are validated; live save-based use still needs careful approval |

## 17. Limitations and Risks

The current system is operational, but the following limits and risks remain:

- live auto-schedule must be used carefully
- large rebalance previews can change many assignments
- preview export should be reviewed before applying any live solver result
- staff hour policies can significantly alter distribution
- current live assignments may still be over target because they predate the hour-policy feature
- Course Room Assignment remains a separate subsystem
- frontend bundle warning remains
- on-call assignment import is still limited compared with export support
- assignment source metadata is new and must be preserved consistently
- role-scoped scheduling still requires operator review because preserving one role while rebalancing the other can produce operational side effects that are valid but must be understood

## 18. Recommended Future Phases

Recommended next phases are:

1. Final safe apply workflow and rollback validation.
2. Live-data backup and restore testing.
3. Course Room Assignment integration decision.
4. Frontend bundle code splitting and chunk reduction.
5. More advanced staff fairness reporting.
6. Optional on-call assignment import.
7. Additional role-specific optimization enhancements.
8. User authentication and audit trail if institutional policy requires it.
9. Deployment packaging and operational release process.

## 19. Acceptance Criteria

The platform should be considered ready for controlled operational use when the following remain true:

- storage status is healthy
- SQLite and JSON mirror counts are consistent
- preview does not modify live data
- preview export works
- lock plan export/import works
- staff hour policy affects preview diagnostics and scheduling behavior
- on-call counts are correct
- reports and export show expected data
- regression scripts pass
- frontend build passes

## 20. Appendix

### Main API Endpoints

Key implemented endpoints include:

- `GET /api/dashboard`
- `GET /api/system/storage-status`
- `GET /api/sessions`
- `GET /api/invigilators`
- `GET /api/engagements`
- `GET /api/scheduling`
- `GET /api/scheduling/session/:sessionId/eligible`
- `POST /api/scheduling/assign`
- `PATCH /api/scheduling/assign/:id/lock`
- `PATCH /api/scheduling/assign/bulk-lock`
- `PATCH /api/scheduling/assign/lock-by-filter`
- `GET /api/scheduling/assign/lock-plan/export`
- `POST /api/scheduling/assign/lock-plan/import`
- `POST /api/scheduling/auto-schedule-preview`
- `POST /api/scheduling/auto-schedule-preview/export`
- `POST /api/scheduling/auto-schedule`
- `GET /api/on-call`
- `GET /api/on-call/eligible`
- `POST /api/on-call/assign`
- `GET /api/staff-hour-policies`
- `POST /api/staff-hour-policies`
- `POST /api/import/staff-hour-policies`
- `GET /api/export/staff-hour-policies`
- `GET /api/workload`
- `GET /api/day-coverage`
- `GET /api/reports/summary`
- `GET /api/course-room-assignment`
- `GET /api/course-room-assignment/quality`
- `GET /api/export/workbook`

### Main Verification Scripts

- `node server/scripts/verify_session_block_merge.js`
- `node server/scripts/validate_session_block_real_data.js`
- `node server/scripts/verify_on_call.js`
- `node server/scripts/verify_staff_hour_policy.js`
- `node server/scripts/verify_auto_schedule_preview.js`
- `node server/scripts/verify_auto_schedule_preview_export.js`
- `node server/scripts/verify_assignment_metadata.js`
- `node server/scripts/verify_assignment_locking.js`
- `node server/scripts/verify_assignment_lock_management.js`
- `node server/scripts/verify_auto_schedule_role_scope.js`
- `python -m py_compile server/scripts/auto_schedule.py`

### Key Commands

```powershell
node server/scripts/verify_session_block_merge.js
node server/scripts/validate_session_block_real_data.js
node server/scripts/verify_on_call.js
node server/scripts/verify_staff_hour_policy.js
node server/scripts/verify_auto_schedule_preview.js
node server/scripts/verify_auto_schedule_preview_export.js
node server/scripts/verify_assignment_metadata.js
node server/scripts/verify_assignment_locking.js
node server/scripts/verify_assignment_lock_management.js
node server/scripts/verify_auto_schedule_role_scope.js
python -m py_compile server/scripts/auto_schedule.py
cd client
npm run build
```

### Current Stable Counts

The following counts are from the current active dataset and may change after future imports or approved rebalance operations:

- sessions: `359`
- sessionNeeds: `359`
- invigilators: `149`
- assignments: `1151`
- on-call periods: `83`
- on-call shortage:
  - TA: `157`
  - Doctor: `109`
  - Total: `266`
- course-room results: `238`
- course-room result room rows: `649`

## Conclusion

The current codebase already functions as a substantial University Exam Operations Management System with safe preview-driven scheduling analysis, assignment protection controls, hour-based fairness support, on-call staffing, Excel compatibility, recovery-aware storage, and separate course-room planning capability. The remaining work is not foundational system creation; it is operational hardening, cautious live-apply governance, performance cleanup, and institutional rollout discipline.
