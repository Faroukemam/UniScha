import json
import sys
from collections import defaultdict
from datetime import datetime
from ortools.sat.python import cp_model


ROLE_TA = "TA"
ROLE_DOCTOR = "Doctor"
VALID_ROLES = {ROLE_TA, ROLE_DOCTOR}

DEFAULT_OPTIONS = {
    "time_limit_seconds": 20,
    "coverage_weight": 1_000_000,
    "max_load_weight": 1_000,
    "spread_weight": 100,
    "imbalance_weight": 1,
    "daily_penalty_weight": 5,
    "max_sessions_per_day_soft": 2,
}


def fail(message, details=None, code="validation_error"):
    payload = {
        "status": "ERROR",
        "error": message,
        "error_code": code,
        "assignments": [],
        "placed": 0,
        "failed": [],
        "staff_loads": [],
        "uncovered_sessions": [],
    }
    if details:
        payload["details"] = details
    print(json.dumps(payload))
    sys.exit(0)


def parse_datetime(date_value, time_value, label):
    date_str = str(date_value or "").strip()
    time_str = str(time_value or "").strip()
    if not date_str or not time_str:
        raise ValueError(f"{label} requires both date and time.")

    normalized_time = normalize_time_string(time_str)
    try:
        return datetime.fromisoformat(f"{date_str}T{normalized_time}")
    except ValueError as exc:
        raise ValueError(f"{label} must use a valid ISO date with time. Received {date_str} {time_str}.") from exc


def normalize_time_string(value):
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Time value is missing.")
    if ":" in raw:
        parts = raw.split(":")
        if len(parts) < 2:
            raise ValueError(f"Invalid time value: {raw}")
        hours = int(parts[0])
        minutes = int(parts[1])
        return f"{hours:02d}:{minutes:02d}"

    numeric = int(float(raw))
    hours = numeric // 100
    minutes = numeric % 100
    return f"{hours:02d}:{minutes:02d}"


def overlaps(start_a, end_a, start_b, end_b):
    return start_a < end_b and start_b < end_a


