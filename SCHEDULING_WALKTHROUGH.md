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

- `POST /api/scheduling/auto-schedule-preview` to solve session-only scheduling
- `POST /api/scheduling/auto-schedule` with the returned `planToken` to save that exact plan
- `POST /api/scheduling/auto-schedule-preview/export` with the same `planToken` to export that exact preview

Session-only previews expire after ten minutes or when scheduling data changes. Saving and exporting require a valid token and never rerun the solver. A successfully saved token cannot be reused. Edits made while a preview is being calculated cause it to be rejected. Combined session/on-call plans use the same preview-and-apply workflow through `/api/scheduling/combined/preview` and `/api/scheduling/combined/apply`.

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

1. minimize exam staffing shortage, then on-call shortage
2. minimize explicitly permitted policy and availability overrides
3. balance total workloads and reduce duties above the daily soft limit
4. balance exam-session and on-call hours separately among default-policy staff within each role, without worsening total workload balance
5. refine on-call distribution across the remaining eligible staff
6. minimize calendar-day gaps and then idle minutes without worsening earlier workload objectives

Staff with no custom hour policy and staff explicitly using mode `default` join the same default balancing group. TAs and Doctors have separate groups. Exact/add/reduce/exclude policies retain their own rules and are not equalized with default staff. Both exam and reserve hours include preserved assignments. Equal combined hours alone are insufficient: the default duty balance objective also reduces differences in each duty type, even when both consecutive-duty preferences are off. Default balancing is a preference, so availability, hard limits, locks and exam coverage can leave differences. Preview and export data include `defaultStaffBalance`; the preview workbook's `DefaultStaffBalance` sheet shows staff count, average, minimum, maximum and spread by role and duty type.

The daily soft limit defaults to two modeled duties per staff member per date, including locked duties and on-call duties in combined plans. `daily_penalty_weight` controls the penalty in the CP-SAT quality objective and the fallback's candidate ranking; zero disables the penalty. Coverage remains the first priority, so duties above the limit are permitted when needed. Results expose `dailyExcessDuties` and `dailyPenalty` for diagnostics.

### Staff continuity preferences

The Staff Hour Policy editor has two independent checkboxes, both off by default:

- `preferConsecutiveDuties`: prefer a single block of duties per working date, minimizing idle minutes between the first and last duty.
- `preferConsecutiveDays`: prefer consecutive calendar dates, minimizing days without duties between the first and last working date. Weekends and dates with no available sessions still count as gaps; the scheduler never creates duties to fill them.

Session, on-call, control and super duties contribute to the same continuity calculation. Fixed and locked duties count, and additional duties can bridge gaps between them. Preferences are soft: required coverage comes first. Exclusions, custom hour-policy limits, maximum hours and duty overlaps remain protected for staff with either continuity preference or engagement-override permission. Engagements can be overridden only through the separate Allow engagement override checkbox, which defaults on. Turning it off keeps engagements strict even in shortage mode.

Both CP-SAT and fallback scheduling use these preferences after workload balance. Continuity rearranges a fair allocation; it must not attract extra on-call duties just to fill gaps. CP-SAT fixes the best workload score found, then refines the default staff duty mix, on-call distribution and continuity without worsening earlier objectives. Fallback ranks projected workload and existing hours of the same duty type before continuity, and result selection compares workload quality and default duty balance before gaps. Coverage remains first when only a few staff can cover a duty. The dedicated on-call auto-assignment API always uses the same solver, including when all continuity preferences are off; exam assignments stay fixed in this on-call-only operation. Session and combined previews include per-staff `continuity` rows, and preview workbooks include `StaffContinuity`. Existing gaps appear as policy warnings; manual assignment can create a gap and returns a warning rather than rejecting a valid assignment.

The flags are saved in JSON, SQLite and backups. Excel policy templates and exports use `PreferConsecutiveDuties` and `PreferConsecutiveDays`, accepting Yes/No, True/False or 1/0. Missing or blank columns default to No. Existing SQLite databases migrate automatically with both flags off.

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


### Engagement override permission and report

Staff Hour Policies includes **Allow engagement override**, on by default for both existing and new staff. Turn it off for staff whose engagements must remain strict, including in shortage mode. When enabled, automatic exam and on-call scheduling may use engagement time to cover shortages or balance workload. This permission keeps all other policies strict: custom hour caps, maximum hours, staff/on-call exclusions, roles, fixed duties and simultaneous duty conflicts. Consecutive preferences can be used alongside the permission. Imported availability is retained.

Preview lists every overridden duty, overlap minutes, and its reason. Reasons distinguish exam coverage, on-call coverage, workload allocation, and preserved fixed/locked assignments. Coverage reasons mean there is no engagement-free direct replacement in the resulting plan under the remaining policies; they are not a proof that every possible rearrangement needs that override. Workload reasons mean a direct replacement exists, but the solver selected that workload allocation.

After saving, **Reports > Engagement Overrides** shows the affected staff, duties, engagement times and notes, overlap minutes, recorded reason, assignment source when available, and current permission. Filters apply by date, role, department and staff. Export the report as Excel (affected-staff summary and detailed overlaps) or CSV; it is also included in the full reports workbook. Totals merge overlapping engagement intervals within each duty. Older overlaps without recorded reasons are labeled accordingly. Reasons survive SQLite recovery and JSON backups/imports.


### Optimizer timing and running backend

The optimizer now starts its budget before model preparation, reserves 35% for coverage and warm-start setup, and assigns explicit deadlines to the remaining workload, default-duty mix, on-call, engagement-reduction and continuity steps. Hints reuse the original variable wrappers and solution values. Greedy conflict checks scan only that staff member's duty intervals, rather than every assignment in the plan. These changes reduce preparation overhead and reserve opportunities for later objectives. OR-Tools can return after its requested cutoff, so this remains a solve budget rather than a hard HTTP timeout.

Preview and Excel export expose `optimizationStages` with status and elapsed seconds, plus `optimizationSeconds`. A FEASIBLE result is an incumbent, not a proof of optimum; UNKNOWN or SKIPPED_TIME_LIMIT stages retain the last feasible plan. Fallback selection retains the CP-SAT stage diagnostics even when the greedy plan wins.

After backend code changes, restart the backend process. Refresh the browser and generate a new preview: a previously displayed preview cannot acquire new policy flags or solver behavior automatically. Saving still requires the exact reviewed plan token; no corrected preview is saved automatically.
