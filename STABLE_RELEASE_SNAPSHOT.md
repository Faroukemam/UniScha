# Stable Release Snapshot

## Current Stable Status

Verified against the current active workspace:
- Workspace: `F:\MUST_TA\schadual group\uni_scha`
- Old/inactive workspace not used: `C:\Users\Farouk Waked\Desktop\uni_scha`

Latest stable shared counts:
- Startup source: `sqlite`
- Sessions: `359`
- SessionNeeds: `359`
- Invigilators: `149`
- Assignments: `1151`
- On-call periods: `83`
- On-call assignments: `0`
- On-call shortage:
  - TA: `157`
  - Doctor: `109`
  - Total: `266`
- Super assignments: `0`
- Control sessions: `0`
- Control assignments: `0`

Latest Course Room Assignment counts:
- Courses: `261`
- Availability rows: `444`
- Capacity rows: `50`
- Results: `238`
- Result room rows: `649`

Storage health:
- SQLite and JSON mirrors are aligned
- `store.json` aligned with SQLite for shared scheduling data
- `store.last-good.json` aligned with SQLite for shared scheduling data
- Latest storage health status: `ok`
- Latest storage warnings: none

## Implemented Major Improvements

### SQLite / JSON Mirror Stabilization
- Added startup source selection between SQLite and JSON mirrors
- Added recovery-safe store initialization
- Added storage-status diagnostics
- Added mirrored persistence through:
  - `server/data/scheduler.sqlite`
  - `server/data/store.json`
  - `server/data/store.last-good.json`

### Session Block Merge Logic
- Shared session blocks now normalize by:
  - `Room + Date + Start`
- Merged blocks use:
  - max `End`
  - merged unique course codes/names
- Session Needs matching now supports:
  1. `SessionID`
  2. `Room + Date + Start`
  3. `Room + Date + Start + CourseCodes`
  4. `Room + Date + Start + End`

### Scheduling Compact API
- `GET /api/scheduling` no longer returns full eligible candidate lists for every session
- Scheduling payload is compact and fast
- Assignment counts and remaining needs remain available per session

### Eligible Candidates On Demand
- Added per-session eligibility endpoint:
  - `GET /api/scheduling/session/:sessionId/eligible`
- Scheduling page now loads candidates only for the selected session

### Frontend Reports Progressive Loading
- Reports summary loads first
- Detailed report sections load progressively
- Slow report sections no longer block the full page

### Course Room UI Pagination / Loading Improvements
- Course Room Assignment page loads visible summary state first
- Quality analysis loads separately
- Heavy result/diagnostic tables use pagination to reduce render cost

### On-Call Staffing
- Added derived exact-period on-call needs using:
  - exact `Date + Start + End` room blocks
- Added `onCallAssignments`
- Added on-call routes, workload integration, day-coverage integration, reports integration, export integration, and dedicated UI

### Dashboard On-Call Summary Optimization
- Dashboard no longer uses the full on-call view with eligible-count computation
- Dashboard now uses a lightweight on-call summary builder for:
  - on-call periods
  - on-call assignments
  - on-call shortages

## Current Architecture Summary

### Storage Source
- Durable persistence layer:
  - `server/data/scheduler.sqlite`
- JSON mirrors / recovery files:
  - `server/data/store.json`
  - `server/data/store.last-good.json`

### `readStore()` / `writeStore()` Behavior
- `readStore()` serves initialized in-memory shared state after startup
- `writeStore()` persists shared state through the central path
- Shared writes update:
  - SQLite
  - `store.json`
  - `store.last-good.json`
  - in-memory store state

### Shared Tabs
Shared scheduling/store-backed tabs include:
- Dashboard
- Sessions
- Invigilators
- Engagements
- Scheduling
- On-Call
- Super Invigilators
- Control Sessions
- Workload
- Day Coverage
- Reports
- Export / Workbook
- Storage Status / Debug

### Course Room Assignment Separate Module
- Course Room Assignment remains a separate SQLite-native subsystem
- It is not part of the shared scheduling store model
- It has separate solver, tables, state, and quality output

### On-Call Model
- `onCallNeeds` are derived from exact room periods
- `onCallAssignments` are persisted shared duties
- On-call conflicts with:
  - session assignments
  - engagements
  - super duties
  - control duties
  - overlapping on-call duties
  - max-hours overflow

### Reports / Export Integration
- Workload includes on-call duties
- Day Coverage includes daily aggregate on-call needs and shortages
- Reports summary includes:
  - on-call assignments
  - on-call hours
  - on-call shortage
- Workbook export includes:
  - `OnCallNeeds`
  - `OnCallAssignments`

## Verification Results

Latest verification status:

### `verify_session_block_merge.js`
- Result: `PASS`
- Confirms:
  - `Room + Date + Start` merge logic
  - max `End`
  - safe assignment remap
  - scheduling/export block consistency

### `validate_session_block_real_data.js`
- Result: `PASS`
- Confirms:
  - current real data is already normalized to block logic
  - sessions remain `359`
  - assignments remain `1151`
  - no unexpected remap/drop
  - Session Needs remain matched

### `verify_on_call.js`
- Result: `PASS`
- Confirms:
  - on-call need calculation rules
  - assignment lifecycle
  - overlap blocking
  - max-hours blocking
  - workload/day-coverage/reports/export integration

### Frontend Build
- Result: `PASS`
- Command:
  - `cd client && npm run build`
- Current warning:
  - Vite bundle chunk size warning remains

## Current Known Limitations

- No on-call import flow yet
- Vite frontend bundle warning remains
- Course Room Assignment is still a separate module
- Course Room Assignment payload is still relatively large
- Dashboard is improved, but not fully route-split into smaller summary sources
- No auto-schedule regression run was performed on live data after the latest phases

## Backup Checklist

Back up these files and folders together:

### Core data
- `server/data/scheduler.sqlite`
- `server/data/store.json`
- `server/data/store.last-good.json`

### Shared backend source
- `server/index.js`
- `server/store.js`
- `server/db.js`
- `server/reports.js`
- `server/scripts/`

### Frontend source
- `client/src/`

### Package / config files
- `package.json`
- `package-lock.json`
- `client/package.json` if later added separately
- `README.md`
- `SCHEDULING_WALKTHROUGH.md`
- `STORAGE_ARCHITECTURE.md`

### Templates / sample files
- `sample/`
- `sample_1/`
- `sample_2/`

## Recommended Next Phases

Recommended priority order:

1. On-call import/export polish if operationally needed
   - add safe import flow for on-call assignments if users need workbook-driven entry

2. Course Room summary/detail split
   - reduce initial payload for Course Room Assignment
   - keep heavy result details on demand

3. Frontend bundle code splitting
   - address persistent Vite chunk warning
   - reduce initial JS payload

4. Optional dashboard further optimization
   - split more summary work if dashboard becomes a hotspot again

5. Auto-schedule isolated regression testing
   - verify CP-SAT + fallback behavior on isolated copied data, not live production state

## Commands To Verify Stable State

Run these commands from the active workspace root:

```powershell
node server/scripts/verify_session_block_merge.js
node server/scripts/validate_session_block_real_data.js
node server/scripts/verify_on_call.js
cd client
npm run build
```

Expected stable results:
- all three scripts return `PASS`
- frontend build succeeds
- Vite chunk-size warning may still appear