def minutes_between(start_dt, end_dt):
    return max(0, int((end_dt - start_dt).total_seconds() // 60))


def validate_and_normalize(payload):
    sessions_raw = payload.get("sessions") or []
    staff_raw = payload.get("invigilators") or []
    engagements_raw = payload.get("engagements") or []
    options = {**DEFAULT_OPTIONS, **(payload.get("options") or {})}

    if not isinstance(sessions_raw, list) or not isinstance(staff_raw, list) or not isinstance(engagements_raw, list):
        fail("Payload sessions, invigilators, and engagements must be arrays.")

    if not sessions_raw or not staff_raw:
        return [], [], [], options

    sessions = []
    seen_session_ids = set()
    session_errors = []

    for index, row in enumerate(sessions_raw, start=1):
        session_id = str(row.get("id") or "").strip()
        if not session_id:
            session_errors.append(f"Session row {index} is missing id.")
            continue
        if session_id in seen_session_ids:
            session_errors.append(f"Duplicate session id: {session_id}.")
            continue
        seen_session_ids.add(session_id)

        try:
            start_dt = parse_datetime(row.get("exam_date"), row.get("start_time"), f"Session {session_id}")
            end_dt = parse_datetime(row.get("exam_date"), row.get("end_time"), f"Session {session_id}")
        except ValueError as exc:
            session_errors.append(str(exc))
            continue

        if end_dt <= start_dt:
            session_errors.append(f"Session {session_id} has invalid time range: start must be before end.")
            continue

        ta_needed = int(row.get("ta_needed", 0) or 0)
        doctor_needed = int(row.get("doctor_needed", 0) or 0)
        if ta_needed < 0 or doctor_needed < 0:
            session_errors.append(f"Session {session_id} has negative staffing needs.")
            continue

        sessions.append({
            "id": session_id,
            "exam_date": str(row.get("exam_date") or "").strip(),
            "start_dt": start_dt,
            "end_dt": end_dt,
            "start_time": normalize_time_string(row.get("start_time")),
            "end_time": normalize_time_string(row.get("end_time")),
            "duration_minutes": minutes_between(start_dt, end_dt),
            "ta_needed": ta_needed,
            "doctor_needed": doctor_needed,
        })

    seen_staff_ids = set()
    staff_errors = []
    staff = []
    for index, row in enumerate(staff_raw, start=1):
        staff_id = str(row.get("staff_id") or "").strip()
        if not staff_id:
            staff_errors.append(f"Staff row {index} is missing staff_id.")
            continue
        if staff_id in seen_staff_ids:
            staff_errors.append(f"Duplicate staff_id: {staff_id}.")
            continue
        seen_staff_ids.add(staff_id)

        role = str(row.get("role") or "").strip()
        if role not in VALID_ROLES:
            staff_errors.append(f"Staff {staff_id} has invalid role: {role}.")
            continue

        max_hours = float(row.get("max_hours", 0) or 0)
        if max_hours < 0:
            staff_errors.append(f"Staff {staff_id} has negative max_hours.")
            continue

        staff.append({
            "staff_id": staff_id,
            "role": role,
            "max_minutes": int(round(max_hours * 60)),
            "load_type": str(row.get("load_type") or "full").strip().lower() or "full",
        })

    engagements = []
    engagement_errors = []
    for index, row in enumerate(engagements_raw, start=1):
        try:
            start_dt = parse_datetime(row.get("exam_date"), row.get("start_time"), f"Engagement row {index}")
            end_dt = parse_datetime(row.get("exam_date"), row.get("end_time"), f"Engagement row {index}")
        except ValueError as exc:
            engagement_errors.append(str(exc))
            continue

        if end_dt <= start_dt:
            engagement_errors.append(f"Engagement row {index} has invalid time range.")
            continue

        engagements.append({
            "staff_id": str(row.get("staff_id") or "").strip(),
            "engagement": int(row.get("engagement", 1) or 0),
            "start_dt": start_dt,
            "end_dt": end_dt,
        })

    errors = session_errors + staff_errors + engagement_errors
    if errors:
        fail("Invalid scheduler input.", details=errors)

    return sessions, staff, engagements, options


def build_eligibility(sessions, staff, engagements):
    blocked_pairs = set()
    for engagement in engagements:
        if engagement["engagement"] != 1:
            continue
        for session in sessions:
            if overlaps(session["start_dt"], session["end_dt"], engagement["start_dt"], engagement["end_dt"]):
                blocked_pairs.add((engagement["staff_id"], session["id"]))
    return blocked_pairs


def build_model(sessions, staff, engagements, options):
    model = cp_model.CpModel()

    sessions_by_id = {session["id"]: session for session in sessions}
    staff_by_id = {person["staff_id"]: person for person in staff}
    blocked_pairs = build_eligibility(sessions, staff, engagements)

    role_groups = {
        ROLE_TA: [person["staff_id"] for person in staff if person["role"] == ROLE_TA],
        ROLE_DOCTOR: [person["staff_id"] for person in staff if person["role"] == ROLE_DOCTOR],
    }

    x = {}
    for person in staff:
        staff_id = person["staff_id"]
        for session in sessions:
            session_id = session["id"]
            if person["role"] == ROLE_TA and session["ta_needed"] <= 0:
                continue
            if person["role"] == ROLE_DOCTOR and session["doctor_needed"] <= 0:
                continue
            if (staff_id, session_id) in blocked_pairs:
                continue
            x[(staff_id, session_id)] = model.NewBoolVar(f"x_{staff_id}_{session_id}")

    shortage_vars = {}
    for session in sessions:
        session_id = session["id"]
        for role, need_key in ((ROLE_TA, "ta_needed"), (ROLE_DOCTOR, "doctor_needed")):
            need = int(session[need_key])
            shortage = model.NewIntVar(0, need, f"short_{session_id}_{role}")
            shortage_vars[(session_id, role)] = shortage

            eligible_assignments = [
                x[(staff_id, session_id)]
                for staff_id in role_groups[role]
                if (staff_id, session_id) in x
            ]
            model.Add(sum(eligible_assignments) + shortage == need)

    for person in staff:
        staff_id = person["staff_id"]
        relevant_sessions = [
            session for session in sessions
            if (staff_id, session["id"]) in x
        ]

        for i, session_a in enumerate(relevant_sessions):
            for session_b in relevant_sessions[i + 1:]:
                if overlaps(session_a["start_dt"], session_a["end_dt"], session_b["start_dt"], session_b["end_dt"]):
                    model.Add(x[(staff_id, session_a["id"])] + x[(staff_id, session_b["id"])] <= 1)

    total_session_minutes = sum(session["duration_minutes"] for session in sessions)
    max_individual_minutes = max(
        max((person["max_minutes"] for person in staff), default=0),
        total_session_minutes,
        1,
    )

    load_minutes = {}
    for person in staff:
        staff_id = person["staff_id"]
        load_minutes[staff_id] = model.NewIntVar(0, max_individual_minutes, f"load_{staff_id}")
        terms = [
            sessions_by_id[session_id]["duration_minutes"] * x[(staff_id, session_id)]
            for (candidate_staff_id, session_id) in x
            if candidate_staff_id == staff_id
        ]
        if terms:
            model.Add(load_minutes[staff_id] == sum(terms))
        else:
            model.Add(load_minutes[staff_id] == 0)

        if person["max_minutes"] > 0:
            model.Add(load_minutes[staff_id] <= person["max_minutes"])

    max_load = model.NewIntVar(0, max_individual_minutes, "max_load")
    min_load = model.NewIntVar(0, max_individual_minutes, "min_load")
    for person in staff:
        model.Add(load_minutes[person["staff_id"]] <= max_load)
        model.Add(load_minutes[person["staff_id"]] >= min_load)

    spread = model.NewIntVar(0, max_individual_minutes, "load_spread")
    model.Add(spread == max_load - min_load)

    imbalance_terms = []
    for role, staff_ids in role_groups.items():
        for i, staff_a in enumerate(staff_ids):
            for staff_b in staff_ids[i + 1:]:
                diff = model.NewIntVar(0, max_individual_minutes, f"diff_{role}_{staff_a}_{staff_b}")
                model.AddAbsEquality(diff, load_minutes[staff_a] - load_minutes[staff_b])
                imbalance_terms.append(diff)

    daily_excess_terms = []
    sessions_by_date = defaultdict(list)
    for session in sessions:
        sessions_by_date[session["exam_date"]].append(session)

    soft_daily_limit = int(options["max_sessions_per_day_soft"])
    for person in staff:
        staff_id = person["staff_id"]
        for exam_date, day_sessions in sessions_by_date.items():
            day_vars = [
                x[(staff_id, session["id"])]
                for session in day_sessions
                if (staff_id, session["id"]) in x
            ]
            if not day_vars:
                continue
            day_count = model.NewIntVar(0, len(day_vars), f"day_count_{staff_id}_{exam_date}")
            model.Add(day_count == sum(day_vars))
            excess = model.NewIntVar(0, len(day_vars), f"day_excess_{staff_id}_{exam_date}")
            model.Add(excess >= day_count - soft_daily_limit)
            daily_excess_terms.append(excess)

    total_shortage = model.NewIntVar(
        0,
        sum(session["ta_needed"] + session["doctor_needed"] for session in sessions),
        "total_shortage",
    )
    model.Add(total_shortage == sum(shortage_vars.values()))

    objective_terms = [
        total_shortage * int(options["coverage_weight"]),
        max_load * int(options["max_load_weight"]),
        spread * int(options["spread_weight"]),
    ]
    if imbalance_terms:
        objective_terms.append(sum(imbalance_terms) * int(options["imbalance_weight"]))
    if daily_excess_terms:
        objective_terms.append(sum(daily_excess_terms) * int(options["daily_penalty_weight"]))
    model.Minimize(sum(objective_terms))

    return model, x, load_minutes, shortage_vars, sessions_by_id, staff_by_id


def solve(payload):
    sessions, staff, engagements, options = validate_and_normalize(payload)

    if not sessions or not staff:
        return {
            "status": "EMPTY",
            "placed": 0,
            "assignments": [],
            "failed": [],
            "staff_loads": [],
            "uncovered_sessions": [],
        }

    model, x, load_minutes, shortage_vars, sessions_by_id, staff_by_id = build_model(
        sessions, staff, engagements, options
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(options["time_limit_seconds"])
    solver.parameters.num_search_workers = 8

    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        uncovered = []
        for session in sessions:
            uncovered.append({
                "session_id": session["id"],
                "ta_missing": session["ta_needed"],
                "doctor_missing": session["doctor_needed"],
                "reason": "No feasible assignment found under hard constraints.",
            })
        return {
            "status": "INFEASIBLE",
            "placed": 0,
            "assignments": [],
            "failed": uncovered,
            "staff_loads": [
                {
                    "staff_id": person["staff_id"],
                    "role": person["role"],
                    "assigned_minutes": 0,
                    "assigned_hours": 0,
                    "max_hours": round(person["max_minutes"] / 60, 2),
                }
                for person in staff
            ],
            "uncovered_sessions": uncovered,
            "explanation": "Insufficient feasible staff coverage given role, overlap, engagement, or max-hours constraints.",
        }

    assignments = []
    for (staff_id, session_id), var in x.items():
        if solver.Value(var) == 1:
            assignments.append({
                "staff_id": staff_id,
                "session_id": session_id,
                "role": staff_by_id[staff_id]["role"],
            })

    staff_loads = []
    for person in staff:
        assigned_minutes = solver.Value(load_minutes[person["staff_id"]])
        staff_loads.append({
            "staff_id": person["staff_id"],
            "role": person["role"],
            "assigned_minutes": assigned_minutes,
            "assigned_hours": round(assigned_minutes / 60, 2),
            "max_hours": round(person["max_minutes"] / 60, 2),
        })

    uncovered_sessions = []
    for session in sessions:
        ta_missing = solver.Value(shortage_vars[(session["id"], ROLE_TA)])
        doctor_missing = solver.Value(shortage_vars[(session["id"], ROLE_DOCTOR)])
        if ta_missing or doctor_missing:
            uncovered_sessions.append({
                "session_id": session["id"],
                "ta_missing": ta_missing,
                "doctor_missing": doctor_missing,
                "reason": "Session could not be fully covered with available staff.",
            })

    status_name = solver.StatusName(status)
    result_status = status_name if not uncovered_sessions else f"{status_name}_PARTIAL"
    failed = list(uncovered_sessions)

    return {
        "status": result_status,
        "placed": len(assignments),
        "assignments": assignments,
        "failed": failed,
        "staff_loads": staff_loads,
        "uncovered_sessions": uncovered_sessions,
        "summary": {
            "total_assignments": len(assignments),
            "total_uncovered_sessions": len(uncovered_sessions),
        },
    }


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        fail(f"Invalid JSON input: {exc}", code="json_error")

    result = solve(payload)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
