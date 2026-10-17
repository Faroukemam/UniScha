# UNI Exam Invigilation Scheduler — Project Review

Review date: 2026-07-11

## Executive summary

The project is a substantial, working local-first scheduling application. It covers exam sessions, invigilators, availability, workload policies, manual and optimized scheduling, on-call/control duties, course-to-room assignment, recovery, and Excel reporting. The domain logic is deeper than the compact README suggests, and the repository includes useful regression scripts for the highest-risk scheduling workflows.

The current implementation is suitable for controlled use on one trusted workstation or a tightly controlled LAN. It is not ready to be exposed to an untrusted network: there is no authentication or authorization, CORS is unrestricted, the server binds to every interface, and destructive/import/export endpoints are available to any caller. The most important engineering risks after access control are non-transactional persistence, oversized modules, unbounded Python subprocesses, and incomplete automated test isolation.

Overall assessment: **functionally strong prototype / internal operational tool, requiring security and architecture hardening before multi-user or public deployment**.

## Scope and method

The review covered:

- Root and client package configuration and documentation
- React application structure and all page modules
- Express API routes and Excel import/export paths
- JSON/SQLite persistence and recovery logic
- Node-to-Python solver integration
- Course-room and staff scheduling solvers
- Existing verification scripts and production frontend build
- Repository hygiene and operational deployment behavior

The sample spreadsheets and PDFs were treated as fixtures/reference data, not manually audited cell by cell. Git was unavailable in the review environment, so tracked/untracked state and the exact pre-existing diff could not be verified.

## Architecture

```text
React/Vite UI
    |
    | JSON API and generated workbook URLs
    v
Express server (server/index.js)
    |-- scheduling/report/domain logic (store.js, reports.js)
    |-- course-room service (courseRoomAssignment.js)
    |-- JSON mirrors (store.json, store.last-good.json)
    |-- sql.js database (scheduler.sqlite)
    `-- Python subprocesses
          |-- auto_schedule.py
          |-- room_capability.py
          `-- course_room_assignment.py -> auto_room_assignment.py
```

This is a pragmatic architecture for a single-process desktop/LAN tool. The main limitation is that API, domain, validation, workbook generation, and orchestration responsibilities are heavily concentrated in `server/index.js`.

## What is done well

- The product covers the scheduling workflow end to end instead of exposing only a solver.
- Scheduling constraints account for roles, overlapping duties, engagements, locked/manual assignments, on-call work, control work, and staff-hour policy.
- Preview and export flows reduce the risk of applying an optimization result blindly.
- Assignment provenance and lock metadata are normalized for legacy data.
- The persistence layer has explicit primary/backup recovery logic and derived-view cache invalidation.
- Imports perform meaningful domain normalization, and reports cover fairness, shortage, conflict, utilization, and detailed workload.
- The solver wrapper uses `sys.executable` for its nested Python process, avoiding interpreter drift inside that chain.
- The repository contains focused regression scripts for locking, preview modes, role scope, imports/exports, on-call behavior, session merging, policy behavior, and storage recovery.
- The frontend production build completes successfully.

## Prioritized findings

### Critical — no access control around operational and destructive APIs

Evidence: `server/index.js:73` enables unrestricted CORS; `server/index.js:5142` listens on `0.0.0.0`; the API includes unauthenticated create, import, assignment, bulk-delete, reset, and full-data export endpoints. Static temporary exports are public through `server/index.js:75-76`.

Impact: anyone who can reach the port can read staff/schedule data, change assignments, import arbitrary datasets, reset the application, or download generated files. The documented LAN mode makes this risk concrete.

Recommendation:

1. Bind to `127.0.0.1` by default and require an explicit environment flag for LAN access.
2. Add authentication and server-side role checks before supporting multiple users.
3. Restrict CORS to configured origins; note that CORS is not authentication.
4. Require re-authentication or a short-lived confirmation token for reset/bulk destructive operations.
5. Serve exports through authorized, expiring endpoints instead of a public static directory.

