# Weighted scoring review and constraint expansion plan

Reviewed: November 18, 2026, Cairo time.

Status: implementation review and proposed plan. This document does not change live settings, assignments, or scheduler behaviour.

## Recommendation

More constraints can be added. First make scoring easier to extend and audit; then add a small set of optional limits with clear definitions.

Keep three concepts separate:

1. **Hard constraints:** eligibility and limits that points cannot buy permission to violate.
2. **Protected objectives:** exam coverage, on-call coverage, and workload balance, optimized before preferences.
3. **Soft preferences:** penalties traded against one another by priority order or weighted points.

A very large soft weight must not silently turn a preference into a hard constraint. Conversely, zero points must not be presented as a reliable way to disable a rule under the current implementation.

## 1. Current weighted system

The current public score is:

```text
Penalty points = engagement weight * engagement overlap hours
               + day weight * calendar gap days
               + duty weight * idle hours within working days
               + daily weight * duties above the daily soft target
```

Lower is better, after protected objectives are considered.

| Preference | Default weight | Unit | Applies to |
| --- | ---: | --- | --- |
| Engagement overrides | 100 | Overlap hour | Staff whose policy permits engagement overrides |
| Consecutive days | 50 | Calendar gap day | Staff with consecutive days enabled |
| Consecutive duties | 10 | Idle hour | Staff with consecutive duties enabled |
| Daily soft target | 1 | Excess duty | Duties represented as assignments in the solve |

One unit of each preference therefore costs `100 + 50 + 10 + 1 = 161` points.

Weights are integers from 0 to 1,000, with at least one positive weight. The daily soft target is an integer from 0 to 20. A daily target of zero means every counted duty exceeds the target; it does not disable daily scoring.

Weighted mode optimizes the combined score and then uses the configured Up/Down order to break score ties. The saved order also applies in greedy selection and local exchanges.

The points do **not** let the scheduler trade an exam shortage for better consecutive days, ignore a maximum-hour limit, override a blocked engagement without staff permission, or add unnecessary reserve duties.

## 2. Findings from the review

### A. The standard score formula is consistent

The Python score uses integer minutes internally and converts to the displayed hour/day/duty units. Under the application's standard internal daily multiplier of 5, the weighted score, CP-SAT coefficients, and local-exchange comparison use consistent units.

The existing nine priority tests passed. They cover units, changes in weighted tradeoffs, invalid configuration, protected hours, engagement opt-outs, and session/on-call separation.

This supports the tested behaviour. It does not prove that a large, time-limited solve reaches the lowest possible score.

### B. Zero weight is not the same as Off

Confirmed with an isolated calculation: two plans can have identical weighted points for a zero-weight rule, but the preference order still selects the plan with the lower raw penalty for that rule.

The current UI describes this behaviour, so it is not an undocumented calculation error. It is nevertheless unsuitable as the only enable/disable mechanism for a larger rule system.

**Plan:** add explicit rule modes: Off, Preferred, and Required where a hard version has a defined meaning. Off rules must be excluded from scores, tie-breaks, repair decisions, and violation counts. Preserve existing zero-weight tie-breaking when migrating legacy configuration unless the user explicitly disables the rule.

### C. Daily-duty scope differs from continuity and total-hour scope

The daily soft target counts assignments in the solve, including preserved assignments represented there. It does not count separate `fixed_duties` entries such as fixed control or super duties. Continuity does include those fixed duties, and total workload includes their hours.

Confirmed example: two scheduled duties plus one fixed control duty, with a daily target of two, produce zero daily excess duties today. Under an all-duty definition the excess would be one.

This is a scope limitation, not a violation of the currently implemented formula.

**Plan:** define duty counting once and expose the chosen scope. Recommend all actual duty types for new daily limits. Carry an explicit legacy scope for existing daily-target configurations, so a migration does not silently change their meaning. Count each actual assignment once, even when it is also represented as a fixed busy interval.

### D. Adding a rule currently requires coordinated changes in many places

Allowed rule keys, defaults, input validation, UI labels, CP-SAT expressions, score calculation, greedy ranking, local repair, metrics, and exports are distributed across JavaScript and Python. Python currently requires exactly the four known preference keys.

