# UNI Exam Invigilation Scheduler

Web-based academic exam scheduling and invigilation platform.

For an explanation of the technology, scheduling rules, optimization, and preview/save process, see [Technology and scheduling guide](TECHNOLOGY_AND_SCHEDULER_GUIDE.md).

For the scoring review and proposed rule extensions, see [Weighted scoring review and constraint plan](WEIGHTED_SCORING_REVIEW_AND_CONSTRAINT_PLAN.md).

For the tab updates, process findings, endpoint inventory, and validation evidence, see [Application UI and process review](APPLICATION_UI_AND_PROCESS_REVIEW.md).

## Stack

- Frontend: React + Vite
- Backend: Node.js + Express
- Storage: in-memory runtime store persisted to SQLite with JSON mirrors
- Optimization: Python OR-Tools CP-SAT
- Excel: import/export with `xlsx`

## Main Features

- Sessions imported from Excel using `Room`, `CourseCode`, `Date`, `Start`, `End`
- Room/time sessions with merged course codes
- Separate Session Needs import for TA and Doctor requirements
- Invigilator management for TAs and Doctors
- Engagement/unavailability management
- Manual scheduling grid and OR-Tools auto-scheduling
- Reports, workload, day coverage, control sessions, and super invigilators
- Room Capability tab with OR-Tools capacity allocation and grid export

## Requirements

- Node.js
- npm
- Python 3
- Python package: `ortools`

Install OR-Tools if needed:

```powershell
pip install ortools
```

## Install

```powershell
npm run install-all
```

## Run Locally

Development mode:

```powershell
npm run dev
```

Open:

```text
http://localhost:5173
```

Production-style local run:

```powershell
npm run localhost
```

Open:

```text
http://localhost:3001
```

## Run On Local Network

```powershell
npm run network
```

Open from another device on the same network:

```text
http://YOUR_MACHINE_IP:5173
```

Windows Firewall may need to allow Node.js.

## Excel Samples

Sample Excel files are in `sample/`.

- `sessions.xlsx`: main session import format
- `sessions_temp.xlsx`: alternate session guide
- `staff.xlsx`: staff guide
- `engagement.xlsx`: engagement guide

Session import format:

```text
Room, CourseCode, Date, Start, End
```

Rows with the same `Room + Date + Start + End` are merged into one session with multiple course codes.

Session Needs import uses:

```text
SessionID, Room, Date, Start, End, TANeeded, DoctorNeeded, InvigilatorsNeeded
```

`CourseCode` is not required for Session Needs.

## GitHub Notes

Do not commit runtime/generated files:

- `node_modules/`
- `client/dist/`
- `server/data/`
- `server/temp/`
- `.env*`

Before pushing:

```powershell
npm run build
git status --short
```

