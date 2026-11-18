# Application UI, process, and endpoint review

Reviewed on 18 November 2026. This review covers all 17 routed tabs and the 104 explicitly registered API routes. The endpoint inventory and verification summaries are in [docs/reviews/application-review](docs/reviews/application-review). Detailed logs and data snapshots remain local in the ignored artifacts directory.

## UI changes

| Tab | Result |
| --- | --- |
| Dashboard | Added a workflow introduction and direct links to scheduling and conflict review. |
| Sessions | Added search, date filtering, bounded tables, and a collapsible add/edit form. Filters do not change export scope. |
| Invigilators | Added staff search, role filtering, and a collapsible add/edit form. |
| Staff Hour Policies | Retained the recently updated searchable directory and separate policy editor. Draft-preservation verification is included. |
| Engagements | Retained the recently updated filters, paginated directory, validation, and engagement editor. |
| Scheduling | Reviewed preview, apply, role scope, locks, shortage mode, and combined session/on-call processes. Retained the existing preview workflow. |
| Scheduling Rules | Retained ranked controls, weighted scoring, reserve rules, and exclusions. |
| Conflict Dashboard | Retained separate conflict, shortage, permitted engagement override, and balance views. |
| Staff Schedule | Retained the combined personal duty view. |
| On-Call | Retained the recently updated period directory and eligible-candidate assignment controls. |
| Room Capability | Reviewed the existing import, capacity, and optimization workflow; retained its specialized tables. |
| Course Room Assignment | Reviewed its separate course placement process, imports, manual placement, and quality output. |
| Day Coverage | Replaced the wide overview with daily cards, summary metrics, date/status filters, refresh, and explicit loading/error states. |
| Super Invigilators | Added daily summary metrics, search/date/status filters, clear assignment cards, and disabled controls during pending operations. |
| Control Sessions | Added search/date filtering and a collapsible editor while preserving assignment and import/export operations. |
| Work Load | Added summary metrics, search/role/status filters, a compact hours comparison, and daily window details. Explained that the default average is a balancing target. |
| Reports | Added section navigation to make the existing report groups easier to reach. |

Shared styling includes responsive coverage cards, bounded tables, consistent filters, and visible keyboard focus. The new coverage/workload refresh hook ignores obsolete responses and refreshes after data-change events and window focus. Add-record controls reset editing state; empty filtered results explain why the list is empty.

## Defects corrected

1. **Manual CRUD accepted invalid scheduler data.** Session/control staffing could be negative or fractional; dates and intervals were not checked consistently. Engagement records could reference missing staff, have invalid flags, or contain unusable periods. Staff names, hour limits, and duplicate IDs were insufficiently validated. Collection create and record update routes now validate these inputs before writing.
2. **Duplicate staff IDs reached SQLite and returned a server error.** These now return a clear validation response without changing records.
3. **Backup restore omitted on-call configuration.** Full data import now restores normalized reserve rules alongside scheduling configuration. A non-default configuration round trip is verified.
4. **Supervision allowed dates without an exam window.** Such requests are now rejected instead of creating an assignment with no valid daily duty window.

The input-validation middleware applies to direct manual CRUD. It does not replace the separate workbook/import normalization rules.

## Process review

| Process | Reviewed behavior and evidence |
| --- | --- |
| Data persistence | SQLite is the primary durable store with JSON mirrors/recovery. Recovery checks run against a small disposable fixture. Live files are hashed before/after regression testing. |
| Manual assignments | Session, reserve, control, and supervisor assignment flows were exercised on an isolated server. Existing eligibility checks consider role, overlapping duties, engagements, exclusions, and hour limits. |
| Combined scheduling | The Python optimizer receives sessions, derived reserve periods, fixed duties, staff policies, and scoring settings. Session coverage precedes reserve coverage; later objectives balance workloads and apply preferences. Dedicated combined, balance, continuity, priority, and override tests cover these behaviors. |
| Preview and apply | Preview creates an expiring plan token without saving assignments. Apply uses the stored plan and checks store version; replay/stale plans are rejected. Preview/export/apply and lock behavior have dedicated regression checks. |
| Ranked/weighted preferences | Preferences remain subordinate to protected coverage and balance stages. Consecutive duties/days are preferences, so gaps can remain. Zero weight retains tie-breaking behavior; it is not an explicit off switch. See the existing weighted scoring review. |
| Engagement overrides | Staff policy controls permission. Override reports identify affected people, duties, and reasons. Strict duty conflicts and protected limits remain separate. Dedicated permission/report/export tests exercise this process. |
| Imports and exports | Reviewed session merging, needs matching, staff upsert, policy drafts/imports, committee assignments, and report/workbook exports. Import semantics vary by resource and are intentionally preserved. |
| Reporting | Dashboard, workload, daily coverage, individual schedules, conflict, and override reports read the saved store. A preview does not change these reports until applied. |
| Course placement | Course-to-room placement uses a separate data model and optimizer. Its imports and results are not automatically identical to the invigilation session collection. Dedicated course placement tests cover the optimizer and API integration. |