Adding only a new input or only a CP-SAT expression could leave fallback scheduling, final result selection, or reporting inconsistent.

**Plan:** introduce a versioned rule catalogue and a common evaluation contract. Generate or verify shared configuration metadata across the JavaScript and Python implementations; do not try to share executable Python/JavaScript functions directly.

### E. Weight changes can have little visible effect

Coverage and balance are protected first. CP-SAT and fallback result comparison also considers workload quality, default-duty balance, utilization spread, role-hour spread, and on-call spread before weighted points.

Greedy selection checks projected load and duty-type load before the preference key. The exchange pass preserves every staff member's total and duty-type hours.

Consequently, a lower-point plan can lose to a better protected balance result. This is largely intentional, given the requirement to avoid overloading staff for continuity.

**Plan:** retain these protections and show the full objective hierarchy in diagnostics. Align and test the CP-SAT stages, result comparator, and repair guards so their differences are deliberate and visible. Do not make fairness freely tradeable for points in the first expansion.

### F. Refinement is limited in both scope and time

The local exchange pass starts only when someone has a consecutive preference enabled. It explores exchanges involving those staff, with the same role, duty type, and duration. It can stop after five seconds or 40 accepted exchanges.

It is not a general weighted optimizer for every staff member. Engagement-only or future room-preference improvements can be missed by that pass. More constraints can also increase CP-SAT model size and reduce time left for later preferences.

**Plan:** generalize repair eligibility to the active rules and preserve protected objectives. Report time limits, exchange-count limits, and unsearched neighbourhoods. Prioritize improvements by measured benefit and cost rather than simply increasing the number of solver stages.

### G. A total score is not enough to explain the result

The preview exposes the total score, weights, order, continuity metrics, and stage diagnostics. It does not provide a complete, consistent contribution table for every scored rule and staff member.

Also, daily scoring is coupled to an internal `daily_penalty_weight` switch in addition to the public weight. That switch is normally 5 but can be zero in direct solver inputs. A future rule system should not rely on recovering raw excess-duty counts by dividing an old penalty.

**Plan:** evaluate raw violations first, then calculate points from those raw values. Display and export:

| Rule | Raw amount | Unit | Weight | Points | Search status |
| --- | ---: | --- | ---: | ---: | --- |
| Example engagement overlap | 2.5 | hours | 100 | 250 | Feasible; optimum not proved |

Scores should only be compared directly when the dataset, scope, active rules, and weights match. Keep per-unit meanings stable; do not automatically rescale weights when staff counts change.

## 3. Recommended additional constraints

All new rules should initially be disabled for existing configurations. Enabling a new hard rule may legitimately increase shortages; the preview must show that impact.

### First release: daily workload and reserve limits

| Proposed rule | Supported modes | Definition | Staff policy integration |
| --- | --- | --- | --- |
| Maximum duties per day | Off / Preferred / Required | Excess above N actual duties per staff member per calendar day; soft points per excess duty | Global default with optional staff override; recommend counting session, on-call, control, and super assignments |
| Maximum duty hours per day | Off / Preferred / Required | Excess assigned minutes above a daily maximum; soft points per excess hour | Combines with existing overall maximum and custom caps; the most restrictive applicable hard cap wins |
| Maximum on-call hours per person | Off / Preferred / Required | Excess reserve hours across the scheduling horizon; soft points per excess hour | Separate from total hours; existing on-call exclusions remain strict in normal mode |

The first rule extends the existing daily soft target rather than adding a second, overlapping daily-count penalty. Migration must prevent double charging.

Use an on-call **hour** limit first because reserve duties have different durations. An optional duty-count limit can follow if operations need it.

### Second release: rest and long runs of work

| Proposed rule | Supported modes | Definition | Important interaction |
| --- | --- | --- | --- |
| Minimum rest between working days | Off / Preferred / Required | Time from the previous working day's final duty to the next working day's first duty; soft points per missing rest hour | Calculate with dates and times; do not penalize consecutive duties within the same working day |
| Maximum consecutive working days | Off / Preferred / Required | Number of calendar working days beyond a permitted run length; soft points per excess day | Can conflict with the preference to cluster work into consecutive days; make that tradeoff explicit |
| Minimum break after a continuous work block | Off / Preferred / Required | After X continuous duty minutes, require Y break minutes; soft points per missing break hour | Requires a precise definition of qualifying gaps and merged duty intervals; continuity must respect required breaks |

