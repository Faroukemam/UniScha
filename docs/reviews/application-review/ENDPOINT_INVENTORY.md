# Endpoint inventory

Reviewed 18 November 2026: 104 registered API routes, 136 requests, 0 failed contracts.

A probe may exercise an expected error response; these checks are not exhaustive success-path coverage. Full request/status evidence is in endpoint-contract-results.json.

| Method | Route | Observed status codes |
| --- | --- | --- |
| GET | `/api/scheduling/config` | 200 |
| PATCH | `/api/scheduling/config` | 400 |
| GET | `/api/scheduling/combined` | 200 |
| POST | `/api/scheduling/combined/preview` | 200 |
| POST | `/api/scheduling/combined/apply` | 200, 409 |
| GET | `/api/dashboard` | 200 |
| GET | `/api/system/storage-status` | 200 |
| GET | `/api/sessions` | 200 |
| POST | `/api/sessions` | 201, 400 |
| PUT | `/api/sessions/:id` | 200, 400, 404 |
| DELETE | `/api/sessions/:id` | 200 |
| DELETE | `/api/sessions` | 200 |
| GET | `/api/invigilators` | 200 |
| POST | `/api/invigilators` | 201, 400 |
| PUT | `/api/invigilators/:id` | 200, 400, 404 |
| DELETE | `/api/invigilators/:id` | 200 |
| DELETE | `/api/invigilators` | 200 |
| GET | `/api/staff-hour-policies` | 200 |
| POST | `/api/staff-hour-policies` | 400 |
| DELETE | `/api/staff-hour-policies/:id` | 200 |
| DELETE | `/api/staff-hour-policies` | 200 |
| GET | `/api/engagements` | 200 |
| POST | `/api/engagements` | 201, 400 |
| PUT | `/api/engagements/:id` | 200, 400, 404 |
| DELETE | `/api/engagements/:id` | 200 |
| DELETE | `/api/engagements` | 200 |
| GET | `/api/scheduling` | 200 |
| GET | `/api/scheduling/session/:sessionId/eligible` | 200 |
| GET | `/api/scheduling/export/current` | 200 |
| GET | `/api/scheduling/export/assignment-template` | 200 |
| GET | `/api/scheduling/export/committee-assignment-template` | 200 |
| POST | `/api/scheduling/import/assignment-actions` | 400 |
| POST | `/api/scheduling/import/committee-assignments` | 400 |
| GET | `/api/on-call` | 200 |
| PATCH | `/api/on-call/config` | 200 |
| GET | `/api/on-call/eligible` | 200 |
| POST | `/api/on-call/auto-assign` | 200 |
| POST | `/api/scheduling/assign` | 201 |
| POST | `/api/on-call/assign` | 201 |
| DELETE | `/api/scheduling/assign/:id` | 200 |
| PATCH | `/api/scheduling/assign/:id/lock` | 200, 404 |
| PATCH | `/api/scheduling/assign/bulk-lock` | 200 |
| PATCH | `/api/scheduling/assign/lock-by-filter` | 200 |
| DELETE | `/api/scheduling/assign` | 200 |
| DELETE | `/api/on-call/assign/:id` | 200 |
| DELETE | `/api/on-call/assign` | 200 |
| GET | `/api/super-invigilators` | 200 |
| GET | `/api/super-invigilators/export` | 200 |
| POST | `/api/super-invigilators/assign` | 201, 400 |
| DELETE | `/api/super-invigilators/:id` | 200 |
| DELETE | `/api/super-invigilators` | 200 |
| GET | `/api/control-sessions` | 200 |
| GET | `/api/control-sessions/export` | 200 |
| GET | `/api/control-sessions/template/export` | 200 |
| POST | `/api/control-sessions` | 201, 400 |
| PUT | `/api/control-sessions/:id` | 200, 400, 404 |
| POST | `/api/control-sessions/assign` | 201 |
| DELETE | `/api/control-sessions/assign/:id` | 200 |
| DELETE | `/api/control-sessions` | 200 |
| DELETE | `/api/control-sessions/:id` | 200 |
| GET | `/api/workload` | 200 |
| POST | `/api/scheduling/auto-schedule-preview` | 200 |
| POST | `/api/scheduling/auto-schedule-preview/export` | 200 |
| GET | `/api/scheduling/assign/lock-plan/export` | 200 |
| POST | `/api/scheduling/assign/lock-plan/import` | 200 |
| POST | `/api/scheduling/auto-schedule` | 200 |
| POST | `/api/room-capability/optimize` | 200 |
| POST | `/api/import/sessions` | 400 |
| POST | `/api/import/session-needs` | 400 |
| POST | `/api/import/control-sessions` | 400 |
| POST | `/api/import/control-session-loads` | 400 |
| POST | `/api/import/invigilators` | 400 |
| POST | `/api/import/staff-hour-policies` | 400 |
| POST | `/api/import/engagements` | 400 |
| POST | `/api/data/load-sample` | 404 |
| GET | `/api/export/workbook` | 200 |
| GET | `/api/export/staff-hour-policies` | 200 |
| GET | `/api/export/staff-hour-policies/template` | 200 |
| GET | `/api/day-coverage` | 200 |
| GET | `/api/reports/summary` | 200 |
| GET | `/api/reports/workload` | 200 |
| GET | `/api/reports/fairness` | 200 |
| GET | `/api/reports/daily-coverage` | 200 |
| GET | `/api/reports/room-shortage` | 200 |
| GET | `/api/reports/engagement-overrides` | 200 |
| GET | `/api/reports/conflicts` | 200 |
| GET | `/api/reports/detailed-load` | 200 |
| GET | `/api/reports/staff/:staffId` | 200 |
| GET | `/api/reports/session-coverage` | 200 |
| GET | `/api/reports/utilization` | 200 |
| GET | `/api/reports/quality-score` | 200 |
| GET | `/api/course-room-assignment` | 200 |
| GET | `/api/course-room-assignment/quality` | 200 |
| POST | `/api/course-room-assignment/import-schedule` | 400 |
| POST | `/api/course-room-assignment/import-room-sessions` | 400 |
| POST | `/api/course-room-assignment/import-room-capacity` | 400 |
| POST | `/api/course-room-assignment/run` | 200 |
| POST | `/api/course-room-assignment/manual-assign` | 400 |
| DELETE | `/api/course-room-assignment/results` | 200 |
| GET | `/api/course-room-assignment/export` | 200 |
| GET | `/api/course-room-assignment/export-unassigned` | 200 |
| GET | `/api/data/export` | 200 |
| POST | `/api/data/import` | 200 |
| DELETE | `/api/data/reset` | 200 |
