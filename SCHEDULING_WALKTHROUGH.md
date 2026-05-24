# Scheduling Walkthrough

## Scope

This walkthrough covers the Scheduling process only.

Main files:

- `client/src/pages/SchedulingPage.jsx`
- `client/src/api.js`
- `server/index.js`
- `server/store.js`
- `server/db.js`
- `server/scripts/auto_schedule.py`

## Source Of Truth

The live app reads and writes Scheduling data through:

- `server/data/store.json`

SQLite is used as a synchronized persistence target and recovery layer, but the Scheduling UI is still built from `store.json`.

That means:

1. imports update `store.json`
2. `writeStore(...)` syncs that state into SQLite
3. UI reads the normalized Scheduling view built from `store.json`

## Import Paths

There are two Scheduling import styles.

### 1. Dedicated tab imports

Used by:

- Sessions tab
- Session Needs import inside Sessions
- Invigilators tab
- Engagements tab
- Control Sessions tab

Routes:

- `POST /api/import/sessions`
- `POST /api/import/session-needs`
- `POST /api/import/invigilators`
- `POST /api/import/engagements`
- `POST /api/import/control-sessions`

### 2. Workbook import

Used by:

- Scheduling tab workbook import

Route:

- `POST /api/data/import`

This route imports:

- `Sessions`
- `SessionNeeds`
- `Invigilators`
- `Engagements`
- `Assignments`
- `Super`
- `ControlSessions`
- `ControlAssignments`

## Import Normalization

The backend now normalizes imported data before writing it.

Shared normalization includes:

- date normalization
- time normalization
- room/course field aliases
- staff role normalization
- load type normalization
- numeric demand normalization
- ID preservation for workbook imports when possible

### Sessions

Sessions are merged by:

- `Date`
- `Start`
- `End`
- `Room`

Course codes in the same room-time slot are merged into one session row.

### Session Needs

Session Needs rows are matched in this order:

1. `SessionID`
2. exact `Date + Start + End + Room`
3. exact `Date + Start + End + Room + CourseCodes`

Important:

- `InvigilatorsNeeded` is treated as total demand
- it is no longer incorrectly pushed into `TANeeded`
- if only total demand exists, total is preserved without corrupting TA/Doctor split

### Invigilators

Normalized fields:

- `StaffID`
- `Name`
- `Email`
- `Role`
- `LoadType`
- `MaxHours`
- `Department`
- `Notes`

Role normalization:

- `Doctor`, `dr`, `doc` -> `Doctor`
- everything else defaults to `TA`

### Engagements

Engagements stay keyed by `staffId`, not app invigilator ID.

This matters because the Scheduling eligibility logic checks:

- engagement `staffId`
- against invigilator `staffId`

### Workbook Imports With Existing Assignments

Workbook import now remaps references safely:

- session references -> session IDs
- invigilator references -> app invigilator IDs
- engagement references stay as staff IDs
- control assignment references -> control session IDs + invigilator IDs

Broken references are filtered out instead of being written blindly.

## Scheduling View

The Scheduling page loads:

- `GET /api/scheduling`

The backend builds the page view using `buildSchedulingView(store)`.

Each session row includes:

- current TA assignments
- current Doctor assignments
- remaining TA need
- remaining Doctor need
- eligible TAs
- eligible Doctors

## Manual Assignment Rules

Manual assignment uses:

- `POST /api/scheduling/assign`

Hard checks:

- session exists
- invigilator exists
- role still has open need
- no duplicate assignment to the same session
- no overlap with existing exam duties
- no overlap with engagements
- no overlap with Super Invigilator duties
- no overlap with Control Session duties
- no max-hours overflow

Eligibility is calculated in:

- `server/store.js`

## Auto Scheduling Flow

Auto scheduling uses:

- `POST /api/scheduling/auto-schedule`

The backend builds a solver payload from:

- normalized sessions
- invigilators
- direct engagements
- generated busy intervals from Super Invigilator assignments
- generated busy intervals from Control assignments
- current manual session assignments as `locked_assignments`

## Locked Assignments

Existing session assignments are passed to the solver as locked assignments.

Meaning:

- the auto scheduler must keep them
- the solver fills around them
- auto schedule no longer discards manual work by default

If a locked assignment is invalid under hard constraints, the solver returns an explicit error.

## Solver Layers

The Scheduling solver has two layers.

### Layer 1: CP-SAT

The CP-SAT model creates:

- `x[staff, session]`

Hard constraints:

- role demand balance
- overlap blocking
- engagement blocking
- locked assignment forcing
- max-hours limits

Objective priorities:

1. minimize staffing shortage
2. reduce max individual load
3. reduce load spread
4. reduce same-role imbalance
5. reduce excess sessions per day above soft limit

### Layer 2: Greedy fallback

If CP-SAT returns:

- `UNKNOWN`

the app uses the greedy fallback directly.

If CP-SAT returns:

- `FEASIBLE`
- but the produced schedule is worse than the fallback

the app now compares both and keeps the better schedule.

Comparison priority:

1. lower total shortage
2. fewer uncovered sessions
3. more placed duties

This is critical because some dense real datasets can produce a weak CP-SAT feasible solution while the fallback covers more duties.

## Result Selection

Possible solver statuses now include:

- `OPTIMAL`
- `FEASIBLE`
- `FEASIBLE_PARTIAL`
- `FALLBACK_OPTIMAL`
- `FALLBACK_PARTIAL`
- `INFEASIBLE`
- `EMPTY`

The Scheduling tab status label explains whether the selected result came from:

- CP-SAT
- or the fallback scheduler

If fallback is chosen over CP-SAT, the response includes an explanation.

## Persistence After Auto Schedule

After the selected result is accepted:

1. solver `staff_id` values are mapped back to app invigilator IDs
2. `store.assignments` is rewritten
3. `writeStore(store)` persists to:
   - `store.json`
   - `store.last-good.json`
   - SQLite sync

Because locked assignments were included in the solve, existing manual assignments remain represented in the final output.

## Workbook Export

Scheduling workbook export uses:

- `GET /api/export/workbook`

It exports:

- `Sessions`
- `SessionNeeds`
- `Invigilators`
- `Engagements`
- `Assignments`
- `Super`
- `ControlSessions`
- `ControlAssignments`

## Important Operational Notes

### When Scheduling looks empty

Check these first:

1. sessions exist
2. session needs are non-zero
3. the active browser is connected to the correct repo/backend instance

### When Session Needs import appears to do nothing

Check the import response:

- `updated`
- `unmatched`

If `updated = 0`, matching failed.

### When auto schedule looks too weak

Now the app should no longer accept a weak CP-SAT feasible schedule if fallback covers more duties.

If the result is still partial, it is more likely to be a real coverage constraint than a selection bug.

## Review Checklist

Use this checklist after imports or solver changes:

1. Are session needs non-zero after import?
2. Does workbook import preserve sessions, staff, and assignments correctly?
3. Do engagements still match by `staffId`?
4. Do locked manual assignments survive auto schedule?
5. Do super/control overlaps block both manual and automatic assignment?
6. If CP-SAT returns a weak feasible schedule, does the app select the stronger fallback result?

## Current Limitations

- Scheduling still uses `store.json` as the primary live read source.
- SQLite is synchronized but not yet the primary Scheduling query source.
- The fallback scheduler is greedy, so it is a safety layer, not a fairness-optimized replacement for CP-SAT.
- The sample loader still depends on the structure of files in `sample/`; it is not a general import substitute.