For rest rules, define how fixed duties, adjoining duty intervals, and duties on adjacent dates are handled. Reject inconsistent minimum/maximum settings before solving.

### Later candidates requiring more data or design

| Candidate | What is needed first |
| --- | --- |
| Room or campus preference | Reliable room/campus identifiers and staff preference data |
| Travel time between locations | Location data and a travel-time matrix; unknown travel time must not silently mean zero |
| Early/late duty fairness | A definition of early/late, comparable staff groups, and any history carried between runs |
| Minimum exam share versus on-call share | Define hour-based shares, staff-specific eligibility, and treatment of shortage periods; avoid duplicating protected duty-type balance |
| Minimum days of attendance or exact working-day count | Decide whether attendance is a target or requirement and whether it may justify new duties; do not invent unnecessary on-call work |

Do not add every candidate in one release. More rules increase both configuration complexity and solver work.

## 4. Proposed configuration and architecture

### Configuration contract

Use a versioned configuration with a rule entry containing:

- Stable key and schema version.
- Mode: Off, Preferred, or Required, limited to supported modes.
- Parameters, such as maximum daily hours.
- Unit and validated point weight for Preferred mode.
- Scope: applicable staff, roles, duty types, and scheduling dates.
- Optional staff-level parameter overrides.
- Explicit exception permissions, if exceptions are supported at all.

Only Preferred rules belong in the Up/Down soft preference order. Required rules become model constraints. Show their parameters rather than a meaningless points input.

Allow all soft preferences to be Off while retaining hard rules and protected coverage/balance objectives. Validate weights only for the relevant Preferred rules; do not retain the current requirement for one positive weight when no weighted preference is active.

Existing role checks, overlap protection, and engagement permissions remain their current policy mechanisms. Do not replace the staff engagement checkbox with a generic weight or a global override switch.

### Evaluation contract

For each rule, implement equivalent behaviour in:

1. Input validation and migration.
2. CP-SAT constraints or objective expressions.
3. Greedy candidate eligibility or incremental penalties.
4. Local repair acceptance and hard-rule guards.
5. Final plan evaluation and CP-SAT/fallback comparison.
6. Preview explanations, dashboard checks, and exports.

Model variables may use integer minute units. Public results should include raw counts/minutes and the documented unit conversion, without rounding before plan comparisons.

Unavoidable constant penalties from fixed duties can be excluded from an optimization expression, but they must be included in reported totals. Tests must account for that constant when comparing expressions with reported points.

### Persistence and compatibility

- Extend the existing scheduling configuration JSON with a schema version and rule entries.
- Use additive SQLite migration for staff-level rule overrides if a separate table is introduced; persist overrides by stable staff identity and rule key.
- Preserve the current four-rule order, weights, staff permissions, and legacy daily scope when upgrading old data.
- Initialize additional rules to Off.
- Retain import/export and SQLite-only recovery support.
- Reject unsupported schema versions or unknown active rules explicitly; do not silently drop them.
- Treat a saved rule change as a store-version change so existing previews become stale.

## 5. UI and reporting plan

Extend the Scheduling Rules tab with rule cards showing mode, threshold, scope, units, and points where applicable. Keep Up/Down controls for Preferred rules.

In Staff Policies, show inherited values with optional individual overrides. Separate global defaults from staff-specific choices so users can see which value applies.

For each preview, show:

- Coverage and protected-objective results before the preference score.
- A points contribution table and the effective rule configuration.
- Staff-level violations with dates and contributing duties.
- Differences between the current schedule and the proposed plan.
- Whether limits were satisfied, whether any explicit exceptions were used, and which search stages were time-limited.

Extend the Conflict Dashboard to audit the same rule definitions against saved assignments. It must continue to distinguish hard violations, soft preference penalties, permitted engagement overrides, and coverage gaps.

Do not call a time-limited solution the minimum-conflict schedule unless the relevant optimization has actually proved optimality under the selected objective hierarchy.