## Verification results

- 34 checks passed after the diagnostics-test rerun; 0 failed; 2 browser checks skipped.
- 104 routes received 136 requests; all expected contracts passed.
- All 17 tabs rendered successfully; the final production build passed.
- Isolated regression checks left live SQLite/JSON hashes unchanged.
- The initial stage-diagnostics test selected fallback with its one-second solve budget during concurrent build load. It passed on direct rerun; its test budget is now ten seconds. Original results and rerun logs are retained. Production solver limits were not changed.
- Backend activation subsequently verified after the user restarted the server: new process PID 10152, both validation probes return the updated errors, and saved data is unchanged. Earlier automated restart attempts were blocked by policy.

## Verification scope

The regression runner copies code into a fresh temporary project for each test, shares installed dependencies, captures complete logs, and cleans only its verified temporary directory. It does not run storage-modifying tests against the user's project data.

- [Verification results](docs/reviews/application-review/verification-results.json): process tests and live-data hash comparison.
- [Endpoint results](docs/reviews/application-review/endpoint-contract-results.json): route inventory, each request/status, and failures.
- [Endpoint inventory](docs/reviews/application-review/ENDPOINT_INVENTORY.md): all registered routes with observed responses.
- Initial server-side rendering checks cover every routed page. They detect render/import errors, not browser layout or user interaction defects.
- Production Vite build checks the complete frontend bundle. Its large JavaScript bundle still produces Vite's size advisory.

Every registered route receives a contract probe. Some probes deliberately exercise a validation or missing-record response; this is not exhaustive success-path or branch coverage. The contract flow additionally exercises valid CRUD, assignments, locks, preview/apply/export, replay rejection, backup restore, and invalid create/update rejection without data changes.

Browser automation was not completed in this environment. The two existing Playwright checks are explicitly skipped, and component rendering is reported separately.

## Remaining findings and recommended order

1. **Import validation is less strict than manual CRUD.** Engagement workbook import primarily checks field presence, and full backup import normalizes/drops some records. Add a shared validation layer and an import preview with row-level errors before changing replacement behavior. This review does not claim malformed import rows are fully rejected.
2. **Editing scheduled records needs a conflict-aware workflow.** Staff ID/role changes or edits to a duty's time can affect existing engagement links, policies, and assignments. Add an impact preview and either migrate dependent references or block incompatible changes. Current assignment validation occurs when assigning; it is not a complete revalidation of every existing duty after every master-data edit.
3. **Coverage and continuity are optimization outcomes.** Passing regressions does not prove every production run is optimal or that every remaining shortage is unavoidable. Preserve the separate shortage/eligibility diagnostics and inspect the actual run before changing weights.
4. **Imports use different replacement/upsert scopes.** Filters only affect the displayed directory; they do not narrow a full import or export. Keep these scopes explicit before adding bulk operations.
5. **Frontend delivery can be smaller.** Route-level lazy loading and separating spreadsheet code would reduce the initial bundle. No arbitrary size-warning increase was used.
6. **Browser acceptance remains outstanding.** Confirm narrow-screen layouts, keyboard navigation, add/edit/close behavior, selection, and downloads in a real browser before declaring visual acceptance complete.

For architecture and scheduling details, read [Technology and scheduling guide](TECHNOLOGY_AND_SCHEDULER_GUIDE.md). For future constraint work, read [Weighted scoring review and constraint plan](WEIGHTED_SCORING_REVIEW_AND_CONSTRAINT_PLAN.md).
