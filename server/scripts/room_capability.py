import json
import math
import sys
from collections import defaultdict
from ortools.sat.python import cp_model


def emit(payload):
    print(json.dumps(payload))
    sys.exit(0)


def key_course(value):
    return str(value or "").strip().upper()


def allowed_with_overflow(capacity, overflow_percent):
    return int(math.ceil((capacity * (1 + overflow_percent)) - 1e-9))


def validate(payload):
    sessions = payload.get("sessions") or []
    courses = payload.get("courses") or []
    capacities = payload.get("capacities") or []

    if not isinstance(sessions, list) or not isinstance(courses, list) or not isinstance(capacities, list):
        emit({"status": "ERROR", "error": "sessions, courses, and capacities must be arrays."})

    capacity_by_room = {}
    for row in capacities:
        room = str(row.get("room") or "").strip().lower()
        if not room:
            continue
        minor_cap = int(float(row.get("minorSubjectCap") or row.get("MinorSubjectCap") or row.get("MainorSubjectCap") or row.get("MinorCap") or row.get("MainorCap") or 0))
        major_cap = int(float(row.get("majorCap") or row.get("MajorCap") or row.get("OtherSubjectCap") or row.get("OtherCap") or 0))
        capacity_by_room[room] = {
            "minor_cap": max(0, minor_cap),
            "major_cap": max(0, major_cap),
            "capacity": max(0, minor_cap + major_cap),
        }

    normalized_sessions = []
    for index, row in enumerate(sessions, start=1):
        session_id = str(row.get("id") or f"session_{index}").strip()
        room = str(row.get("room") or "").strip()
        date = str(row.get("date") or "").strip()
        start = str(row.get("start") or "").strip()
        end = str(row.get("end") or "").strip()
        courses_in_session = [key_course(item) for item in (row.get("courses") or []) if key_course(item)]
        if not session_id or not room or not date or not start or not end:
            continue
        normalized_sessions.append({
            "id": session_id,
            "room": room,
            "date": date,
            "start": start,
            "end": end,
            "courses": courses_in_session,
            "minor_cap": capacity_by_room.get(room.lower(), {}).get("minor_cap", 0),
            "major_cap": capacity_by_room.get(room.lower(), {}).get("major_cap", 0),
            "capacity": capacity_by_room.get(room.lower(), {}).get("capacity", 0),
        })

    normalized_courses = []
    for row in courses:
        course = key_course(row.get("courseCode"))
        if not course:
            continue
        normalized_courses.append({
            "course": course,
            "students": max(0, int(float(row.get("students") or 0))),
            "date": str(row.get("date") or "").strip(),
            "start": str(row.get("start") or "").strip(),
            "end": str(row.get("end") or "").strip(),
        })

    return normalized_sessions, normalized_courses