## 6. Implementation phases and acceptance criteria

### Phase 1: make scoring extensible and explainable

Deliver the versioned rule catalogue, raw violation metrics, contribution breakdown, explicit enable modes, and migration for the current four preferences. Define daily duty scope and preserve legacy behaviour during migration.

Acceptance: existing configurations retain their decisions on controlled fixtures; Off rules have no influence; score contributions sum to the total; JavaScript/Python metadata agree.

### Phase 2: add daily and on-call limits

Implement maximum daily duty count, daily hours, and total on-call hours across CP-SAT, fallback, repair, evaluation, and reporting. Add staff overrides and controls.

Acceptance: Required rules reject invalid new assignments in every engine; Preferred rules produce the documented penalties; other staff policies remain protected. Contradictory preserved assignments produce an actionable error rather than being silently moved.

### Phase 3: add rest and consecutive-work limits

Implement inter-day rest, maximum consecutive days, and then continuous-work breaks. Add date/time boundary fixtures before performance work.

Acceptance: back-to-back duties, adjacent dates, gaps, and fixed duties are evaluated consistently. The consecutive-duty preference cannot override a Required break.

### Phase 4: validate on realistic data and refine search

Use read-only copies of representative datasets and compare ranked mode, weighted mode, CP-SAT, and forced fallback under the same recorded budget and settings.

Record coverage, hard violations, each score contribution, workload spreads, model size, runtime, solver status, and repair stopping reason. Repeat timed experiments when needed to distinguish a real regression from search variability.

Acceptance:

- New soft rules never authorize breaking hard rules or sacrificing protected coverage.
- New hard rules may reduce coverage, but the preview explains their effect.
- Every selected plan is independently re-evaluated before apply.
- Apply saves exactly the previewed plan, and stale tokens remain rejected.
- The score report and dashboard agree on raw violations under the same configuration.

## 7. Test plan

Add tests for:

- Unit conversion, zero weights, explicit Off, and equal-score tie-breaking.
- Increasing one weight changing a controlled tradeoff while hard/protected results stay fixed.
- Multiplying all positive weights by the same factor preserving mathematical plan ordering; do not require identical large-run assignments under time limits.
- Fixed control/super/on-call duties counted once under the selected daily scope.
- Daily limits of zero, exact boundaries, fractional hours, and variable duty durations.
- Rest across adjacent dates and maximum consecutive working-day runs.
- Conflicting preferences, such as clustering days versus a required rest day.
- Staff-specific overrides and inherited defaults.
- Strict policies, shortage exception mode, and engagement opt-outs for every new rule.
- CP-SAT expression values agreeing with final rule evaluation, allowing documented fixed constants.
- Fallback and repair respecting Required rules and using the same weighted units.
- Import/export, legacy configuration migration, SQLite-only recovery, and stale preview invalidation.
- A small enumerable fixture whose best weighted plan is known, to test the complete solve/selection path rather than only the exchange helper.

## 8. Reviewed implementation and verification

Primary source files:

- [Python scheduler](server/scripts/auto_schedule.py): `weighted_preference_cost`, `preference_key`, `build_model`, `solve_with_cp_sat`, `greedy_fallback_schedule`, `refine_preference_exchanges`, and `compare_result_metrics`.
- [Configuration normalization](server/store.js): `normalizeSchedulingConfig` and the preference constants.
- [API and solver payload](server/index.js): scheduling configuration routes and payload builders.
- [Priority editor](client/src/components/SchedulingPriorities.jsx): units, weights, and ordering controls.
- [Priority tests](server/scripts/verify_scheduling_priorities.py).
- [Configuration/API integration tests](server/scripts/verify_consecutive_preferences_api.js).

Verification performed for this review:

- Ran `python server/scripts/verify_scheduling_priorities.py`: all nine tests passed.
- Reproduced the 161-point one-unit example using the current scoring function.
- Confirmed zero-weight tie-breaking with two equal-score inputs.
- Confirmed that two scheduled duties plus a fixed control duty produce no daily excess under the existing assignment-only counting scope and target of two.

No live configuration or scheduling assignments were changed. The proposed first implementation batch is Phase 1 followed by the three limits in Phase 2.