### High — persistence updates are not atomic across tables and files

Evidence: `server/store.js:925-934` clears multiple SQLite tables before repopulating them, with no visible `BEGIN`, `COMMIT`, or `ROLLBACK`. Course-room replacement similarly deletes then inserts at `server/courseRoomAssignment.js:326-328`. The database is exported to disk after callbacks, and JSON primary/backup mirrors are then written separately.

Impact: an exception, process termination, or disk failure during a multi-table update can leave an incomplete in-memory database, an out-of-sync SQLite file, or mismatched JSON mirrors. The write queue prevents overlapping store writes but does not provide transactional durability.

Recommendation: wrap each logical SQLite replacement in a transaction with rollback; write exported SQLite/JSON content to temporary files, `fsync` where appropriate, then atomically rename. Define one authoritative store and treat other formats as recoverable mirrors with explicit version/checksum metadata.

### High — Python solver processes are unbounded at the Node boundary

Evidence: Python is spawned at `server/index.js:380`, `server/index.js:4422`, and `server/courseRoomAssignment.js:396` without a wall-clock timeout, cancellation, stdout/stderr size cap, or concurrency limit. `course_room_assignment.py:72` invokes another subprocess without a wrapper timeout. The CP-SAT solver has an internal limit, but process startup, parsing, fallback logic, or a defect can still hang.

Impact: repeated requests can consume CPU and memory, a stalled child can leave an HTTP request open indefinitely, and accumulated output can exhaust memory.

Recommendation: create one solver-runner abstraction with a request timeout, `AbortSignal`/disconnect handling, process-tree termination, bounded output, structured error codes, and a small concurrency queue. Validate and clamp user-provided time limits.

### High — architecture is difficult to change safely

Evidence: `server/index.js` is about 5,147 lines, `server/store.js` about 2,306, `SchedulingPage.jsx` about 1,665, and `CourseRoomAssignmentPage.jsx` about 903. The route file also contains parsing, validation, workbook generation, solver payload construction, persistence mutation, and report orchestration.

Impact: changes have a large regression surface, review is harder, and domain rules can drift between manual assignment, import, preview, and optimization paths.

Recommendation: split by bounded feature (`sessions`, `staff`, `scheduling`, `on-call`, `course-room`, `reports`) with route/controller, schema validation, service, and repository layers. Extract shared time-overlap, role, workload, and assignment validation into pure domain modules. Break large React pages into hooks and feature components.

### Medium — validation is ad hoc and error contracts are inconsistent

Evidence: request bodies are consumed directly throughout `server/index.js`; there is no shared request-schema library or centralized error middleware. Persistence failures return internal `error.message` details at `server/index.js:126`.

Impact: edge cases are validated differently by endpoint, malformed nested payloads can reach deep logic, and internal paths/database details can leak to clients.

Recommendation: add schemas (for example, Zod, Joi, or JSON Schema) at every mutation boundary, standardize `{ code, message, fieldErrors, requestId }`, log full errors server-side, and return safe client messages.

### Medium — tests are valuable but are not a conventional, isolated test suite

Evidence: there is no root `test` script, frontend test setup, coverage configuration, or CI workflow visible in the reviewed file list. Verification is a collection of executable scripts. Eleven scripts passed; `verify_storage_recovery.js` failed with `Verification requires at least one session.` because it depends on the ambient runtime store rather than creating a complete fixture.

Impact: a clean checkout can produce environment-dependent results, contributors do not have one canonical command, and UI/API regressions outside the scripted scenarios can pass unnoticed.

Recommendation:

- Add `npm test` that runs deterministic unit/integration suites and returns a reliable aggregate exit code.
- Make every test create its own temporary store and solver fixture.
- Add API contract tests for validation, destructive routes, and concurrent writes.
- Add solver golden tests for feasible, infeasible, timeout, locked-conflict, and fallback cases.
- Add a few UI tests for import preview, auto-schedule preview/apply, and error states.
- Run build, tests, and Python checks in CI.