def solve(payload):
    sessions, courses = validate(payload)
    options = payload.get("options") or {}
    overflow_percent = max(0.0, float(options.get("overflow_percent", 0.10)))
    if not sessions:
        emit({"status": "OK", "allocations": [], "shortages": [], "message": "No sessions to optimize."})

    model = cp_model.CpModel()
    allocation_vars = {}
    shortage_vars = {}
    course_groups = {}

    for course in courses:
        key = (course["course"], course["date"], course["start"], course["end"])
        course_groups[key] = {
            "course": course["course"],
            "date": course["date"],
            "start": course["start"],
            "end": course["end"],
            "students": max(course_groups.get(key, {}).get("students", 0), course["students"]),
        }

    sessions_by_id = {session["id"]: session for session in sessions}
    session_terms = defaultdict(list)
    shortage_terms = []
    fill_penalty_terms = []
    room_priority_terms = []
    overflow_terms = []

    for key, group in course_groups.items():
        matching_sessions = [
            session for session in sessions
            if group["course"] in session["courses"]
            and session["date"] == group["date"]
            and session["start"] == group["start"]
            and session["end"] == group["end"]
        ]

        shortage = model.NewIntVar(0, group["students"], f"shortage_{'_'.join(key)}")
        shortage_vars[key] = shortage
        shortage_terms.append(shortage)

        group_vars = []
        ranked_sessions = sorted(
            matching_sessions,
            key=lambda item: (
                -(allowed_with_overflow(item["minor_cap"], overflow_percent) + allowed_with_overflow(item["major_cap"], overflow_percent)),
                str(item.get("room", "")).lower(),
                str(item.get("id", "")),
            ),
        )
        room_rank_by_session = {
            session["id"]: rank
            for rank, session in enumerate(ranked_sessions)
        }

        for session in matching_sessions:
            var = model.NewIntVar(0, group["students"], f"alloc_{group['course']}_{session['id']}")
            allocation_vars[(group["course"], session["id"], group["date"], group["start"], group["end"])] = var
            group_vars.append(var)
            session_terms[session["id"]].append(var)
            # Secondary tie-breaker: if several rooms can host the same course,
            # allocate students to larger effective-capacity rooms first.
            room_priority_terms.append(var * room_rank_by_session.get(session["id"], 0))

        model.Add(sum(group_vars) + shortage == group["students"])

    for session in sessions:
        capacity = session["capacity"]
        allowed_minor = allowed_with_overflow(session["minor_cap"], overflow_percent)
        allowed_major = allowed_with_overflow(session["major_cap"], overflow_percent)
        allowed_capacity = allowed_minor + allowed_major
        if capacity <= 0:
            for var in session_terms[session["id"]]:
                model.Add(var == 0)
            continue

        primary_flags = []
        primary_parts = []
        other_parts = []
        for index, var in enumerate(session_terms[session["id"]]):
            primary = model.NewBoolVar(f"primary_{session['id']}_{index}")
            primary_part = model.NewIntVar(0, allowed_minor, f"primary_part_{session['id']}_{index}")
            other_part = model.NewIntVar(0, allowed_major, f"other_part_{session['id']}_{index}")
            model.Add(primary_part + other_part == var)
            model.Add(primary_part <= allowed_minor * primary)
            model.Add(other_part <= allowed_major * (1 - primary))
            primary_flags.append(primary)
            primary_parts.append(primary_part)
            other_parts.append(other_part)

        if primary_flags:
            # At most one subject can use the minor/largest-subject partition.
            # All remaining subjects must fit inside the major/other-subject partition.
            model.Add(sum(primary_flags) <= 1)
            model.Add(sum(primary_parts) <= allowed_minor)
            model.Add(sum(other_parts) <= allowed_major)

            minor_overflow = model.NewIntVar(0, max(0, allowed_minor - session["minor_cap"]), f"minor_overflow_{session['id']}")
            major_overflow = model.NewIntVar(0, max(0, allowed_major - session["major_cap"]), f"major_overflow_{session['id']}")
            model.Add(minor_overflow >= sum(primary_parts) - session["minor_cap"])
            model.Add(major_overflow >= sum(other_parts) - session["major_cap"])
            overflow_terms.extend([minor_overflow, major_overflow])

        unused = model.NewIntVar(0, allowed_capacity, f"unused_{session['id']}")
        model.Add(unused == allowed_capacity - sum(session_terms[session["id"]]))
        fill_penalty_terms.append(unused)

    # Primary objective: fit as many students as possible.
    # Secondary objective: keep assignments inside the exact room capacity.
    # The 10% overflow is only emergency capacity and is penalized before room preference.
    # Then prefer larger rooms before smaller rooms for the same course/time.
    # Final tie-breaker: avoid unnecessarily unused seats after all feasible students are placed.
    model.Minimize(
        (sum(shortage_terms) * 100000000)
        + (sum(overflow_terms) * 100000)
        + (sum(room_priority_terms) * 100)
        + sum(fill_penalty_terms)
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float((payload.get("options") or {}).get("time_limit_seconds", 10))
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        emit({"status": "INFEASIBLE", "allocations": [], "shortages": [], "error": "Room capability model is infeasible."})

    allocations = []
    for (course, session_id, date, start, end), var in allocation_vars.items():
        students = int(solver.Value(var))
        if students <= 0:
            continue
        session = sessions_by_id.get(session_id, {})
        allocations.append({
            "sessionId": session_id,
            "room": session.get("room", ""),
            "course": course,
            "date": date,
            "start": start,
            "end": end,
            "students": students,
        })

    shortages = []
    for key, var in shortage_vars.items():
        students = int(solver.Value(var))
        if students <= 0:
            continue
        course, date, start, end = key
        shortages.append({
            "course": course,
            "date": date,
            "start": start,
            "end": end,
            "students": students,
        })

    emit({
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "objective": solver.ObjectiveValue(),
        "overflowPercent": overflow_percent,
        "allocations": allocations,
        "shortages": shortages,
    })


if __name__ == "__main__":
    try:
      solve(json.loads(sys.stdin.read() or "{}"))
    except Exception as exc:
      emit({"status": "ERROR", "error": str(exc), "allocations": [], "shortages": []})
