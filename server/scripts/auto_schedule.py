import json
import math
import sys
from collections import defaultdict

try:
    from ortools.sat.python import cp_model
except Exception:  # pragma: no cover - runtime fallback when ortools is unavailable
    cp_model = None

VALID_POLICY_MODES = {"default", "exact", "add", "reduce", "exclude"}


def parse_time_to_minutes(value):
    raw = str(value or "").strip()
    if not raw:
        return 0
    if ":" in raw:
        hours, minutes = raw.split(":", 1)
        return int(hours) * 60 + int(minutes)
    numeric = int(float(raw))
    return (numeric // 100) * 60 + (numeric % 100)


def ranges_overlap(start_a, end_a, start_b, end_b):
    return start_a < end_b and start_b < end_a


def normalize_role(value):
    raw = str(value or "").strip().lower()
    if raw in {"doctor", "dr", "doc"}:
        return "Doctor"
    return "TA"


def validate_and_normalize(payload):
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object.")

    sessions_raw = payload.get("sessions") or []
    staff_raw = payload.get("invigilators") or []
    engagements_raw = payload.get("engagements") or []
    locked_assignments_raw = payload.get("locked_assignments") or []
    staff_hour_policies_raw = payload.get("staff_hour_policies") or []
    existing_duty_minutes_by_staff_raw = payload.get("existing_duty_minutes_by_staff") or {}
    additional_required_minutes_by_role_raw = payload.get("additional_required_minutes_by_role") or {}
    options = payload.get("options") or {}

    if not isinstance(sessions_raw, list):
        raise ValueError("sessions must be an array.")
    if not isinstance(staff_raw, list):
        raise ValueError("invigilators must be an array.")
    if not isinstance(engagements_raw, list):
        raise ValueError("engagements must be an array.")
    if not isinstance(locked_assignments_raw, list):
        raise ValueError("locked_assignments must be an array.")
    if not isinstance(staff_hour_policies_raw, list):
        raise ValueError("staff_hour_policies must be an array.")
    if not isinstance(existing_duty_minutes_by_staff_raw, dict):
        raise ValueError("existing_duty_minutes_by_staff must be an object.")
    if not isinstance(additional_required_minutes_by_role_raw, dict):
        raise ValueError("additional_required_minutes_by_role must be an object.")

    sessions = []
    for index, row in enumerate(sessions_raw):
        session_id = str(row.get("id") or row.get("session_id") or "").strip()
        exam_date = str(row.get("exam_date") or row.get("date") or "").strip()
        start_time = str(row.get("start_time") or row.get("startTime") or "").strip()
        end_time = str(row.get("end_time") or row.get("endTime") or "").strip()
        if not session_id or not exam_date or not start_time or not end_time:
            raise ValueError(f"Session row {index + 1} is missing id/date/start/end.")
        start_minutes = parse_time_to_minutes(start_time)
        end_minutes = parse_time_to_minutes(end_time)
        if end_minutes <= start_minutes:
            raise ValueError(f"Session {session_id} has invalid time range.")
        sessions.append({
            "id": session_id,
            "exam_date": exam_date,
            "start_time": start_time,
            "end_time": end_time,
            "start_minutes": start_minutes,
            "end_minutes": end_minutes,
            "duration_minutes": end_minutes - start_minutes,
            "ta_needed": max(0, int(row.get("ta_needed") or 0)),
            "doctor_needed": max(0, int(row.get("doctor_needed") or 0)),
        })

    staff = []
    for index, row in enumerate(staff_raw):
        staff_id = str(row.get("staff_id") or row.get("id") or "").strip()
        if not staff_id:
            raise ValueError(f"Invigilator row {index + 1} is missing staff_id.")
        max_hours = float(row.get("max_hours") or 0)
        staff.append({
            "staff_id": staff_id,
            "role": normalize_role(row.get("role")),
            "load_type": str(row.get("load_type") or "full").strip().lower() or "full",
            "max_hours": max(0.0, max_hours),
            "max_minutes": int(round(max(0.0, max_hours) * 60)),
        })

    engagements = []
    for row in engagements_raw:
        staff_id = str(row.get("staff_id") or "").strip()
        exam_date = str(row.get("exam_date") or row.get("date") or "").strip()
        start_time = str(row.get("start_time") or row.get("startTime") or "").strip()
        end_time = str(row.get("end_time") or row.get("endTime") or "").strip()
        engagement = int(row.get("engagement") if row.get("engagement") is not None else 1)
        if not staff_id or not exam_date or not start_time or not end_time or engagement != 1:
            continue
        engagements.append({
            "staff_id": staff_id,
            "exam_date": exam_date,
            "start_time": start_time,
            "end_time": end_time,
            "start_minutes": parse_time_to_minutes(start_time),
            "end_minutes": parse_time_to_minutes(end_time),
        })

    locked_assignments = []
    for row in locked_assignments_raw:
        staff_id = str(row.get("staff_id") or "").strip()
        session_id = str(row.get("session_id") or "").strip()
        role = normalize_role(row.get("role"))
        if staff_id and session_id:
            locked_assignments.append({
                "staff_id": staff_id,
                "session_id": session_id,
                "role": role,
            })

    staff_hour_policies = []
    for row in staff_hour_policies_raw:
        staff_id = str(row.get("staff_id") or "").strip()
        role = normalize_role(row.get("role"))
        mode = str(row.get("mode") or "default").strip().lower() or "default"
        if mode not in VALID_POLICY_MODES:
            raise ValueError(f"Invalid staff hour policy mode: {mode}")
        hours_value = float(row.get("hours_value") or 0)
        if hours_value < 0:
            raise ValueError("Staff hour policy hours_value cannot be negative.")
        exclude_from_auto_schedule = bool(row.get("exclude_from_auto_schedule") or mode == "exclude")
        notes = str(row.get("notes") or "").strip()
        if staff_id:
            staff_hour_policies.append({
                "staff_id": staff_id,
                "role": role,
                "mode": mode,
                "hours_value": max(0.0, hours_value),
                "exclude_from_auto_schedule": exclude_from_auto_schedule,
                "notes": notes,
            })

    existing_duty_minutes_by_staff = {}
    for key, value in existing_duty_minutes_by_staff_raw.items():
        staff_id = str(key or "").strip()
        if not staff_id:
            continue
        try:
            minutes = int(round(float(value or 0)))
        except Exception:
            minutes = 0
        existing_duty_minutes_by_staff[staff_id] = max(0, minutes)

    additional_required_minutes_by_role = {
        "TA": max(0, int(round(float(additional_required_minutes_by_role_raw.get("TA") or 0)))),
        "Doctor": max(0, int(round(float(additional_required_minutes_by_role_raw.get("Doctor") or 0)))),
    }

    return sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options


def compute_hour_policy_summary(sessions, staff, staff_hour_policies, additional_required_minutes_by_role=None):
    additional_required_minutes_by_role = additional_required_minutes_by_role or {"TA": 0, "Doctor": 0}
    total_required_minutes_by_role = {"TA": 0, "Doctor": 0}
    for session in sessions:
        total_required_minutes_by_role["TA"] += session["ta_needed"] * session["duration_minutes"]
        total_required_minutes_by_role["Doctor"] += session["doctor_needed"] * session["duration_minutes"]
    total_required_minutes_by_role["TA"] += int(additional_required_minutes_by_role.get("TA") or 0)
    total_required_minutes_by_role["Doctor"] += int(additional_required_minutes_by_role.get("Doctor") or 0)

    policy_by_staff_id = {}
    for row in staff_hour_policies:
        policy_by_staff_id[row["staff_id"]] = row

    available_staff_by_role = {"TA": [], "Doctor": []}
    for person in staff:
        policy = policy_by_staff_id.get(person["staff_id"])
        excluded = bool(policy and (policy["mode"] == "exclude" or policy["exclude_from_auto_schedule"]))
        if not excluded:
            available_staff_by_role[person["role"]].append(person)

    raw_average_minutes_by_role = {
        role: (round(total_required_minutes_by_role[role] / len(available_staff_by_role[role])) if available_staff_by_role[role] else 0)
        for role in ("TA", "Doctor")
    }

    effective_policy_by_staff = {}
    excluded_staff = []
    for person in staff:
        role = person["role"]
        raw_average_minutes = raw_average_minutes_by_role[role]
        policy = policy_by_staff_id.get(person["staff_id"])
        mode = policy["mode"] if policy else "default"
        hours_value = max(0.0, float(policy["hours_value"])) if policy else 0.0
        value_minutes = int(round(hours_value * 60))
        allowed_minutes = raw_average_minutes
        excluded = False

        if mode == "exact":
            allowed_minutes = value_minutes
        elif mode == "add":
            allowed_minutes = raw_average_minutes + value_minutes
        elif mode == "reduce":
            allowed_minutes = max(0, raw_average_minutes - value_minutes)
        elif mode == "exclude":
            allowed_minutes = 0
            excluded = True

        if policy and policy["exclude_from_auto_schedule"]:
            excluded = True

        max_minutes = person["max_minutes"]
        if excluded:
            hard_limit_minutes = 0
        elif mode == "exact":
            hard_limit_minutes = min(max_minutes, allowed_minutes) if max_minutes > 0 else allowed_minutes
        elif max_minutes > 0:
            hard_limit_minutes = max_minutes
        else:
            hard_limit_minutes = 0

        effective = {
            "staff_id": person["staff_id"],
            "role": role,
            "mode": mode,
            "hours_value": hours_value,
            "raw_average_minutes": raw_average_minutes,
            "raw_average_hours": round(raw_average_minutes / 60.0, 2),
            "allowed_minutes": allowed_minutes,
            "allowed_hours": round(allowed_minutes / 60.0, 2),
            "hard_limit_minutes": hard_limit_minutes,
            "hard_limit_hours": round(hard_limit_minutes / 60.0, 2),
            "excluded": excluded,
            "notes": policy["notes"] if policy else "",
            "has_custom_policy": bool(policy),
            "exclude_from_auto_schedule": excluded,
        }
        if excluded:
            excluded_staff.append(person["staff_id"])
        effective_policy_by_staff[person["staff_id"]] = effective

    return {
        "total_required_minutes_by_role": total_required_minutes_by_role,
        "total_required_hours_by_role": {
            role: round(minutes / 60.0, 2) for role, minutes in total_required_minutes_by_role.items()
        },
        "available_staff_count_by_role": {
            role: len(available_staff_by_role[role]) for role in ("TA", "Doctor")
        },
        "raw_average_minutes_by_role": raw_average_minutes_by_role,
        "raw_average_hours_by_role": {
            role: round(minutes / 60.0, 2) for role, minutes in raw_average_minutes_by_role.items()
        },
        "effective_policy_by_staff": effective_policy_by_staff,
        "excluded_staff": sorted(set(excluded_staff)),
    }


def build_indices(sessions, staff, engagements, locked_assignments, policy_summary, existing_duty_minutes_by_staff=None):
    existing_duty_minutes_by_staff = existing_duty_minutes_by_staff or {}
    session_by_id = {session["id"]: session for session in sessions}
    staff_by_id = {person["staff_id"]: person for person in staff}
    engagement_by_staff_date = defaultdict(list)
    for row in engagements:
        engagement_by_staff_date[(row["staff_id"], row["exam_date"])].append(row)

    overlaps_by_session = defaultdict(set)
    sessions_by_date = defaultdict(list)
    for session in sessions:
        sessions_by_date[session["exam_date"]].append(session)
    for rows in sessions_by_date.values():
        for idx, left in enumerate(rows):
            for right in rows[idx + 1:]:
                if ranges_overlap(left["start_minutes"], left["end_minutes"], right["start_minutes"], right["end_minutes"]):
                    overlaps_by_session[left["id"]].add(right["id"])
                    overlaps_by_session[right["id"]].add(left["id"])

    locked_by_session_role = defaultdict(list)
    locked_by_staff = defaultdict(list)
    baseline_minutes_by_staff = defaultdict(int)
    for staff_id, minutes in existing_duty_minutes_by_staff.items():
        baseline_minutes_by_staff[staff_id] += int(minutes or 0)
    for row in locked_assignments:
        session = session_by_id.get(row["session_id"])
        person = staff_by_id.get(row["staff_id"])
        if not session or not person or person["role"] != row["role"]:
            continue
        locked_by_session_role[(row["session_id"], row["role"])].append(row["staff_id"])
        locked_by_staff[row["staff_id"]].append(row["session_id"])
        baseline_minutes_by_staff[row["staff_id"]] += session["duration_minutes"]

    return {
        "session_by_id": session_by_id,
        "staff_by_id": staff_by_id,
        "engagement_by_staff_date": engagement_by_staff_date,
        "overlaps_by_session": overlaps_by_session,
        "locked_by_session_role": locked_by_session_role,
        "locked_by_staff": locked_by_staff,
        "baseline_minutes_by_staff": baseline_minutes_by_staff,
        "policy_summary": policy_summary,
    }


def is_staff_available_for_session(session, person, indices):
    if person["role"] not in ("TA", "Doctor"):
        return False, "role"
    policy = indices["policy_summary"]["effective_policy_by_staff"].get(person["staff_id"], {})
    if policy.get("excluded"):
        return False, "policy_excluded"

    for row in indices["engagement_by_staff_date"].get((person["staff_id"], session["exam_date"]), []):
        if ranges_overlap(session["start_minutes"], session["end_minutes"], row["start_minutes"], row["end_minutes"]):
            return False, "engagement"

    for other_session_id in indices["locked_by_staff"].get(person["staff_id"], []):
        if other_session_id == session["id"]:
            return False, "already_assigned"
        other_session = indices["session_by_id"].get(other_session_id)
        if other_session and other_session["exam_date"] == session["exam_date"]:
            if ranges_overlap(session["start_minutes"], session["end_minutes"], other_session["start_minutes"], other_session["end_minutes"]):
                return False, "overlap"

    return True, "ok"


def build_candidates(sessions, staff, indices):
    candidates = []
    candidates_by_session_role = defaultdict(list)
    candidates_by_staff = defaultdict(list)
    excluded_staff_skipped = set()
    for session in sessions:
        for person in staff:
            role = person["role"]
            if role == "TA" and session["ta_needed"] <= 0:
                continue
            if role == "Doctor" and session["doctor_needed"] <= 0:
                continue
            if person["staff_id"] in indices["locked_by_session_role"].get((session["id"], role), []):
                continue
            available, reason = is_staff_available_for_session(session, person, indices)
            if not available:
                if reason == "policy_excluded":
                    excluded_staff_skipped.add(person["staff_id"])
                continue
            row = {
                "session_id": session["id"],
                "staff_id": person["staff_id"],
                "role": role,
                "duration_minutes": session["duration_minutes"],
            }
            candidates.append(row)
            candidates_by_session_role[(session["id"], role)].append(row)
            candidates_by_staff[person["staff_id"]].append(row)
    return candidates, candidates_by_session_role, candidates_by_staff, sorted(excluded_staff_skipped)


def build_result_payload(status, sessions, staff, assignments, uncovered_sessions, load_minutes_by_staff, policy_summary=None, explanation=None, excluded_staff_skipped=None):
    policy_summary = policy_summary or {
        "raw_average_hours_by_role": {"TA": 0, "Doctor": 0},
        "effective_policy_by_staff": {},
        "excluded_staff": [],
    }
    assigned_hours_by_staff = {
        staff_id: round(minutes / 60.0, 2) for staff_id, minutes in load_minutes_by_staff.items()
    }
    effective_allowed_hours_by_staff = {
        staff_id: round(float(row.get("allowed_minutes", 0)) / 60.0, 2)
        for staff_id, row in policy_summary["effective_policy_by_staff"].items()
    }
    over_limit_staff = []
    under_target_staff = []
    policy_violations = []
    for person in staff:
        effective = policy_summary["effective_policy_by_staff"].get(person["staff_id"], {})
        assigned_minutes = load_minutes_by_staff.get(person["staff_id"], 0)
        hard_limit = int(effective.get("hard_limit_minutes", 0) or 0)
        allowed = int(effective.get("allowed_minutes", 0) or 0)
        if hard_limit > 0 and assigned_minutes > hard_limit:
            over_limit_staff.append(person["staff_id"])
            policy_violations.append({
                "staff_id": person["staff_id"],
                "assigned_hours": round(assigned_minutes / 60.0, 2),
                "allowed_hours": round(hard_limit / 60.0, 2),
            })
        elif allowed > 0 and assigned_minutes < allowed:
            under_target_staff.append(person["staff_id"])

    uncovered_total = sum(int(item.get("remaining", 0)) for item in uncovered_sessions)
    role_spread = {}
    staff_loads = []
    for role in ("TA", "Doctor"):
        role_minutes = [load_minutes_by_staff.get(person["staff_id"], 0) for person in staff if person["role"] == role]
        role_spread[role] = round((max(role_minutes) - min(role_minutes)) / 60.0, 2) if role_minutes else 0

    for person in staff:
        assigned_minutes = load_minutes_by_staff.get(person["staff_id"], 0)
        effective = policy_summary["effective_policy_by_staff"].get(person["staff_id"], {})
        staff_loads.append({
            "staff_id": person["staff_id"],
            "role": person["role"],
            "assigned_minutes": assigned_minutes,
            "assigned_hours": round(assigned_minutes / 60.0, 2),
            "policy_mode": effective.get("mode", "default"),
            "allowed_hours": round(float(effective.get("allowed_minutes", 0)) / 60.0, 2),
            "excluded": bool(effective.get("excluded")),
        })

    placed = len(assignments)
    return {
        "status": status,
        "placed": placed,
        "assignments": assignments,
        "uncovered_sessions": uncovered_sessions,
        "staff_loads": staff_loads,
        "assignedHoursByStaff": assigned_hours_by_staff,
        "averageHoursByRole": policy_summary.get("raw_average_hours_by_role", {"TA": 0, "Doctor": 0}),
        "effectiveAllowedHoursByStaff": effective_allowed_hours_by_staff,
        "overLimitStaff": over_limit_staff,
        "underTargetStaff": under_target_staff,
        "excludedStaffSkipped": excluded_staff_skipped or [],
        "policyViolations": policy_violations,
        "shortageRemaining": uncovered_total,
        "roleHourSpread": role_spread,
        "explanation": explanation or "",
    }


def build_result_metrics(result):
    assignments = result.get("assignments") or []
    uncovered_sessions = result.get("uncovered_sessions") or []
    staff_loads = result.get("staff_loads") or []
    assigned_hours_by_staff = result.get("assignedHoursByStaff") or {}

    duty_counts_by_staff = defaultdict(int)
    for item in assignments:
        duty_counts_by_staff[item["staff_id"]] += 1

    role_duty_counts = defaultdict(list)
    max_assigned_hours_by_role = {"TA": 0, "Doctor": 0}
    for row in staff_loads:
        role = row.get("role") or "TA"
        role_duty_counts[role].append(duty_counts_by_staff.get(row["staff_id"], 0))
        max_assigned_hours_by_role[role] = max(
            max_assigned_hours_by_role.get(role, 0),
            float(assigned_hours_by_staff.get(row["staff_id"], 0) or 0),
        )

    role_hour_spread = result.get("roleHourSpread") or {"TA": 0, "Doctor": 0}
    role_duty_spread = {}
    for role in ("TA", "Doctor"):
        counts = role_duty_counts.get(role, [])
        role_duty_spread[role] = (max(counts) - min(counts)) if counts else 0

    total_shortage = sum(int(item.get("remaining", 0) or 0) for item in uncovered_sessions)
    uncovered_session_count = sum(1 for item in uncovered_sessions if int(item.get("remaining", 0) or 0) > 0)
    policy_violation_count = len(result.get("policyViolations") or [])
    over_limit_staff_count = len(result.get("overLimitStaff") or [])

    return {
        "totalShortage": total_shortage,
        "uncoveredSessionCount": uncovered_session_count,
        "placedDuties": int(result.get("placed", len(assignments)) or 0),
        "policyViolationCount": policy_violation_count,
        "overLimitStaffCount": over_limit_staff_count,
        "roleHourSpread": {
            "TA": round(float(role_hour_spread.get("TA", 0) or 0), 2),
            "Doctor": round(float(role_hour_spread.get("Doctor", 0) or 0), 2),
        },
        "maxAssignedHoursByRole": {
            "TA": round(float(max_assigned_hours_by_role.get("TA", 0) or 0), 2),
            "Doctor": round(float(max_assigned_hours_by_role.get("Doctor", 0) or 0), 2),
        },
        "dutyCountSpreadByRole": {
            "TA": int(role_duty_spread.get("TA", 0) or 0),
            "Doctor": int(role_duty_spread.get("Doctor", 0) or 0),
        },
    }


def compare_result_metrics(cp_metrics, fallback_metrics):
    checks = [
        ("totalShortage", "lower", "lower total staffing shortage"),
        ("uncoveredSessionCount", "lower", "fewer uncovered sessions"),
        ("placedDuties", "higher", "more placed duties"),
        ("policyViolationCount", "lower", "fewer policy violations"),
        ("overLimitStaffCount", "lower", "fewer over-limit staff"),
        ("roleHourSpread", "lower_sum", "better hour fairness"),
        ("dutyCountSpreadByRole", "lower_sum", "lower duty-count imbalance"),
    ]

    for field, direction, label in checks:
        cp_value = cp_metrics.get(field)
        fallback_value = fallback_metrics.get(field)
        if direction == "lower":
            if cp_value < fallback_value:
                return "cp_sat", label
            if cp_value > fallback_value:
                return "fallback", label
        elif direction == "higher":
            if cp_value > fallback_value:
                return "cp_sat", label
            if cp_value < fallback_value:
                return "fallback", label
        elif direction == "lower_sum":
            cp_sum = round(sum(float(value or 0) for value in (cp_value or {}).values()), 4)
            fallback_sum = round(sum(float(value or 0) for value in (fallback_value or {}).values()), 4)
            if cp_sum < fallback_sum:
                return "cp_sat", label
            if cp_sum > fallback_sum:
                return "fallback", label

    return "cp_sat", "equal metrics; defaulting to CP-SAT"


def decorate_selected_result(selected_solver, selected_result, cp_sat_result, fallback_result, selection_reason, cp_sat_status=None, fallback_status=None):
    cp_metrics = build_result_metrics(cp_sat_result) if cp_sat_result else {
        "totalShortage": None,
        "uncoveredSessionCount": None,
        "placedDuties": None,
        "policyViolationCount": None,
        "overLimitStaffCount": None,
        "roleHourSpread": {"TA": None, "Doctor": None},
        "maxAssignedHoursByRole": {"TA": None, "Doctor": None},
        "dutyCountSpreadByRole": {"TA": None, "Doctor": None},
    }
    fallback_metrics = build_result_metrics(fallback_result) if fallback_result else {
        "totalShortage": None,
        "uncoveredSessionCount": None,
        "placedDuties": None,
        "policyViolationCount": None,
        "overLimitStaffCount": None,
        "roleHourSpread": {"TA": None, "Doctor": None},
        "maxAssignedHoursByRole": {"TA": None, "Doctor": None},
        "dutyCountSpreadByRole": {"TA": None, "Doctor": None},
    }
    selected_metrics = cp_metrics if selected_solver == "cp_sat" else fallback_metrics
    selected_result["selectedSolver"] = selected_solver
    selected_result["cpSatStatus"] = cp_sat_status or (cp_sat_result or {}).get("status") or "UNAVAILABLE"
    selected_result["fallbackStatus"] = fallback_status or (fallback_result or {}).get("status") or "UNAVAILABLE"
    selected_result["selectionReason"] = selection_reason
    selected_result["cpSatMetrics"] = cp_metrics
    selected_result["fallbackMetrics"] = fallback_metrics
    selected_result["selectedMetrics"] = selected_metrics
    return selected_result


def greedy_fallback_schedule(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff=None, additional_required_minutes_by_role=None):
    policy_summary = compute_hour_policy_summary(sessions, staff, staff_hour_policies, additional_required_minutes_by_role)
    indices = build_indices(sessions, staff, engagements, locked_assignments, policy_summary, existing_duty_minutes_by_staff)
    _, candidates_by_session_role, _, excluded_staff_skipped = build_candidates(sessions, staff, indices)
    assignments = []
    load_minutes_by_staff = defaultdict(int, indices["baseline_minutes_by_staff"])
    duty_count_by_staff = defaultdict(int)

    for locked in locked_assignments:
        session = indices["session_by_id"].get(locked["session_id"])
        if not session:
            continue
        assignments.append({
            "staff_id": locked["staff_id"],
            "session_id": locked["session_id"],
            "role": locked["role"],
            "locked": True,
        })
        duty_count_by_staff[locked["staff_id"]] += 1

    uncovered_sessions = []
    shortage_tasks = []
    for session in sessions:
        for role, needed_key in (("TA", "ta_needed"), ("Doctor", "doctor_needed")):
            required = int(session[needed_key])
            locked_staff = indices["locked_by_session_role"].get((session["id"], role), [])
            remaining = max(0, required - len(locked_staff))
            if remaining == 0:
                continue
            base_candidate_count = len(candidates_by_session_role.get((session["id"], role), []))
            shortage_tasks.append({
                "session": session,
                "role": role,
                "remaining": remaining,
                "base_candidate_count": base_candidate_count,
            })

    shortage_tasks.sort(
        key=lambda item: (
            item["base_candidate_count"],
            -item["remaining"],
            item["session"]["exam_date"],
            item["session"]["start_minutes"],
            -item["session"]["duration_minutes"],
            item["session"]["id"],
            item["role"],
        )
    )

    for task in shortage_tasks:
        session = task["session"]
        role = task["role"]
        locked_staff = indices["locked_by_session_role"].get((session["id"], role), [])
        already_assigned_for_role = [
            item["staff_id"]
            for item in assignments
            if item["session_id"] == session["id"] and item["role"] == role
        ]
        remaining = max(0, task["remaining"] - len([staff_id for staff_id in already_assigned_for_role if staff_id not in locked_staff]))
        if remaining == 0:
            continue

        candidates = []
        for person in staff:
            if person["role"] != role:
                continue
            if person["staff_id"] in locked_staff:
                continue
            if person["staff_id"] in already_assigned_for_role:
                continue
            available, _ = is_staff_available_for_session(session, person, indices)
            if not available:
                continue
            if any(
                assigned["staff_id"] == person["staff_id"]
                and indices["session_by_id"][assigned["session_id"]]["exam_date"] == session["exam_date"]
                and ranges_overlap(
                    session["start_minutes"],
                    session["end_minutes"],
                    indices["session_by_id"][assigned["session_id"]]["start_minutes"],
                    indices["session_by_id"][assigned["session_id"]]["end_minutes"],
                )
                for assigned in assignments
            ):
                continue
            effective = policy_summary["effective_policy_by_staff"].get(person["staff_id"], {})
            projected = load_minutes_by_staff[person["staff_id"]] + session["duration_minutes"]
            max_minutes = int(person.get("max_minutes", 0) or 0)
            if max_minutes > 0 and projected > max_minutes:
                continue
            allowed = int(effective.get("allowed_minutes", 0) or 0)
            load_ratio = projected / allowed if allowed > 0 else projected / max(1, session["duration_minutes"])
            candidates.append((load_ratio, projected, duty_count_by_staff[person["staff_id"]], person["staff_id"]))

        candidates.sort()
        chosen = candidates[:remaining]
        for _, projected, _, staff_id in chosen:
            assignments.append({
                "staff_id": staff_id,
                "session_id": session["id"],
                "role": role,
                "locked": False,
            })
            load_minutes_by_staff[staff_id] = projected
            duty_count_by_staff[staff_id] += 1

        still_missing = remaining - len(chosen)
        if still_missing > 0:
            uncovered_sessions.append({
                "session_id": session["id"],
                "role": role,
                "remaining": still_missing,
                "shortage": still_missing,
            })

    status = "FALLBACK_OPTIMAL" if not uncovered_sessions else "FALLBACK_PARTIAL"
    explanation = (
        "Greedy fallback used. Coverage remains the top priority. Then the model tries to reduce within-role total-hour variance. Staff hour policy is treated as a soft target, while engagements, overlaps, exclusion, and max-hours remain hard restrictions."
    )
    return build_result_payload(
        status,
        sessions,
        staff,
        assignments,
        uncovered_sessions,
        load_minutes_by_staff,
        policy_summary=policy_summary,
        explanation=explanation,
        excluded_staff_skipped=excluded_staff_skipped,
    )


def build_model(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options):
    policy_summary = compute_hour_policy_summary(sessions, staff, staff_hour_policies, additional_required_minutes_by_role)
    indices = build_indices(sessions, staff, engagements, locked_assignments, policy_summary, existing_duty_minutes_by_staff)
    candidates, candidates_by_session_role, candidates_by_staff, excluded_staff_skipped = build_candidates(sessions, staff, indices)
    model = cp_model.CpModel()

    x = {}
    for row in candidates:
        key = (row["staff_id"], row["session_id"], row["role"])
        x[key] = model.NewBoolVar(f"x_{row['staff_id']}_{row['session_id']}_{row['role']}")

    shortage_vars = {}
    shortage_session_vars = {}
    for session in sessions:
        for role, needed_key in (("TA", "ta_needed"), ("Doctor", "doctor_needed")):
            required = int(session[needed_key])
            if required <= 0:
                continue
            locked_count = len(indices["locked_by_session_role"].get((session["id"], role), []))
            remaining_required = max(0, required - locked_count)
            var = model.NewIntVar(0, remaining_required, f"short_{session['id']}_{role}")
            shortage_vars[(session["id"], role)] = var
            session_short = model.NewBoolVar(f"short_any_{session['id']}_{role}")
            shortage_session_vars[(session["id"], role)] = session_short
            session_candidates = [x[(row["staff_id"], row["session_id"], row["role"])] for row in candidates_by_session_role.get((session["id"], role), [])]
            model.Add(sum(session_candidates) + var == remaining_required)
            model.Add(var == 0).OnlyEnforceIf(session_short.Not())
            model.Add(var >= 1).OnlyEnforceIf(session_short)

    for person in staff:
        person_candidates = candidates_by_staff.get(person["staff_id"], [])
        vars_for_staff = [x[(row["staff_id"], row["session_id"], row["role"])] for row in person_candidates]
        if not vars_for_staff:
            continue

        person_sessions = [indices["session_by_id"][row["session_id"]] for row in person_candidates]
        grouped = defaultdict(list)
        for row in person_candidates:
            grouped[row["session_id"]].append(x[(row["staff_id"], row["session_id"], row["role"])])
        for vars_same_session in grouped.values():
            model.Add(sum(vars_same_session) <= 1)

        date_groups = defaultdict(list)
        for row in person_candidates:
            session = indices["session_by_id"][row["session_id"]]
            date_groups[session["exam_date"]].append(row)
        for rows in date_groups.values():
            for idx, left in enumerate(rows):
                left_session = indices["session_by_id"][left["session_id"]]
                for right in rows[idx + 1:]:
                    right_session = indices["session_by_id"][right["session_id"]]
                    if ranges_overlap(left_session["start_minutes"], left_session["end_minutes"], right_session["start_minutes"], right_session["end_minutes"]):
                        model.Add(
                            x[(left["staff_id"], left["session_id"], left["role"])]
                            + x[(right["staff_id"], right["session_id"], right["role"])]
                            <= 1
                        )

        effective = policy_summary["effective_policy_by_staff"].get(person["staff_id"], {})
        baseline_minutes = indices["baseline_minutes_by_staff"].get(person["staff_id"], 0)
        total_load = model.NewIntVar(baseline_minutes, baseline_minutes + sum(session["duration_minutes"] for session in sessions), f"load_{person['staff_id']}")
        model.Add(
            total_load
            == baseline_minutes
            + sum(
                indices["session_by_id"][row["session_id"]]["duration_minutes"] * x[(row["staff_id"], row["session_id"], row["role"])]
                for row in person_candidates
            )
        )
        person["load_var"] = total_load

        max_minutes = int(person.get("max_minutes", 0) or 0)
        if max_minutes > 0:
            model.Add(total_load <= max_minutes)

    objective_terms = []
    coverage_weight = int(options.get("coverage_weight") or 1000000)
    shortage_session_weight = 100000
    spread_weight = int(options.get("spread_weight") or 100)
    imbalance_weight = int(options.get("imbalance_weight") or 1)
    variance_weight = int(options.get("variance_weight") or 0)
    duty_weight = int(options.get("duty_weight") or 0)

    for var in shortage_vars.values():
        objective_terms.append(coverage_weight * var)
    for var in shortage_session_vars.values():
        objective_terms.append(shortage_session_weight * var)

    for person in staff:
        total_load = person.get("load_var")
        if total_load is None:
            continue
        effective = policy_summary["effective_policy_by_staff"].get(person["staff_id"], {})
        target = int(effective.get("allowed_minutes", 0) or 0)
        if target > 0:
            deviation = model.NewIntVar(0, max(target, 24 * 60), f"dev_{person['staff_id']}")
            model.AddAbsEquality(deviation, total_load - target)
            objective_terms.append(spread_weight * deviation)
        duty_count = model.NewIntVar(0, len(candidates_by_staff.get(person["staff_id"], [])) + len(indices["locked_by_staff"].get(person["staff_id"], [])), f"duty_{person['staff_id']}")
        model.Add(
            duty_count
            == len(indices["locked_by_staff"].get(person["staff_id"], []))
            + sum(x[(row["staff_id"], row["session_id"], row["role"])] for row in candidates_by_staff.get(person["staff_id"], []))
        )
        objective_terms.append(duty_weight * duty_count)

    for role in ("TA", "Doctor"):
        role_people = [person for person in staff if person["role"] == role and person.get("load_var") is not None]
        if not role_people:
            continue
        max_bound = max(
            [indices["baseline_minutes_by_staff"].get(person["staff_id"], 0)] + [sum(session["duration_minutes"] for session in sessions)]
        )
        role_max = model.NewIntVar(0, max_bound, f"{role}_max_load")
        role_min = model.NewIntVar(0, max_bound, f"{role}_min_load")
        for person in role_people:
            model.Add(person["load_var"] <= role_max)
            model.Add(person["load_var"] >= role_min)
        objective_terms.append(imbalance_weight * (role_max - role_min))
        if variance_weight > 0 and len(role_people) > 1:
            for left_index, left_person in enumerate(role_people):
                for right_person in role_people[left_index + 1:]:
                    pair_diff = model.NewIntVar(0, max_bound, f"{role}_pairdiff_{left_person['staff_id']}_{right_person['staff_id']}")
                    model.AddAbsEquality(pair_diff, left_person["load_var"] - right_person["load_var"])
                    objective_terms.append(variance_weight * pair_diff)

    model.Minimize(sum(objective_terms))
    return model, x, indices, policy_summary, excluded_staff_skipped


def solve_with_cp_sat(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options):
    model, x, indices, policy_summary, excluded_staff_skipped = build_model(
        sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options
    )
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(options.get("time_limit_seconds") or 60)
    solver.parameters.num_search_workers = 8

    status = solver.Solve(model)
    status_name = solver.StatusName(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None, status_name

    assignments = []
    load_minutes_by_staff = defaultdict(int, indices["baseline_minutes_by_staff"])
    for locked in locked_assignments:
        session = indices["session_by_id"].get(locked["session_id"])
        if not session:
            continue
        assignments.append({
            "staff_id": locked["staff_id"],
            "session_id": locked["session_id"],
            "role": locked["role"],
            "locked": True,
        })

    for (staff_id, session_id, role), var in x.items():
        if solver.Value(var):
            assignments.append({
                "staff_id": staff_id,
                "session_id": session_id,
                "role": role,
                "locked": False,
            })
            load_minutes_by_staff[staff_id] += indices["session_by_id"][session_id]["duration_minutes"]

    uncovered_sessions = []
    for session in sessions:
        for role, needed_key in (("TA", "ta_needed"), ("Doctor", "doctor_needed")):
            required = int(session[needed_key])
            if required <= 0:
                continue
            assigned_count = sum(1 for item in assignments if item["session_id"] == session["id"] and item["role"] == role)
            remaining = max(0, required - assigned_count)
            if remaining > 0:
                uncovered_sessions.append({
                    "session_id": session["id"],
                    "role": role,
                    "remaining": remaining,
                    "shortage": remaining,
                })

    result_status = status_name
    explanation = "CP-SAT used. Objective prioritizes shortage first, then reducing within-role total-hour variance and spread. Staff hour policy is treated as a soft target, while engagements, overlaps, exclusion, and max-hours remain hard restrictions."
    if uncovered_sessions:
        result_status = f"{status_name}_PARTIAL"
    return build_result_payload(
        result_status,
        sessions,
        staff,
        assignments,
        uncovered_sessions,
        load_minutes_by_staff,
        policy_summary=policy_summary,
        explanation=explanation,
        excluded_staff_skipped=excluded_staff_skipped,
    ), status_name


def solve(payload):
    sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options = validate_and_normalize(payload)
    if cp_model is None:
        fallback_result = greedy_fallback_schedule(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role)
        return decorate_selected_result(
            "fallback",
            fallback_result,
            None,
            fallback_result,
            "CP-SAT unavailable; used fallback",
            cp_sat_status="UNAVAILABLE",
            fallback_status=fallback_result.get("status"),
        )

    cp_sat_result, cp_sat_status = solve_with_cp_sat(
        sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options
    )
    fallback_result = greedy_fallback_schedule(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role)
    fallback_status = fallback_result.get("status")

    if cp_sat_result is None:
        return decorate_selected_result(
            "fallback",
            fallback_result,
            None,
            fallback_result,
            f"CP-SAT returned {cp_sat_status}; fallback selected",
            cp_sat_status=cp_sat_status,
            fallback_status=fallback_status,
        )

    winner, reason = compare_result_metrics(
        build_result_metrics(cp_sat_result),
        build_result_metrics(fallback_result),
    )
    selected_result = cp_sat_result if winner == "cp_sat" else fallback_result
    return decorate_selected_result(
        winner,
        selected_result,
        cp_sat_result,
        fallback_result,
        f"Selected {winner} due to {reason}",
        cp_sat_status=cp_sat_status,
        fallback_status=fallback_status,
    )


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        result = solve(payload)
        sys.stdout.write(json.dumps(result))
    except Exception as error:  # pragma: no cover - CLI path
        sys.stdout.write(json.dumps({
            "status": "ERROR",
            "error": str(error),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