### Medium — generated export lifecycle and privacy need hardening

Evidence: workbooks are written to `server/temp` (`server/index.js:2968`) and that directory is served statically. No cleanup/retention mechanism was found.

Impact: files containing staff names, IDs, availability, or assignments may remain readable for the lifetime of the server and accumulate on disk.

Recommendation: generate unpredictable IDs, authorize download, set a short expiry, remove files after download/expiry, add `Cache-Control: no-store`, and avoid exposing the filesystem directory directly.

### Medium — frontend GET caching can serve stale cross-context data

Evidence: `client/src/api.js:2` keeps an unbounded in-memory GET cache. It is globally cleared after mutations made by that tab, but there is no TTL, server version validation, focus refresh, or cross-tab invalidation.

Impact: data changed by another tab/client or restored directly can remain stale until a local mutation or full reload. This becomes more visible if multi-user operation is added.

Recommendation: use a query client with explicit stale times and invalidation, or add ETag/store-version handling. Refresh critical scheduling views on focus and after every apply/import action.

### Medium — frontend bundle is large and eagerly loaded

Evidence: the successful Vite build produced one JavaScript asset of about 818.81 kB (241.05 kB gzip), triggering Vite's chunk-size warning. Every page is statically imported in `client/src/App.jsx`.

Impact: slower first load and parse time, especially across a LAN or on older office machines.

Recommendation: lazy-load route pages with `React.lazy`, split spreadsheet/report functionality, and consider loading `xlsx` only on pages/actions that require it.

### Low — deployment and dependency reproducibility are incomplete

The README lists Python and OR-Tools but there is no pinned `requirements.txt`/`pyproject.toml`, Python version policy, environment example, health endpoint documentation, container/service definition, or backup/restore runbook. The Node dependency versions are ranges in manifests (the lockfiles help local reproducibility).

Recommendation: pin Python dependencies, add `.env.example`, document supported Node/Python versions, define health/readiness behavior, and provide tested backup/restore and upgrade steps.

### Low — repository hygiene should be verified

`.gitignore` correctly excludes `client/dist`, `server/data`, and `server/temp`, and the README warns against committing them. Those directories exist in this working copy, along with many generated/sample workbooks and temporary Office files. Because Git was unavailable, this review could not determine whether ignored runtime files had previously been committed.

Recommendation: verify with `git ls-files server/data server/temp client/dist` and remove tracked runtime artifacts from version control without deleting needed local data. Separate canonical anonymized fixtures from ad hoc generated outputs.

## Course-room solver review

The course-room subsystem has a sensible separation between JavaScript import/persistence/orchestration and Python optimization. It supports linked-course grouping, normal versus backup availability, room types, minor/major capacity modes, locked/manual assignments, shortages, waste, and quality diagnostics.

### Course-room findings requiring attention

#### High — the manual-assignment UI is connected to a backend stub

The page displays room selection and submits `manualAssignCourseRoom` from `client/src/pages/CourseRoomAssignmentPage.jsx:297`, and the API route is registered in `server/index.js:4937`. However, `server/courseRoomAssignment.js:694` always throws `Manual room assignment is not available in the current backend build.`

Impact: a visible primary workflow can never succeed. It also means that “locked/manual assignments” are not an operator-controlled feature in the current course-room module; the only locks passed to the optimizer are created internally between solve stages.

Recommendation: either hide/disable the UI with an explicit “not implemented” label, or implement the feature fully. A complete implementation must validate the group, rooms, availability windows, room type, selected capacity mode, physical-room overlap, combined block capacity, and conflicting assignments; save manual provenance/lock state; then rerun or reconcile the remaining groups without overwriting the manual placement.

#### High — backup stage cannot globally improve the normal-room packing

