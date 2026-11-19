# Course room assignment review

## Strict imported capacities — 18 November 2026

The course room assignment solver no longer applies a 10% capacity allowance.
Major and Minor block totals must stay at or below their respective imported
capacities for TH, DH, and LAB courses, including backup rooms and shared blocks.
The greedy starting allocation, CP-SAT constraints, capacity bounds, and shortage
diagnostics use the same strict capacities. For example, a 50-seat block can seat
at most 50 students, leaving a shortage of 5 for a group of 55.

Saved placements are not rewritten by this code change. Restart the backend to
load the updated diagnostic code, then run Course Room Assignment again to
produce a saved allocation under the new limits. Older saved quality comparisons
describe the earlier allocation until a new run is completed.

Verification includes 17 Python regression tests, backend shortage-diagnostic
checks, frontend rendering checks, and a production build.

## UI update — 18 November 2026

The workspace now separates Setup, Placements, Room allocations, and Diagnostics.
Search, date, type, status, and room-source filters apply to the displayed view;
exports retain the complete saved allocation. Allocation details distinguish
students in one allocation, shared block totals, remaining block seats, and
physical room totals. Backup room metrics count distinct physical rooms rather
than placement groups. Before a run exists, shortage figures remain uncalculated.

The unsupported Manual save flow was replaced with a View allocation control.
Imports and clearing results ask for confirmation, pending operations disable
conflicting actions, and load/diagnostic failures are visible. Solver rules and
saved allocations were not changed by this UI update.

UI verification: `node server/scripts/verify_course_room_view.cjs`,
`node server/scripts/verify_ui_render.cjs`, and the frontend production build.
These checks cover derived counts, filters, loaded allocation details, initial
page rendering, and bundling; browser layout/interaction testing is separate.

## Historical review — 29 October 2026

The findings and saved-run figures below describe the earlier implementation,
which still included the capacity allowance removed above.

## Findings

The saved allocation had 11,794 students without seats across 218 placement groups
from 243 course rows. All 79 rooms were marked `AutoAvailable`, so the normal-room
pass had no rooms to allocate. The single imported room-session row also had equal
start and end times and was invalid; it did not supply normal availability.

The previous solver optimized the entire week as one model. Its time-limited
result could have substantial shortages even when a much better allocation was
available. The backup pass also locked every normal allocation, preventing the
rearrangement sometimes needed to use backup rooms effectively.

Room capacity alone does not guarantee that a particular course fits. The retained
rule permits one block per placement group per room. For example, a room with 30
Major and 40 Minor seats contributes at most 40 seats to one group, or 44 with the
existing 10% non-DH allowance. Different groups can use its two blocks. A group
can use Major in one room and Minor in another. Overlapping exams with different
time windows still cannot share a physical room.

## Changes

- Build linked groups once, then solve independent periods separately. The current
  inputs divide into 31 components; overlapping exams stay together.
- Start with a feasible allocation, validate it with the constraint solver, and
  retain it if further optimization times out.
- Minimize student shortage first. The room-packing pass fixes the best coverage
  found, so room preferences cannot increase that shortage.
- Let the backup-enabled pass rearrange normal allocations. Explicit locks passed
  directly to the Python solver remain supported.
- Accept a normal availability interval that fully covers a TH or LAB exam, even
  when its boundaries differ. Preserve the existing DH start-time rule.
- Use four search workers and omit unused physical-room variables.
- Reject unsuccessful solver responses before saving results, and preserve the
  solver's error through the Python wrapper.
- Calculate shortage capacity diagnostics from room types, time availability,
  selected modes, backup settings, and the one-block rule. Label these capacities
  as bounds before competition with other groups, rather than proof of placement.
- Correct the page's explanation of Major and Minor blocks.

## Verification

```text
python server/scripts/verify_course_room_assignment.py
node server/scripts/verify_course_room_assignment.js
npm run build
```

The 14 Python regression cases cover capacity conservation, shared blocks, one
block per group per room, availability containment, time conflicts, room reuse,
linked-group identity, DH overflow restrictions, fallback and capacity settings,
backup rearrangement, and timeouts. Backend checks cover stage selection,
independent backup optimization, failure preservation, and shortage diagnostics.

The frontend production build passed. The initial full-input optimized run left
188 students without seats and fully placed 212 of 218 groups, compared with
11,794 students and 144 fully placed groups in the saved allocation. Its student,
capacity, overflow, and overlap invariants passed. This was a feasible,
time-limited solution; remaining shortages are not all proven unavoidable.

The full backend verification uses an in-memory database copy so it can exercise
normal and backup solves, result persistence, quality reporting, and exports
without replacing the live allocation during testing.

## Applied result

The backend was restarted and the live assignment rerun with a 60-second solve
budget, backup rooms and TH fallback enabled, linked grouping enabled, and the
`best` capacity strategy. The saved result also leaves 188 students without seats,
fully places 212 groups, partially places 3, and leaves 3 unassigned. Shortage is
98.4% lower than the previous saved result. Refresh the Course Room Assignment page
to load it.

The current Excel report is
`artifacts/course-room-review/optimized-course-room-assignment.xlsx`. It includes
the six remaining shortage groups and their calculated capacity diagnostics.
The previous SQLite database was backed up before restarting and rerunning to:

```text
C:/Users/ro/AppData/Local/Temp/unischa-room-review-t_kc8jdj/scheduler-before-save.sqlite
```
