# Invigilation assignment and staff policy review

Reviewed and applied on 31 October 2026.

## Applied result

The updated scheduler saved 237 assignments covering all current duties in 79
sessions, with no remaining staffing shortage. Staff above their configured
policy or maximum-hour limits decreased from 12 to zero. All 64 policy records
retain their original values. Session needs, staff details, engagements, and
existing on-call, supervision, and control duty values were preserved.

The final solve selected a feasible CP-SAT allocation after comparing it with a
valid fallback. Coverage is complete; optimal workload balance is not proven.
The backend was restarted and the saved allocation checked again afterward.

Report: `artifacts/invigilation-review/optimized-invigilation.xlsx`.

## Policy rules

| Policy | Behavior |
| --- | --- |
| default | The current role average is a flexible balancing target. A positive Max Hours remains a hard limit. |
| exact | The specified hours are a hard upper limit, including zero. |
| add | The current role average plus the specified hours is a hard upper limit. |
| reduce | The current role average minus the specified hours is a hard upper limit, floored at zero. |
| exclude / exclusion checkbox | No assignment is allowed. |

For custom policies, a positive Max Hours can further lower the effective limit.
Maximum hours of zero continues to mean no additional maximum; it cannot override
a custom zero-hour limit. All duty types count toward workload limits. Engagements,
overlapping duties, roles, exclusions, and valid locks are respected.

Automatic assignment and manual eligibility now use these same limits. If a fixed
or locked duty conflicts with a policy or availability, scheduling reports the
affected staff and stops without saving an invalid allocation or removing locks.

## Why updates could appear stale

Several issues contributed:

1. Derived server caches used a global store version alone. Edited snapshots and
   previews could therefore reuse calculations from different inputs. Core caches
   now compare the actual source snapshot as well.
2. Browser GET responses could be cached indefinitely. The policy, scheduling,
   and workload pages now fetch current data, other cached GETs expire, and an old
   in-flight response cannot repopulate a cache invalidated by an edit.
3. A long scheduler run saved its original store snapshot. Policy or session-need
   changes made during that run could be overwritten. The write queue now checks
   the expected version and rejects an outdated schedule with HTTP 409.
4. Policy warnings returned as text were rendered as objects, leaving their
   messages blank. The page now renders both formats.
5. Scheduling exports read an incorrect workload field and could show zero policy
   hours. They now use the calculated field. Policy exports also include current
   role averages, policy hours, and effective limits.

Policy calculations reload after successful edits, when returning to the page,
and after changes in another app tab. Background refresh preserves unsaved drafts.
The policy table previews changed hours immediately, labels unsaved changes, and
distinguishes targets from effective limits.

Changing session needs updates role averages and add/reduce limits. Exact limits
remain the specified value. Existing assignments are not silently rearranged by
an edit: rerun auto-scheduling to bring the assignment into line with new rules.

## Optimization changes

- Enforce custom limits in both CP-SAT and the fallback, including zero limits.
- Optimize coverage first and fix that coverage before improving workload balance.
- Use a validated starting allocation and retain the fallback if search times out.
- Replace many pairwise overlap constraints with simultaneous-duty groups.
- Balance utilization relative to individual policy hours, rather than treating
  deliberately reduced loads as if everyone should work identical raw hours.
- Keep full role-demand averages when optimizing only TAs or only Doctors.
- Size load and deviation bounds from actual workload, including workloads above
  24 hours; use four search workers.
- Describe fallback solutions as feasible rather than claiming optimality.

## Verification

Passed:

```text
python server/scripts/verify_invigilation_optimizer.py
node server/scripts/verify_staff_hour_policy.js
node server/scripts/verify_policy_refresh.js
node server/scripts/verify_policy_refresh_api.js
node server/scripts/verify_auto_schedule_preview.js
node server/scripts/verify_auto_schedule_preview_export.js
node server/scripts/verify_auto_schedule_role_scope.js
node server/scripts/verify_assignment_locking.js
node server/scripts/verify_on_call.js
npm run build
```

The 15 new optimizer cases cover hard policy limits, zero limits, flexible default
staff, fallback enforcement, other duty loads, locked conflicts, overlaps,
exclusions, role separation, coverage priority, duplicate staff, and long workloads.
Refresh tests exercise policy edits, session-need edits, current Excel calculations,
cache races, and changes made while scheduling is in progress. Existing preview,
export, locking, role-scope, and on-call regression suites also passed.

The saved live result passed checks for policy limits, maximum hours, exclusions,
engagements, overlapping duties, duplicate assignments, roles, and fixed-duty loads.

Previous data backup:

```text
C:/Users/ro/AppData/Local/Temp/unischa-invigilation-review-0ci0cxuv/scheduler-before-apply.sqlite
C:/Users/ro/AppData/Local/Temp/unischa-invigilation-review-0ci0cxuv/store-before-apply.json
```