`runCourseRoomAssignment` first solves without backup rooms, then builds locks from every stage-one room row (`server/courseRoomAssignment.js:623-668`) and passes them into the backup-enabled solve. In Python, a locked room/mode receives a lower bound and the other mode is forced to zero (`server/scripts/auto_room_assignment.py:516-527`).

Impact: stage two can extend stage-one allocations but cannot move students out of a poorly chosen normal room. Some instances require rearranging normal-room placements before a backup room can eliminate or reduce a shortage. The current “BackupEnhanced” result can therefore be locally constrained even when a better global backup-enabled solution exists.

Recommendation: run the backup-enabled model independently and compare complete solutions, or lock only genuine operator-approved assignments. If preserving normal placements is a business rule, expose that explicitly as a setting and label the result as an incremental rescue rather than a global optimization.

#### Medium — shortage diagnostics currently contain placeholder values

`buildQualityReport` sets `totalCompatibleNormalCapacity: 0`, `compatibleAutoAvailableCapacity: 0`, and `theoreticallyPlaceable: false` for every shortage (`server/courseRoomAssignment.js:466-482`). These fields are displayed in the UI, including compatible backup capacity.

Impact: operators can receive a confident but incorrect explanation of why a group was not placed. This weakens one of the module's most useful operational features.

Recommendation: calculate diagnostics from matching availability intervals, room-type/fallback rules, selected capacity mode, concurrent consumption, and backup policy. Until implemented, use `null`/“not calculated” rather than zero/false.

#### Medium — import success counts unvalidated rows

The three import functions normalize and insert every row and return `errors: []` (`server/courseRoomAssignment.js:340-390`). Detailed validation happens later inside the solver. The UI consequently announces rows as valid immediately after import.

Impact: invalid dates, times, types, capacities, duplicates, or missing fields may appear successfully imported and fail only when the solver runs.

Recommendation: run the same input validation before replacing the current table, return row-level errors, and support an import preview. Reject invalid rows or make partial-import behavior explicit. Do not delete a known-good input table before the replacement set is validated.

#### Medium — weighted objective priorities are not guaranteed lexicographic

The CP-SAT objective uses fixed weights from `1,000,000,000` for shortage students down to room order (`server/scripts/auto_room_assignment.py:754-768`). Fixed weights approximate priority but do not prove it for arbitrary dataset sizes: a sufficiently large sum of lower-priority terms can outweigh one unit of a higher-priority term. Large inputs also increase the risk of integer-domain/overflow issues.

Impact: the result may violate the stated business priority on larger datasets, even while being optimal for the numeric expression.

Recommendation: use sequential solves (coverage first, then fix its optimum and minimize the next criterion), or derive mathematically safe bounds for every coefficient and reject inputs beyond those bounds. Document the exact priority order.

#### Medium — results are not reproducible enough for audit use

The solver uses eight search workers (`server/scripts/auto_room_assignment.py:775-776`) without a fixed random seed, and the stored summary omits solver wall time, best bound, objective value, and optimality gap.

Impact: repeated runs may produce different feasible room layouts, and users cannot distinguish an optimal result from a time-limited feasible result beyond the coarse status.

Recommendation: support a deterministic/audit mode (fixed seed and deterministic worker configuration), persist solver statistics and input/settings hashes, and show whether the solution was optimal or merely feasible when saved.

#### Medium — course-room behavior lacks its own regression suite

The existing verification scripts thoroughly cover staff scheduling, but there is no dedicated `verify_course_room_assignment.js` or Python test module in the reviewed repository.

Recommendation: add tests for grouping, exact and overlapping windows, physical-room collisions, Major/Minor sharing, DH overflow rules, TH fallback, AutoAvailable rescue, independent versus locked two-stage behavior, invalid imports, infeasible locks, manual assignment, and stable export totals. Include invariant checks that every student is assigned at most once and no room/mode capacity is exceeded at any time checkpoint.

Recommended improvements:

- Validate all settings and clamp `time_limit_seconds` to a safe range before invoking Python.
- Return and persist solver diagnostics consistently: solver status, wall time, objective components, bound/gap, stage selected, and reason for fallback.
- Add deterministic seed/worker configuration where reproducible schedules are operationally important.
- Test pathological inputs: duplicate room blocks, overlapping availability for the same physical room, conflicting locks, zero/negative capacity, malformed times, a linked group spanning different periods, and insufficient backup capacity.
- Remove the extra Python wrapper subprocess if it adds no isolation; otherwise give both levels explicit timeout and cancellation semantics.
- Document objective priority in user language so operators understand whether coverage, backup avoidance, room count, or capacity waste wins when tradeoffs conflict.

## Data and correctness observations

- IDs and normalized legacy fields are handled defensively in many paths.
- The JSON/SQLite recovery design is thoughtful, but recovery scoring based on record counts should not substitute for an explicit commit/version marker; a larger stale database can appear preferable to a smaller newer one.
- Manual operations and optimized operations should use exactly the same eligibility/overlap policy functions. Existing helpers move in this direction and should become the single domain API.
- Dates and times appear to be stored as strings. Document the accepted date/time formats and timezone policy, and reject ambiguous Excel date conversions at import boundaries.
- Full data export may contain personal data. Define retention, authorized users, and whether staff IDs/emails require masking in reports.

## Recommended delivery plan

### Phase 1 — operational safety

1. Default to localhost-only binding and restrict CORS.
2. Add authentication/authorization before further LAN rollout.
3. Protect reset, bulk delete, import, and export actions.
4. Add solver timeout/concurrency controls and export cleanup.
5. Make the storage recovery test self-contained and expose one passing `npm test` command.

### Phase 2 — data integrity and observability

1. Make SQLite and mirror writes transactional/atomic.
2. Add request IDs, structured logs, safe error responses, and health/readiness endpoints.
3. Add schema validation and consistent API errors.
4. Add automated backup/restore verification and data versioning.

### Phase 3 — maintainability and performance

1. Split the Express monolith into feature modules and shared domain services.
2. Split large React pages and lazy-load routes/heavy spreadsheet code.
3. Add unit, API integration, solver golden, and focused UI tests in CI.
4. Pin Python dependencies and document a supported deployment environment.

## Verification results

| Check | Result |
|---|---|
| Server JavaScript syntax (`node --check`) | Pass for all server `.js` files |
| Python AST parsing | Pass for all 4 solver scripts |
| Vite production build | Pass |
| Production bundle warning | One JS chunk ~818.81 kB (~241.05 kB gzip) |
| Regression scripts | 11 pass, 1 fixture-dependent failure |
| Failing script | `verify_storage_recovery.js`: requires at least one ambient session |
| Git status / tracked artifact check | Not available because Git executable was missing |

## Suggested acceptance criteria for production readiness

- All mutation/export endpoints require authenticated, authorized access.
- Default installation is unreachable from other machines unless explicitly configured.
- Interrupted writes cannot leave partially replaced tables or mismatched mirrors.
- Solver calls have bounded time, output, and concurrency and are cancelled on disconnect.
- `npm test` and `npm run build` pass from a clean checkout in CI.
- Tests use isolated fixtures and do not depend on `server/data`.
- Backup restore is documented and tested against a representative production-size dataset.
- Generated exports expire and are not publicly enumerable or indefinitely retained.
- Core scheduling rules have unit tests shared by manual, import, preview, and apply paths.

## Final assessment

The project has strong functional value and credible scheduling logic. Its biggest gap is not optimization quality; it is the boundary around that logic. Securing the API, making persistence atomic, bounding solver execution, and turning the verification scripts into an isolated CI suite would materially raise confidence. After those changes, modularization and frontend code splitting can proceed incrementally without blocking operational use.
