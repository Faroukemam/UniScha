import json
import math
import sys
import time
from collections import defaultdict
from datetime import date

try:
    from ortools.sat.python import cp_model
except Exception:  # pragma: no cover - runtime fallback when ortools is unavailable
    cp_model = None

VALID_POLICY_MODES = {"default", "exact", "add", "reduce", "exclude"}
DEFAULT_PREFERENCE_ORDER = ("engagement_overrides", "consecutive_days", "consecutive_duties", "daily_soft_target")
DEFAULT_PREFERENCE_WEIGHTS = {"engagement_overrides": 100, "consecutive_days": 50, "consecutive_duties": 10, "daily_soft_target": 1}


def weighted_preference_cost(values, options):
    weights = options.get("preference_weights", DEFAULT_PREFERENCE_WEIGHTS)
    daily_weight = max(1, int(options.get("daily_penalty_weight", 5)))
    return (values["engagement_overrides"] * weights["engagement_overrides"]
            + 60 * values["consecutive_days"] * weights["consecutive_days"]
            + values["consecutive_duties"] * weights["consecutive_duties"]
            + 60 * (values["daily_soft_target"] // daily_weight) * weights["daily_soft_target"])


def preference_key(values, options):
    ordered = tuple(values[key] for key in scheduling_preference_order(options))
    return (weighted_preference_cost(values, options),) + ordered if options.get("scoring_mode") == "weighted" else ordered


def attach_preference_metadata(result, options):
    result["preferenceOrder"] = scheduling_preference_order(options)
    result["scoringMode"] = options.get("scoring_mode", "ranked")
    result["preferenceWeights"] = options.get("preference_weights", dict(DEFAULT_PREFERENCE_WEIGHTS))
    values = {"engagement_overrides": result.get("engagementOverrideMinutes", 0),
              "consecutive_days": result.get("continuityDayGaps", 0),
              "consecutive_duties": result.get("continuityIdleMinutes", 0), "daily_soft_target": result.get("dailyPenalty", 0)}
    result["weightedPreferenceScore"] = weighted_preference_cost(values, options)
    result["preferenceScore"] = round(result["weightedPreferenceScore"] / 60, 4)



def scheduling_preference_order(options):
    order = options.get("preference_order", list(DEFAULT_PREFERENCE_ORDER))
    if not isinstance(order, list) or len(order) != len(DEFAULT_PREFERENCE_ORDER) or set(order) != set(DEFAULT_PREFERENCE_ORDER):
        raise ValueError("preference_order must contain every editable priority exactly once.")
    return order



class ScheduleConstraintError(ValueError):
    def __init__(self, message, details):
        super().__init__(message)
        self.details = details


def parse_bool(value):
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


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
    options = dict(payload.get("options") or {})
    options["preference_order"] = scheduling_preference_order(options)
    options["scoring_mode"] = str(options.get("scoring_mode") or "ranked")
    if options["scoring_mode"] not in {"ranked", "weighted"}:
        raise ValueError("scoring_mode must be ranked or weighted.")
    weights = options.get("preference_weights", dict(DEFAULT_PREFERENCE_WEIGHTS))
    if not isinstance(weights, dict) or set(weights) != set(DEFAULT_PREFERENCE_ORDER) or any(type(value) is not int or not 0 <= value <= 1000 for value in weights.values()) or not any(weights.values()):
        raise ValueError("Preference weights must be integers from 0 to 1000, with at least one positive weight.")
    options["preference_weights"] = weights


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
            "duty_type": str(row.get("duty_type") or "session"),
            "ta_needed": max(0, int(row.get("ta_needed") or 0)),
            "doctor_needed": max(0, int(row.get("doctor_needed") or 0)),
        })

    staff = []
    for index, row in enumerate(staff_raw):
        staff_id = str(row.get("staff_id") or row.get("id") or "").strip()
        if not staff_id:
            raise ValueError(f"Invigilator row {index + 1} is missing staff_id.")
        max_hours = float(row.get("max_hours") or 0)
        if not math.isfinite(max_hours) or max_hours < 0:
            raise ValueError("Maximum hours must be finite and non-negative.")
        staff.append({
            "staff_id": staff_id,
            "role": normalize_role(row.get("role")),
            "load_type": str(row.get("load_type") or "full").strip().lower() or "full",
            "on_call_excluded": parse_bool(row.get("on_call_excluded")),
            "shortage_override": parse_bool(row.get("shortage_override")),
            "exclude_new_assignments": parse_bool(row.get("exclude_new_assignments")),
            "prefer_consecutive_duties": parse_bool(row.get("prefer_consecutive_duties")),
            "prefer_consecutive_days": parse_bool(row.get("prefer_consecutive_days")),
            "allow_engagement_override": parse_bool(row.get("allow_engagement_override")),
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
            "allow_override": parse_bool(row.get("allow_override")),
            "hard_conflict": parse_bool(row.get("hard_conflict")),
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
        if not math.isfinite(hours_value) or hours_value < 0:
            raise ValueError("Staff hour policy hours_value cannot be negative.")
        exclude_from_auto_schedule = parse_bool(row.get("exclude_from_auto_schedule")) or mode == "exclude"
        notes = str(row.get("notes") or "").strip()
        if staff_id:
            staff_hour_policies.append({
                "staff_id": staff_id,
                "role": role,
                "mode": mode,
                "hours_value": max(0.0, hours_value),
                "exclude_from_auto_schedule": exclude_from_auto_schedule,
                "prefer_consecutive_duties": parse_bool(row.get("prefer_consecutive_duties")),
                "prefer_consecutive_days": parse_bool(row.get("prefer_consecutive_days")),
                "allow_engagement_override": parse_bool(row.get("allow_engagement_override")),
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

    policy_by_staff = {row["staff_id"]: row for row in staff_hour_policies}
    protected_staff = set()
    for person in staff:
        policy = policy_by_staff.get(person["staff_id"], {})
        for key in ("prefer_consecutive_duties", "prefer_consecutive_days", "allow_engagement_override"):
            person[key] = person[key] or policy.get(key, False)
        if person["prefer_consecutive_duties"] or person["prefer_consecutive_days"] or person["allow_engagement_override"]:
            person["shortage_override"] = False
            protected_staff.add(person["staff_id"])
    staff_by_id = {person["staff_id"]: person for person in staff}
    for engagement in engagements:
        if engagement.get("hard_conflict"):
            engagement["allow_override"] = False
        elif staff_by_id.get(engagement["staff_id"], {}).get("allow_engagement_override"):
            engagement["allow_override"] = True
        elif engagement["staff_id"] in protected_staff:
            engagement["allow_override"] = False

    fixed_duties = payload.get("fixed_duties") or []
    if not isinstance(fixed_duties, list):
        raise ValueError("fixed_duties must be an array.")
    options["fixed_duties"] = []
    for row in fixed_duties:
        start = parse_time_to_minutes(row.get("start_time") or row.get("startTime"))
        end = parse_time_to_minutes(row.get("end_time") or row.get("endTime"))
        exam_date = str(row.get("exam_date") or row.get("date") or "")
        if not row.get("staff_id") or not exam_date or end <= start:
            raise ValueError("Fixed duties require staff_id, date and a valid time range.")
        duty = {"staff_id": str(row["staff_id"]), "exam_date": exam_date, "start_minutes": start, "end_minutes": end,
                "duty_type": str(row.get("duty_type") or "other")}
        options["fixed_duties"].append(duty)
        engagements.append({**duty, "allow_override": False})

    if len({row["id"] for row in sessions}) != len(sessions):
        raise ValueError("Duplicate session IDs are not allowed.")
    if len({row["staff_id"] for row in staff}) != len(staff):
        raise ValueError("Duplicate staff IDs are not allowed.")
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
        excluded = bool(policy and (policy["mode"] == "exclude" or policy["exclude_from_auto_schedule"])) and not person.get("shortage_override")
        if not excluded:
            available_staff_by_role[person["role"]].append(person)

    raw_average_minutes_by_role = {
        role: (math.floor(total_required_minutes_by_role[role] / len(available_staff_by_role[role]) + 0.5) if available_staff_by_role[role] else 0)
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
            allowed_minutes = 0

        max_minutes = person["max_minutes"]
        original_excluded = excluded
        relaxed_policy_limit = allowed_minutes if mode in {"exact", "add", "reduce"} else None
        if person.get("shortage_override"):
            excluded = False
            if original_excluded:
                allowed_minutes = raw_average_minutes
        has_policy_limit = mode in {"exact", "add", "reduce"}
        if person.get("shortage_override"):
            has_policy_limit = False
        has_hard_limit = excluded or has_policy_limit or max_minutes > 0
        if excluded:
            hard_limit_minutes = 0
        elif has_policy_limit:
            hard_limit_minutes = min(max_minutes, allowed_minutes) if max_minutes > 0 else allowed_minutes
        elif max_minutes > 0:
            hard_limit_minutes = max_minutes
        else:
            hard_limit_minutes = 0

        effective = {
            "original_excluded": original_excluded,
            "relaxed_policy_limit": relaxed_policy_limit if person.get("shortage_override") else None,
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
            "has_hard_limit": has_hard_limit,
            "has_policy_limit": has_policy_limit,
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
    if person.get("exclude_new_assignments"):
        return False, "shortage_excluded"
    if person["role"] not in ("TA", "Doctor"):
        return False, "role"
    policy = indices["policy_summary"]["effective_policy_by_staff"].get(person["staff_id"], {})
    if policy.get("excluded"):
        return False, "policy_excluded"
    if session.get("duty_type") == "on_call" and person.get("on_call_excluded") and not person.get("shortage_override"):
        return False, "on_call_excluded"

    for row in indices["engagement_by_staff_date"].get((person["staff_id"], session["exam_date"]), []):
        if not row.get("allow_override") and ranges_overlap(session["start_minutes"], session["end_minutes"], row["start_minutes"], row["end_minutes"]):
            return False, "engagement"

    for other_session_id in indices["locked_by_staff"].get(person["staff_id"], []):
        if other_session_id == session["id"]:
            return False, "already_assigned"
        other_session = indices["session_by_id"].get(other_session_id)
        if other_session and other_session["exam_date"] == session["exam_date"]:
            if ranges_overlap(session["start_minutes"], session["end_minutes"], other_session["start_minutes"], other_session["end_minutes"]):
                return False, "overlap"

    return True, "ok"


def assignment_override_minutes(session, person, indices):
    policy = indices["policy_summary"]["effective_policy_by_staff"][person["staff_id"]]
    unavailable = any(row.get("allow_override") and ranges_overlap(session["start_minutes"], session["end_minutes"], row["start_minutes"], row["end_minutes"])
                      for row in indices["engagement_by_staff_date"].get((person["staff_id"], session["exam_date"]), []))
    excluded = policy.get("original_excluded") or (session.get("duty_type") == "on_call" and person.get("on_call_excluded") and person.get("shortage_override"))
    return session["duration_minutes"] * (int(unavailable and not person.get("allow_engagement_override")) + int(bool(excluded)))


def engagement_override_minutes(session, person, indices):
    if not person.get("allow_engagement_override"):
        return 0
    intervals = sorted((max(session["start_minutes"], row["start_minutes"]), min(session["end_minutes"], row["end_minutes"]))
                       for row in indices["engagement_by_staff_date"].get((person["staff_id"], session["exam_date"]), [])
                       if row.get("allow_override") and ranges_overlap(session["start_minutes"], session["end_minutes"], row["start_minutes"], row["end_minutes"]))
    total, end = 0, -1
    for start, stop in intervals:
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return total


def annotate_engagement_overrides(assignments, indices):
    work = defaultdict(list)
    loads = defaultdict(int, indices["baseline_minutes_by_staff"])
    for row in assignments:
        duty = indices["session_by_id"][row["session_id"]]
        work[row["staff_id"]].append(duty)
        if not row.get("locked"):
            loads[row["staff_id"]] += duty["duration_minutes"]
    for row in assignments:
        session = indices["session_by_id"][row["session_id"]]
        row["engagement_override_minutes"] = engagement_override_minutes(
            session, indices["staff_by_id"][row["staff_id"]], indices)
        row["engagement_override_reason"] = ""
        if not row["engagement_override_minutes"]:
            continue
        if row.get("locked"):
            row["engagement_override_reason"] = "Preserved fixed or locked assignment; engagement override permitted by staff policy."
            continue
        replacement = False
        for person in indices["staff_by_id"].values():
            if person["staff_id"] == row["staff_id"] or person["role"] != row["role"]:
                continue
            if not is_staff_available_for_session(session, person, indices)[0]:
                continue
            if any(ranges_overlap(session["start_minutes"], session["end_minutes"], item["start_minutes"], item["end_minutes"])
                   for item in indices["engagement_by_staff_date"].get((person["staff_id"], session["exam_date"]), [])):
                continue
            if any(item["exam_date"] == session["exam_date"] and ranges_overlap(session["start_minutes"], session["end_minutes"], item["start_minutes"], item["end_minutes"])
                   for item in work[person["staff_id"]]):
                continue
            policy = indices["policy_summary"]["effective_policy_by_staff"][person["staff_id"]]
            if policy.get("has_hard_limit") and loads[person["staff_id"]] + session["duration_minutes"] > policy["hard_limit_minutes"]:
                continue
            replacement = True
            break
        row["engagement_override_reason"] = ("Workload balancing: an engagement-free replacement exists, but the scheduler selected this allocation."
            if replacement else ("Cover on-call shortage" if session["duty_type"] == "on_call" else "Cover exam shortage")
            + ": no engagement-free replacement is available in this plan within the other staff policies and duty conflicts.")


def validate_fixed_assignments(sessions, staff, engagements, locked, policies, existing_minutes, additional_minutes):
    summary = compute_hour_policy_summary(sessions, staff, policies, additional_minutes)
    indices = build_indices(sessions, staff, engagements, locked, summary, existing_minutes)
    details = []
    seen = set()
    for row in locked:
        key = (row["staff_id"], row["session_id"])
        person = indices["staff_by_id"].get(row["staff_id"])
        session = indices["session_by_id"].get(row["session_id"])
        reason = None
        if key in seen:
            reason = "duplicate_locked_assignment"
        elif not person or not session or person["role"] != row["role"]:
            reason = "invalid_locked_assignment"
        else:
            policy = summary["effective_policy_by_staff"][row["staff_id"]]
            if policy["excluded"]:
                reason = "locked_staff_excluded"
            elif session.get("duty_type") == "on_call" and person.get("on_call_excluded") and not person.get("shortage_override"):
                reason = "locked_on_call_staff_excluded"
            elif any(not item.get("allow_override") and ranges_overlap(session["start_minutes"], session["end_minutes"], item["start_minutes"], item["end_minutes"])
                     for item in indices["engagement_by_staff_date"].get((row["staff_id"], session["exam_date"]), [])):
                reason = "locked_time_conflict"
            elif any(other != row["session_id"] and other in indices["overlaps_by_session"][row["session_id"]]
                     for other in indices["locked_by_staff"][row["staff_id"]]):
                reason = "locked_time_conflict"
        if reason:
            details.append({**row, "reason": reason})
        seen.add(key)
    for person in staff:
        staff_id = person["staff_id"]
        policy = summary["effective_policy_by_staff"][staff_id]
        minutes = indices["baseline_minutes_by_staff"].get(staff_id, 0)
        if policy["has_hard_limit"] and minutes > policy["hard_limit_minutes"]:
            details.append({"staff_id": staff_id, "reason": "fixed_duties_exceed_policy",
                            "assigned_hours": minutes / 60, "allowed_hours": policy["hard_limit_minutes"] / 60})
    if details:
        affected = ", ".join(sorted({row["staff_id"] for row in details})[:5])
        raise ScheduleConstraintError(f"Fixed or locked duties conflict with current staff policies or availability for {affected}. Review these duties before scheduling.", details)


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
            policy = indices["policy_summary"]["effective_policy_by_staff"][person["staff_id"]]
            baseline = indices["baseline_minutes_by_staff"].get(person["staff_id"], 0)
            if policy["has_hard_limit"] and baseline + session["duration_minutes"] > policy["hard_limit_minutes"]:
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
        if effective.get("has_hard_limit") and assigned_minutes > hard_limit:
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
        role_minutes = [load_minutes_by_staff.get(person["staff_id"], 0) for person in staff
                        if person["role"] == role and not policy_summary["effective_policy_by_staff"].get(person["staff_id"], {}).get("excluded")]
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
            "allowed_minutes": int(effective.get("allowed_minutes", 0)),
            "hard_limit_hours": effective.get("hard_limit_hours", 0),
            "has_hard_limit": effective.get("has_hard_limit", False),
            "excluded": bool(effective.get("excluded")),
        })

    placed = len(assignments)
    return {
        "status": status,
        "placed": placed,
        "engagementOverrideMinutes": sum(row.get("engagement_override_minutes", 0) for row in assignments),
        "engagementOverrides": [dict(staffId=row["staff_id"], sessionId=row["session_id"],
                                     date=duty["exam_date"], startTime=duty["start_time"], endTime=duty["end_time"],
                                     dutyType=duty["duty_type"], overlapMinutes=row["engagement_override_minutes"], reason=row["engagement_override_reason"])
                                for row in assignments if row.get("engagement_override_minutes", 0)
                                for duty in sessions if duty["id"] == row["session_id"]],
        "overridePenaltyMinutes": sum(int(row.get("override_minutes", 0)) for row in assignments) + sum(
            max(0, load_minutes_by_staff.get(staff_id, 0) - policy["relaxed_policy_limit"])
            for staff_id, policy in policy_summary["effective_policy_by_staff"].items() if policy.get("relaxed_policy_limit") is not None),
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
        if row.get("excluded"):
            continue
        role = row.get("role") or "TA"
        role_duty_counts[role].append(duty_counts_by_staff.get(row["staff_id"], 0))
        max_assigned_hours_by_role[role] = max(
            max_assigned_hours_by_role.get(role, 0),
            float(assigned_hours_by_staff.get(row["staff_id"], 0) or 0),
        )

    role_hour_spread = result.get("roleHourSpread") or {"TA": 0, "Doctor": 0}
    role_duty_spread = {}
    policy_utilization_spread = {}
    for role in ("TA", "Doctor"):
        counts = role_duty_counts.get(role, [])
        role_duty_spread[role] = (max(counts) - min(counts)) if counts else 0
        ratios = [float(row.get("assigned_hours", 0)) / float(row["allowed_hours"])
                  for row in staff_loads if row.get("role") == role and not row.get("excluded") and row.get("allowed_hours", 0) > 0]
        policy_utilization_spread[role] = round(max(ratios) - min(ratios), 4) if ratios else 0

    total_shortage = sum(int(item.get("remaining", 0) or 0) for item in uncovered_sessions)
    uncovered_session_count = sum(1 for item in uncovered_sessions if int(item.get("remaining", 0) or 0) > 0)
    policy_violation_count = len(result.get("policyViolations") or [])
    over_limit_staff_count = len(result.get("overLimitStaff") or [])

    return {
        "sessionShortage": sum(int(item.get("remaining", 0) or 0) for item in uncovered_sessions if item.get("duty_type") != "on_call"),
        "overridePenaltyMinutes": result.get("overridePenaltyMinutes", 0),
        "engagementOverrideMinutes": result.get("engagementOverrideMinutes", 0),
        "onCallShortage": sum(int(item.get("remaining", 0) or 0) for item in uncovered_sessions if item.get("duty_type") == "on_call"),
        "totalShortage": total_shortage,
        "uncoveredSessionCount": uncovered_session_count,
        "placedDuties": int(result.get("placed", len(assignments)) or 0),
        "policyViolationCount": policy_violation_count,
        "overLimitStaffCount": over_limit_staff_count,
        "dailyPenalty": result.get("dailyPenalty", 0),
        "scoringMode": result.get("scoringMode", "ranked"),
        "weightedPreferenceScore": result.get("weightedPreferenceScore", 0),
        "continuityDayGaps": result.get("continuityDayGaps", 0),
        "continuityIdleMinutes": result.get("continuityIdleMinutes", 0),
        "workloadQualityScore": result.get("workloadQualityScore", 0),
        "roleOnCallHourSpread": result.get("roleOnCallHourSpread", {}),
        "defaultDutyBalanceScore": result.get("defaultDutyBalanceScore", 0),
        "policyUtilizationSpreadByRole": policy_utilization_spread,
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


def compare_result_metrics(cp_metrics, fallback_metrics, preference_order=None):
    checks = [
        ("sessionShortage", "lower", "fewer unfilled exam duties (sessions take priority)"),
        ("onCallShortage", "lower", "fewer unfilled on-call duties"),
        ("totalShortage", "lower", "lower total staffing shortage"),
        ("overridePenaltyMinutes", "lower", "fewer policy and availability overrides"),
        ("uncoveredSessionCount", "lower", "fewer uncovered sessions"),
        ("placedDuties", "higher", "more placed duties"),
        ("policyViolationCount", "lower", "fewer policy violations"),
        ("overLimitStaffCount", "lower", "fewer over-limit staff"),
        ("workloadQualityScore", "lower", "better workload balance without overloading staff for continuity"),
        ("defaultDutyBalanceScore", "lower", "more balanced session and on-call hours among default-policy staff"),
        ("policyUtilizationSpreadByRole", "lower_sum", "fairer utilization of individual policy hours"),
        ("roleHourSpread", "lower_sum", "better hour fairness"),
        ("roleOnCallHourSpread", "lower_sum", "fairer on-call distribution"),
    ]
    if cp_metrics.get("scoringMode", fallback_metrics.get("scoringMode")) == "weighted":
        checks.append(("weightedPreferenceScore", "lower", "lower weighted preference penalty"))
    preference_checks = {
        "engagement_overrides": ("engagementOverrideMinutes", "lower", "fewer engagement overrides"),
        "consecutive_days": ("continuityDayGaps", "lower", "more consecutive working days"),
        "consecutive_duties": ("continuityIdleMinutes", "lower", "more consecutive duties within days"),
        "daily_soft_target": ("dailyPenalty", "lower", "fewer duties above the daily soft target"),
    }
    checks += [preference_checks[key] for key in (preference_order or DEFAULT_PREFERENCE_ORDER)]
    checks += [
        ("dutyCountSpreadByRole", "lower_sum", "lower duty-count imbalance"),
    ]

    for field, direction, label in checks:
        cp_value = cp_metrics.get(field, 0)
        fallback_value = fallback_metrics.get(field, 0)
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
    selected_result["optimizationStages"] = (cp_sat_result or {}).get("optimizationStages", [])
    selected_result["optimizationSeconds"] = (cp_sat_result or {}).get("optimizationSeconds", 0)
    return selected_result


def continuity_gaps(duties):
    by_date = defaultdict(list)
    for exam_date, start, end in duties:
        by_date[exam_date].append((start, end))
    idle_minutes = 0
    for intervals in by_date.values():
        intervals.sort()
        last_end = intervals[0][1]
        for start, end in intervals[1:]:
            idle_minutes += max(0, start - last_end)
            last_end = max(last_end, end)
    dates = sorted(date.fromisoformat(value).toordinal() for value in by_date)
    day_gaps = dates[-1] - dates[0] + 1 - len(dates) if dates else 0
    return day_gaps, idle_minutes


def fixed_work_by_staff(sessions, locked_assignments, options):
    by_session = {row["id"]: row for row in sessions}
    duties = defaultdict(list)
    for row in options.get("fixed_duties", []):
        duties[row["staff_id"]].append((row["exam_date"], row["start_minutes"], row["end_minutes"]))
    for row in locked_assignments:
        session = by_session[row["session_id"]]
        duties[row["staff_id"]].append((session["exam_date"], session["start_minutes"], session["end_minutes"]))
    return duties


def add_continuity_metrics(result, sessions, staff, options):
    duties = fixed_work_by_staff(sessions, [], options)
    by_session = {row["id"]: row for row in sessions}
    for row in result["assignments"]:
        session = by_session[row["session_id"]]
        duties[row["staff_id"]].append((session["exam_date"], session["start_minutes"], session["end_minutes"]))
    rows = []
    for person in staff:
        if not (person["prefer_consecutive_duties"] or person["prefer_consecutive_days"]):
            continue
        days, minutes = continuity_gaps(duties[person["staff_id"]])
        rows.append({"staffId": person["staff_id"], "preferConsecutiveDuties": person["prefer_consecutive_duties"],
                     "preferConsecutiveDays": person["prefer_consecutive_days"], "workingDayGaps": days, "idleMinutes": minutes})
    result["continuity"] = rows
    result["continuityDayGaps"] = sum(row["workingDayGaps"] for row in rows if row["preferConsecutiveDays"])
    result["continuityIdleMinutes"] = sum(row["idleMinutes"] for row in rows if row["preferConsecutiveDuties"])
    return result


def daily_workload_options(options):
    return (max(0, int(options.get("max_sessions_per_day_soft", 2))),
            max(0, int(options.get("daily_penalty_weight", 5))))


def duty_minutes_by_staff(sessions, assignments, options, duty_type):
    by_session = {row["id"]: row for row in sessions}
    minutes = defaultdict(int)
    for row in options.get("fixed_duties", []):
        if row.get("duty_type") == duty_type:
            minutes[row["staff_id"]] += row["end_minutes"] - row["start_minutes"]
    for row in assignments:
        session = by_session[row["session_id"]]
        if session.get("duty_type", "session") == duty_type:
            minutes[row["staff_id"]] += session["duration_minutes"]
    return minutes


def on_call_baseline_by_staff(sessions, locked_assignments, options):
    return duty_minutes_by_staff(sessions, locked_assignments, options, "on_call")


def default_balance_people(staff, policy_summary, role, duty_type):
    return [person for person in staff if person["role"] == role
            and policy_summary["effective_policy_by_staff"][person["staff_id"]]["mode"] == "default"
            and not policy_summary["effective_policy_by_staff"][person["staff_id"]]["excluded"]
            and (duty_type != "on_call" or not person.get("on_call_excluded") or person.get("shortage_override"))]


def add_workload_balance_metrics(result, sessions, staff, options):
    """Use the same workload objective when comparing CP-SAT and fallback."""
    loads = result["staff_loads"]
    spread_weight = int(options.get("spread_weight") or 100)
    imbalance_weight = int(options.get("imbalance_weight") or 1)
    variance_weight = int(options.get("variance_weight") or 0)
    score = 100000 * len(result["uncovered_sessions"]) + int(options.get("duty_weight") or 0) * len(result["assignments"])
    for row in loads:
        if not row["excluded"]:
            score += spread_weight * abs(row["assigned_minutes"] - row["allowed_minutes"])
    on_call = on_call_baseline_by_staff(sessions, result["assignments"], options)
    exam = duty_minutes_by_staff(sessions, result["assignments"], options, "session")
    on_call_spread = {}
    by_staff = {row["staff_id"]: row for row in staff}
    for role in ("TA", "Doctor"):
        people = [row for row in loads if row["role"] == role and not row["excluded"]]
        minutes = [row["assigned_minutes"] for row in people]
        if minutes:
            score += imbalance_weight * (max(minutes) - min(minutes))
            if variance_weight > 0 and len(people) > 1:
                targets = [max(1, row["allowed_minutes"]) for row in people]
                total_target, total_load = sum(targets), sum(minutes)
                score += variance_weight * sum(abs(total_target * load - total_load * target) for load, target in zip(minutes, targets))
        reserve_minutes = [on_call[row["staff_id"]] for row in people
                           if not by_staff[row["staff_id"]].get("on_call_excluded") or by_staff[row["staff_id"]].get("shortage_override") or on_call[row["staff_id"]] > 0]
        on_call_spread[role] = round((max(reserve_minutes) - min(reserve_minutes)) / 60, 2) if reserve_minutes else 0
    result["workloadQualityScore"] = score
    result["onCallHoursByStaff"] = {person["staff_id"]: round(on_call[person["staff_id"]] / 60, 2) for person in staff}
    result["roleOnCallHourSpread"] = on_call_spread
    result["sessionHoursByStaff"] = {person["staff_id"]: round(exam[person["staff_id"]] / 60, 2) for person in staff}
    policy_summary = {"effective_policy_by_staff": {row["staff_id"]: {"mode": row["policy_mode"], "excluded": row["excluded"]} for row in loads}}
    default_score, default_rows = 0, []
    for role in ("TA", "Doctor"):
        for duty_type, minutes in (("session", exam), ("on_call", on_call)):
            people = default_balance_people(staff, policy_summary, role, duty_type)
            values = [minutes[person["staff_id"]] for person in people]
            if not values:
                continue
            total = sum(values)
            default_score += sum(abs(len(values) * value - total) for value in values)
            default_rows.append({"role": role, "dutyType": duty_type, "staffCount": len(values),
                                 "averageHours": round(total / len(values) / 60, 2),
                                 "minimumHours": round(min(values) / 60, 2), "maximumHours": round(max(values) / 60, 2),
                                 "spreadHours": round((max(values) - min(values)) / 60, 2)})
    result["defaultDutyBalanceScore"] = default_score
    result["defaultStaffBalance"] = default_rows
    return result


def add_daily_workload_metrics(result, sessions, options):
    limit, weight = daily_workload_options(options)
    session_by_id = {session["id"]: session for session in sessions}
    counts = defaultdict(int)
    for assignment in result["assignments"]:
        counts[(assignment["staff_id"], session_by_id[assignment["session_id"]]["exam_date"])] += 1
    result["dailyExcessDuties"] = sum(max(0, count - limit) for count in counts.values())
    result["dailyPenalty"] = weight * result["dailyExcessDuties"]
    return result


def greedy_fallback_schedule(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff=None, additional_required_minutes_by_role=None, options=None):
    options = options or {}
    daily_limit, daily_weight = daily_workload_options(options or {})
    work_by_staff = fixed_work_by_staff(sessions, locked_assignments, options)
    policy_summary = compute_hour_policy_summary(sessions, staff, staff_hour_policies, additional_required_minutes_by_role)
    indices = build_indices(sessions, staff, engagements, locked_assignments, policy_summary, existing_duty_minutes_by_staff)
    _, candidates_by_session_role, _, excluded_staff_skipped = build_candidates(sessions, staff, indices)
    assignments = []
    load_minutes_by_staff = defaultdict(int, indices["baseline_minutes_by_staff"])
    duty_count_by_staff = defaultdict(int)
    daily_count_by_staff = defaultdict(int)
    on_call_minutes_by_staff = on_call_baseline_by_staff(sessions, locked_assignments, options)
    exam_minutes_by_staff = duty_minutes_by_staff(sessions, locked_assignments, options, "session")

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
        daily_count_by_staff[(locked["staff_id"], session["exam_date"])] += 1

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
            item["session"].get("duty_type") == "on_call",
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
            if any(exam_date == session["exam_date"] and ranges_overlap(
                    session["start_minutes"], session["end_minutes"], start, end)
                   for exam_date, start, end in work_by_staff[person["staff_id"]]):
                continue
            effective = policy_summary["effective_policy_by_staff"].get(person["staff_id"], {})
            projected = load_minutes_by_staff[person["staff_id"]] + session["duration_minutes"]
            max_minutes = int(person.get("max_minutes", 0) or 0)
            if effective.get("has_hard_limit") and projected > effective["hard_limit_minutes"]:
                continue
            allowed = int(effective.get("allowed_minutes", 0) or 0)
            load_ratio = projected / allowed if allowed > 0 else projected / max(1, session["duration_minutes"])
            limit = effective.get("relaxed_policy_limit")
            extra = max(0, projected - limit) - max(0, load_minutes_by_staff[person["staff_id"]] - limit) if limit is not None else 0
            override = assignment_override_minutes(session, person, indices) + extra
            daily_count = daily_count_by_staff[(person["staff_id"], session["exam_date"])]
            daily_cost = daily_weight * (max(0, daily_count + 1 - daily_limit) - max(0, daily_count - daily_limit))
            day_delta, idle_delta = 0, 0
            if person["prefer_consecutive_duties"] or person["prefer_consecutive_days"]:
                previous = work_by_staff[person["staff_id"]]
                before_days, before_idle = continuity_gaps(previous)
                after_days, after_idle = continuity_gaps(previous + [(session["exam_date"], session["start_minutes"], session["end_minutes"])])
                day_delta = after_days - before_days if person["prefer_consecutive_days"] else 0
                idle_delta = after_idle - before_idle if person["prefer_consecutive_duties"] else 0
            kind_minutes = on_call_minutes_by_staff[person["staff_id"]] if session.get("duty_type") == "on_call" else exam_minutes_by_staff[person["staff_id"]]
            kind_ratio = kind_minutes / max(1, allowed or session["duration_minutes"])
            preference_values = {"engagement_overrides": engagement_override_minutes(session, person, indices),
                                 "consecutive_days": day_delta, "consecutive_duties": idle_delta, "daily_soft_target": daily_cost}
            candidates.append((override, load_ratio, kind_ratio, preference_key(preference_values, options), projected, duty_count_by_staff[person["staff_id"]], person["staff_id"]))

        candidates.sort()
        chosen = candidates[:remaining]
        for _, _, _, _, projected, _, staff_id in chosen:
            assignments.append({
                "override_minutes": assignment_override_minutes(session, indices["staff_by_id"][staff_id], indices),
                "staff_id": staff_id,
                "session_id": session["id"],
                "role": role,
                "locked": False,
            })
            load_minutes_by_staff[staff_id] = projected
            duty_count_by_staff[staff_id] += 1
            daily_count_by_staff[(staff_id, session["exam_date"])] += 1
            work_by_staff[staff_id].append((session["exam_date"], session["start_minutes"], session["end_minutes"]))
            if session.get("duty_type") == "on_call":
                on_call_minutes_by_staff[staff_id] += session["duration_minutes"]
            else:
                exam_minutes_by_staff[staff_id] += session["duration_minutes"]

        still_missing = remaining - len(chosen)
        if still_missing > 0:
            uncovered_sessions.append({
                "session_id": session["id"],
                "duty_type": session.get("duty_type", "session"),
                "role": role,
                "remaining": still_missing,
                "shortage": still_missing,
            })

    status = "FALLBACK_FEASIBLE" if not uncovered_sessions else "FALLBACK_PARTIAL"
    explanation = (
        "Feasible fallback used. Custom policy hours, maximum hours, exclusions and time conflicts are strict. Engagements may be overridden only when permitted by the staff policy. Default role averages guide workload balance."
    )
    annotate_engagement_overrides(assignments, indices)
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


def build_continuity_objective(model, x, sessions, staff, locked_assignments, options):
    by_session = {row["id"]: row for row in sessions}
    fixed = fixed_work_by_staff(sessions, locked_assignments, options)
    choices_by_staff = defaultdict(list)
    for (staff_id, session_id, _), variable in x.items():
        choices_by_staff[staff_id].append((by_session[session_id], variable))
    day_terms, idle_terms = [], []
    for person in staff:
        if not (person["prefer_consecutive_days"] or person["prefer_consecutive_duties"]):
            continue
        staff_id = person["staff_id"]
        dates = defaultdict(lambda: {"fixed": [], "choices": []})
        for exam_date, start, end in fixed[staff_id]:
            dates[exam_date]["fixed"].append((start, end))
        for session, variable in choices_by_staff[staff_id]:
            dates[session["exam_date"]]["choices"].append((session["start_minutes"], session["end_minutes"], variable))
        if not dates:
            continue
        active_days = []
        for exam_date, work in sorted(dates.items()):
            fixed_intervals, choices = work["fixed"], work["choices"]
            active = model.NewBoolVar(f"working_{staff_id}_{exam_date}")
            model.AddMaxEquality(active, [1] if fixed_intervals else [variable for _, _, variable in choices])
            active_days.append((date.fromisoformat(exam_date).toordinal(), active))
            if not person["prefer_consecutive_duties"]:
                continue
            ceiling = max([end for _, end in fixed_intervals] + [end for _, end, _ in choices])
            first = model.NewIntVar(0, ceiling, f"first_duty_{staff_id}_{exam_date}")
            last = model.NewIntVar(0, ceiling, f"last_duty_{staff_id}_{exam_date}")
            model.AddMinEquality(first, [min((start for start, _ in fixed_intervals), default=ceiling)]
                                 + [start * variable + ceiling * (1 - variable) for start, _, variable in choices])
            model.AddMaxEquality(last, [max((end for _, end in fixed_intervals), default=0)]
                                 + [end * variable for _, end, variable in choices])
            # Fixed duties can overlap one another in imported data. Count their
            # union once; new duties cannot overlap them or each other.
            fixed_minutes, previous_end = 0, 0
            for start, end in sorted(fixed_intervals):
                fixed_minutes += max(0, end - max(start, previous_end))
                previous_end = max(previous_end, end)
            worked = fixed_minutes + sum((end - start) * variable for start, end, variable in choices)
            idle = model.NewIntVar(0, ceiling, f"idle_{staff_id}_{exam_date}")
            model.Add(idle == last - first + ceiling * (1 - active) - worked)
            idle_terms.append(idle)
        if person["prefer_consecutive_days"]:
            origin = min(value for value, _ in active_days)
            span = max(value for value, _ in active_days) - origin
            any_work = model.NewBoolVar(f"any_work_{staff_id}")
            model.AddMaxEquality(any_work, [active for _, active in active_days])
            first = model.NewIntVar(0, span + 1, f"first_day_{staff_id}")
            last = model.NewIntVar(-1, span, f"last_day_{staff_id}")
            model.AddMinEquality(first, [(value - origin) * active + (span + 1) * (1 - active) for value, active in active_days])
            model.AddMaxEquality(last, [(value - origin) * active - (1 - active) for value, active in active_days])
            gaps = model.NewIntVar(0, span, f"day_gaps_{staff_id}")
            model.Add(gaps == last - first + 1 - sum(active for _, active in active_days) + (span + 1) * (1 - any_work))
            day_terms.append(gaps)
    # Keep separate expressions so the saved priority order or points determine tradeoffs.
    return {"consecutive_days": sum(day_terms), "consecutive_duties": sum(idle_terms)}


def build_default_duty_balance_objective(model, x, sessions, staff, locked_assignments, options, policy_summary):
    by_session = {row["id"]: row for row in sessions}
    objective, has_groups = [], False
    for duty_type in ("session", "on_call"):
        baseline = duty_minutes_by_staff(sessions, locked_assignments, options, duty_type)
        terms, upper = defaultdict(list), defaultdict(int, baseline)
        for (staff_id, session_id, _), variable in x.items():
            session = by_session[session_id]
            if session.get("duty_type", "session") == duty_type:
                terms[staff_id].append(session["duration_minutes"] * variable)
                upper[staff_id] += session["duration_minutes"]
        for role in ("TA", "Doctor"):
            people = default_balance_people(staff, policy_summary, role, duty_type)
            if len(people) < 2:
                continue
            has_groups = True
            loads = []
            for person in people:
                staff_id = person["staff_id"]
                load = model.NewIntVar(baseline[staff_id], upper[staff_id], f"default_{duty_type}_load_{staff_id}")
                model.Add(load == baseline[staff_id] + sum(terms[staff_id]))
                loads.append(load)
            total_load = sum(loads)
            total_upper = sum(upper[person["staff_id"]] for person in people)
            for person, load in zip(people, loads):
                deviation = model.NewIntVar(0, max(len(people) * upper[person["staff_id"]], total_upper), f"default_{duty_type}_deviation_{person['staff_id']}")
                model.AddAbsEquality(deviation, len(people) * load - total_load)
                objective.append(deviation)
    return sum(objective), has_groups


def build_on_call_balance_objective(model, x, sessions, staff, locked_assignments, options, policy_summary):
    by_session = {row["id"]: row for row in sessions}
    baseline = on_call_baseline_by_staff(sessions, locked_assignments, options)
    terms_by_staff = defaultdict(list)
    upper_by_staff = defaultdict(int, baseline)
    for (staff_id, session_id, _), variable in x.items():
        session = by_session[session_id]
        if session.get("duty_type") == "on_call":
            terms_by_staff[staff_id].append(session["duration_minutes"] * variable)
            upper_by_staff[staff_id] += session["duration_minutes"]
    objective = []
    for role in ("TA", "Doctor"):
        people = [person for person in staff if person["role"] == role
                  and not policy_summary["effective_policy_by_staff"][person["staff_id"]]["excluded"]
                  and (not person.get("on_call_excluded") or person.get("shortage_override") or baseline[person["staff_id"]] > 0)]
        if len(people) < 2:
            continue
        loads = []
        upper = max(upper_by_staff[person["staff_id"]] for person in people)
        for person in people:
            staff_id = person["staff_id"]
            load = model.NewIntVar(baseline[staff_id], upper_by_staff[staff_id], f"on_call_load_{staff_id}")
            model.Add(load == baseline[staff_id] + sum(terms_by_staff[staff_id]))
            loads.append(load)
        maximum = model.NewIntVar(0, upper, f"on_call_max_{role}")
        minimum = model.NewIntVar(0, upper, f"on_call_min_{role}")
        model.AddMaxEquality(maximum, loads)
        model.AddMinEquality(minimum, loads)
        objective.append(maximum - minimum)
    return sum(objective)


def build_model(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options):
    policy_summary = compute_hour_policy_summary(sessions, staff, staff_hour_policies, additional_required_minutes_by_role)
    indices = build_indices(sessions, staff, engagements, locked_assignments, policy_summary, existing_duty_minutes_by_staff)
    candidates, candidates_by_session_role, candidates_by_staff, excluded_staff_skipped = build_candidates(sessions, staff, indices)
    model = cp_model.CpModel()

    x = {}
    override_terms = []
    for row in candidates:
        key = (row["staff_id"], row["session_id"], row["role"])
        x[key] = model.NewBoolVar(f"x_{row['staff_id']}_{row['session_id']}_{row['role']}")
        penalty = assignment_override_minutes(indices["session_by_id"][row["session_id"]], indices["staff_by_id"][row["staff_id"]], indices)
        if penalty:
            override_terms.append(penalty * x[key])

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
        grouped = defaultdict(list)
        for row in person_candidates:
            grouped[row["session_id"]].append(x[(row["staff_id"], row["session_id"], row["role"])])
        for vars_same_session in grouped.values():
            if len(vars_same_session) > 1:
                model.AddAtMostOne(vars_same_session)

        date_groups = defaultdict(list)
        for row in person_candidates:
            session = indices["session_by_id"][row["session_id"]]
            date_groups[session["exam_date"]].append(row)
        for rows in date_groups.values():
            seen_cliques = set()
            for checkpoint in sorted({indices["session_by_id"][row["session_id"]]["start_minutes"] for row in rows}):
                active = [x[(row["staff_id"], row["session_id"], row["role"])] for row in rows
                          if indices["session_by_id"][row["session_id"]]["start_minutes"] <= checkpoint
                          < indices["session_by_id"][row["session_id"]]["end_minutes"]]
                key = tuple(var.Index() for var in active)
                if len(active) > 1 and key not in seen_cliques:
                    model.AddAtMostOne(active)
                    seen_cliques.add(key)

        effective = policy_summary["effective_policy_by_staff"].get(person["staff_id"], {})
        baseline_minutes = indices["baseline_minutes_by_staff"].get(person["staff_id"], 0)
        upper_load = baseline_minutes + sum(row["duration_minutes"] for row in person_candidates)
        if effective.get("has_hard_limit"):
            upper_load = min(upper_load, effective["hard_limit_minutes"])
        total_load = model.NewIntVar(baseline_minutes, upper_load, f"load_{person['staff_id']}")
        model.Add(
            total_load
            == baseline_minutes
            + sum(
                indices["session_by_id"][row["session_id"]]["duration_minutes"] * x[(row["staff_id"], row["session_id"], row["role"])]
                for row in person_candidates
            )
        )
        person["load_var"] = total_load
        person["load_upper_bound"] = upper_load
        limit = effective.get("relaxed_policy_limit")
        if limit is not None:
            overage = model.NewIntVar(0, max(0, upper_load - limit), f"policy_overage_{person['staff_id']}")
            model.AddMaxEquality(overage, [0, total_load - limit])
            override_terms.append(overage)

    objective_terms = []
    daily_terms = []
    shortage_session_weight = 100000
    spread_weight = int(options.get("spread_weight") or 100)
    imbalance_weight = int(options.get("imbalance_weight") or 1)
    variance_weight = int(options.get("variance_weight") or 0)
    duty_weight = int(options.get("duty_weight") or 0)
    daily_limit, daily_weight = daily_workload_options(options)

    for var in shortage_session_vars.values():
        objective_terms.append(shortage_session_weight * var)

    for person in staff:
        total_load = person.get("load_var")
        if total_load is None:
            continue
        effective = policy_summary["effective_policy_by_staff"].get(person["staff_id"], {})
        target = int(effective.get("allowed_minutes", 0) or 0)
        if not effective.get("excluded"):
            deviation = model.NewIntVar(0, max(target, abs(person["load_upper_bound"] - target)), f"dev_{person['staff_id']}")
            model.AddAbsEquality(deviation, total_load - target)
            objective_terms.append(spread_weight * deviation)
        duty_count = model.NewIntVar(0, len(candidates_by_staff.get(person["staff_id"], [])) + len(indices["locked_by_staff"].get(person["staff_id"], [])), f"duty_{person['staff_id']}")
        model.Add(
            duty_count
            == len(indices["locked_by_staff"].get(person["staff_id"], []))
            + sum(x[(row["staff_id"], row["session_id"], row["role"])] for row in candidates_by_staff.get(person["staff_id"], []))
        )
        objective_terms.append(duty_weight * duty_count)
        if daily_weight:
            candidates_by_date = defaultdict(list)
            locked_by_date = defaultdict(int)
            for row in candidates_by_staff.get(person["staff_id"], []):
                date = indices["session_by_id"][row["session_id"]]["exam_date"]
                candidates_by_date[date].append(x[(row["staff_id"], row["session_id"], row["role"])])
            for session_id in indices["locked_by_staff"].get(person["staff_id"], []):
                locked_by_date[indices["session_by_id"][session_id]["exam_date"]] += 1
            for date in candidates_by_date.keys() | locked_by_date.keys():
                variables = candidates_by_date[date]
                fixed_count = locked_by_date[date]
                excess = model.NewIntVar(0, max(0, fixed_count + len(variables) - daily_limit), f"daily_excess_{person['staff_id']}_{date}")
                model.AddMaxEquality(excess, [0, fixed_count + sum(variables) - daily_limit])
                daily_terms.append(excess)

    for role in ("TA", "Doctor"):
        role_people = [person for person in staff if person["role"] == role
                       and not policy_summary["effective_policy_by_staff"][person["staff_id"]]["excluded"]]
        if not role_people:
            continue
        max_bound = max(person["load_upper_bound"] for person in role_people)
        role_max = model.NewIntVar(0, max_bound, f"{role}_max_load")
        role_min = model.NewIntVar(0, max_bound, f"{role}_min_load")
        for person in role_people:
            model.Add(person["load_var"] <= role_max)
            model.Add(person["load_var"] >= role_min)
        objective_terms.append(imbalance_weight * (role_max - role_min))
        if variance_weight > 0 and len(role_people) > 1:
            # Compare utilization of each person's own target, so reduced-hour
            # staff are not pushed toward the same raw hours as full-load staff.
            role_total = sum(person["load_var"] for person in role_people)
            total_target = sum(max(1, policy_summary["effective_policy_by_staff"][person["staff_id"]]["allowed_minutes"]) for person in role_people)
            role_upper = sum(person["load_upper_bound"] for person in role_people)
            for person in role_people:
                target = max(1, policy_summary["effective_policy_by_staff"][person["staff_id"]]["allowed_minutes"])
                diff = model.NewIntVar(0, max(total_target * person["load_upper_bound"], role_upper * target), f"{role}_utildev_{person['staff_id']}")
                model.AddAbsEquality(diff, total_target * person["load_var"] - role_total * target)
                objective_terms.append(variance_weight * diff)

    model.Minimize(sum(objective_terms))
    # One exam gap is more costly than every possible on-call gap combined.
    on_call_slots = sum(session["ta_needed"] + session["doctor_needed"] for session in sessions if session.get("duty_type") == "on_call")
    coverage_objective = sum(var * (on_call_slots + 1 if indices["session_by_id"][key[0]].get("duty_type") != "on_call" else 1) for key, var in shortage_vars.items())
    continuity_objective = build_continuity_objective(model, x, sessions, staff, locked_assignments, options)
    continuity_objective["daily_soft_target"] = sum(daily_terms)
    on_call_balance_objective = build_on_call_balance_objective(model, x, sessions, staff, locked_assignments, options, policy_summary)
    default_balance_objective, has_default_groups = build_default_duty_balance_objective(model, x, sessions, staff, locked_assignments, options, policy_summary)
    return model, x, indices, policy_summary, excluded_staff_skipped, coverage_objective, sum(objective_terms), sum(override_terms), continuity_objective, on_call_balance_objective, default_balance_objective, has_default_groups


def solve_with_cp_sat(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options, initial_result=None):
    started = time.monotonic()
    stage_diagnostics = []
    model, x, indices, policy_summary, excluded_staff_skipped, coverage_objective, quality_objective, override_objective, continuity_objective, on_call_balance_objective, default_balance_objective, has_default_groups = build_model(
        sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options
    )
    solver = cp_model.CpSolver()
    budget = min(600.0, max(0.05, float(options.get("time_limit_seconds") or 60)))
    variables = [model.get_int_var_from_proto_index(index) for index in range(len(model.Proto().variables))]

    def hint_from(previous):
        model.clear_hints()
        add_hint = model.add_hint
        values = previous.response_proto.solution
        # Constant-only constraints can append helper variables to a clone or
        # later stage. Hint only the shared original variable indices.
        for var, value in zip(variables, values):
            add_hint(var, value)

    solver.parameters.max_time_in_seconds = budget * 0.35
    solver.parameters.num_search_workers = 4
    model.Minimize(coverage_objective)
    if initial_result is not None:
        chosen = {(row["staff_id"], row["session_id"], row["role"]) for row in initial_result["assignments"]}
        for key, var in x.items():
            model.AddHint(var, int(key in chosen))
        on_call_slots = sum(session["ta_needed"] + session["doctor_needed"] for session in sessions if session.get("duty_type") == "on_call")
        initial_coverage = sum(int(row["remaining"]) * (1 if row.get("duty_type") == "on_call" else on_call_slots + 1) for row in initial_result["uncovered_sessions"])
        model.Add(coverage_objective <= initial_coverage)
        # Validate the complete starting layout and hint the auxiliary variables
        # too. A zero-shortage start already proves the coverage optimum.
        fixed_model = model.Clone()
        for key, var in x.items():
            fixed_model.Add(var == int(key in chosen))
        fixed_solver = cp_model.CpSolver()
        fixed_solver.parameters.num_search_workers = 1
        fixed_solver.parameters.max_time_in_seconds = min(3.0, budget * 0.2)
        fixed_status = fixed_solver.Solve(fixed_model)
        if fixed_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            hint_from(fixed_solver)
            # This incumbent is already validated. Avoid spending the quality
            # budget presolving interchangeable staff/session choices again.
            solver.parameters.cp_model_presolve = False

    solver.parameters.max_time_in_seconds = max(0.001, budget * 0.35 - (time.monotonic() - started))
    status = solver.Solve(model)
    status_name = solver.StatusName(status)
    stage_diagnostics.append({"stage": "coverage", "status": status_name, "elapsedSeconds": round(time.monotonic() - started, 3)})
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None, status_name

    coverage_optimal = status == cp_model.OPTIMAL
    best_shortage = int(solver.Value(coverage_objective))
    model.Add(coverage_objective == best_shortage)
    if any(person.get("shortage_override") for person in staff):
        # With coverage fixed, prefer the fewest exceptions before balancing hours.
        model.Add(override_objective <= int(solver.Value(override_objective)))
        model.Minimize(override_objective)
        override_solver = cp_model.CpSolver()
        override_solver.parameters.max_time_in_seconds = max(0.001, (budget - (time.monotonic() - started)) * 0.5)
        override_solver.parameters.num_search_workers = 4
        override_status = override_solver.Solve(model)
        if override_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            solver = override_solver
        model.Add(override_objective <= int(solver.Value(override_objective)))
    # Preferences rearrange a balanced allocation. They must not attract extra
    # on-call work merely because it closes a gap in one person's schedule.
    objectives = [("workload_balance", quality_objective, 0.35)]
    if has_default_groups:
        objectives.append(("default_duty_balance", default_balance_objective, 0.25))
    if any(session.get("duty_type") == "on_call" and (session["ta_needed"] or session["doctor_needed"]) for session in sessions):
        objectives.append(("on_call_balance", on_call_balance_objective, 0.15))
    if any(person.get("allow_engagement_override") for person in staff):
        by_session = {row["id"]: row for row in sessions}
        by_staff = {row["staff_id"]: row for row in staff}
        engagement_indices = build_indices(sessions, staff, engagements, locked_assignments, {}, {})
        continuity_objective["engagement_overrides"] = sum(engagement_override_minutes(by_session[session_id], by_staff[staff_id], engagement_indices) * var
                              for (staff_id, session_id, role), var in x.items())
    if options.get("scoring_mode") == "weighted":
        weights = options["preference_weights"]
        units = {"engagement_overrides": 1, "consecutive_days": 60, "consecutive_duties": 1, "daily_soft_target": 60}
        objectives.append(("weighted_preferences", sum(weights[key] * units[key] * expression for key, expression in continuity_objective.items()), 0.40))
    for key in scheduling_preference_order(options):
        if key == "consecutive_days" and not any(person["prefer_consecutive_days"] for person in staff):
            continue
        if key == "consecutive_duties" and not any(person["prefer_consecutive_duties"] for person in staff):
            continue
        if key in continuity_objective:
            objectives.append((key, continuity_objective[key], 0.15))
    refinement_started = time.monotonic()
    refinement_budget = max(0, budget - (refinement_started - started))
    total_weight = sum(weight for name, objective, weight in objectives)
    cumulative_weight = 0
    all_optimal = coverage_optimal
    for name, objective, weight in objectives:
        cumulative_weight += weight
        deadline = min(started + budget, refinement_started + refinement_budget * cumulative_weight / total_weight)
        if deadline - time.monotonic() <= 0.01:
            stage_diagnostics.append({"stage": name, "status": "SKIPPED_TIME_LIMIT", "elapsedSeconds": round(time.monotonic() - started, 3)})
            all_optimal = False
            continue
        model.Add(objective <= int(solver.Value(objective)))
        hint_from(solver)
        model.Minimize(objective)
        next_solver = cp_model.CpSolver()
        remaining = deadline - time.monotonic()
        if remaining <= 0.001:
            stage_diagnostics.append({"stage": name, "status": "SKIPPED_TIME_LIMIT", "elapsedSeconds": round(time.monotonic() - started, 3)})
            all_optimal = False
            continue
        next_solver.parameters.max_time_in_seconds = remaining
        next_solver.parameters.num_search_workers = 4
        next_solver.parameters.cp_model_presolve = False
        next_status = next_solver.Solve(model)
        stage_diagnostics.append({"stage": name, "status": next_solver.StatusName(next_status), "elapsedSeconds": round(time.monotonic() - started, 3)})
        if next_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            solver = next_solver
        all_optimal = all_optimal and next_status == cp_model.OPTIMAL
        model.Add(objective <= int(solver.Value(objective)))
    status_name = "OPTIMAL" if all_optimal else "FEASIBLE"

    result = result_from_solver(solver, status_name, sessions, staff, locked_assignments, x,
                                indices, policy_summary, excluded_staff_skipped)
    result["optimizationStages"] = stage_diagnostics
    result["optimizationSeconds"] = round(time.monotonic() - started, 3)
    return result, status_name


def result_from_solver(solver, status_name, sessions, staff, locked_assignments, x,
                       indices, policy_summary, excluded_staff_skipped):

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
                "override_minutes": assignment_override_minutes(indices["session_by_id"][session_id], indices["staff_by_id"][staff_id], indices),
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
                    "duty_type": session.get("duty_type", "session"),
                    "role": role,
                    "remaining": remaining,
                    "shortage": remaining,
                })

    result_status = status_name
    explanation = "Exam sessions take coverage priority over on-call duties. Total workload is balanced first, then session and on-call hours are balanced separately among default-policy staff within each role. Custom hour policies, maximum hours, exclusions and duty conflicts remain strict. Engagements may be overridden only when permitted by the staff policy. Continuity preferences follow workload balance."
    if uncovered_sessions:
        result_status = f"{status_name}_PARTIAL"
    annotate_engagement_overrides(assignments, indices)
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
    )


def refine_preference_exchanges(result, sessions, staff, engagements, locked, policies, existing, additional, options):
    """Repair gaps through equal-duration, same-type exchanges, preserving hours."""
    preferred = [person for person in staff if person["prefer_consecutive_days"] or person["prefer_consecutive_duties"]]
    if not preferred:
        return
    order = scheduling_preference_order(options)
    started = time.monotonic()
    deadline = started + 5.0
    summary = compute_hour_policy_summary(sessions, staff, policies, additional)
    indices = build_indices(sessions, staff, engagements, locked, summary, existing)
    by_session, people = indices["session_by_id"], indices["staff_by_id"]
    rows = result["assignments"]
    work, groups = defaultdict(list), defaultdict(list)
    fixed = fixed_work_by_staff(sessions, [], options)
    daily_limit, daily_weight = daily_workload_options(options)
    penalties = {}
    for index, row in enumerate(rows):
        duty = by_session[row["session_id"]]
        work[row["staff_id"]].append(index)
        if not row.get("locked"):
            groups[(row["role"], duty["duty_type"], duty["duration_minutes"])].append(index)

    def penalty(staff_id, duty):
        key = (staff_id, duty["id"])
        if key not in penalties:
            penalties[key] = (assignment_override_minutes(duty, people[staff_id], indices), engagement_override_minutes(duty, people[staff_id], indices))
        return penalties[key]

    def stats(staff_id, replaced=None, replacement=None):
        intervals = list(fixed[staff_id])
        dates, engagement_minutes = defaultdict(int), 0
        for index in work[staff_id]:
            duty = replacement if index == replaced else by_session[rows[index]["session_id"]]
            intervals.append((duty["exam_date"], duty["start_minutes"], duty["end_minutes"]))
            dates[duty["exam_date"]] += 1
            engagement_minutes += penalty(staff_id, duty)[1]
        days, idle = continuity_gaps(intervals)
        return {"consecutive_days": days if people[staff_id]["prefer_consecutive_days"] else 0,
                "consecutive_duties": idle if people[staff_id]["prefer_consecutive_duties"] else 0,
                "engagement_overrides": engagement_minutes,
                "daily_soft_target": daily_weight * sum(max(0, count - daily_limit) for count in dates.values())}

    current = {person["staff_id"]: stats(person["staff_id"]) for person in staff}
    before = {key: sum(value[key] for value in current.values()) for key in order}

    def legal(staff_id, duty, removed):
        if not is_staff_available_for_session(duty, people[staff_id], indices)[0]:
            return False
        return not any(index != removed and other["exam_date"] == duty["exam_date"]
                       and ranges_overlap(duty["start_minutes"], duty["end_minutes"], other["start_minutes"], other["end_minutes"])
                       for index in work[staff_id] for other in [by_session[rows[index]["session_id"]]])

    exchanges = 0
    for _ in range(40):
        best = None
        for person in preferred:
            left_id = person["staff_id"]
            for left in work[left_id]:
                if rows[left].get("locked"):
                    continue
                duty_left = by_session[rows[left]["session_id"]]
                for right in groups[(person["role"], duty_left["duty_type"], duty_left["duration_minutes"])]:
                    if time.monotonic() >= deadline:
                        break
                    right_id = rows[right]["staff_id"]
                    if right_id == left_id:
                        continue
                    duty_right = by_session[rows[right]["session_id"]]
                    if not legal(left_id, duty_right, left) or not legal(right_id, duty_left, right):
                        continue
                    old_legacy = penalty(left_id, duty_left)[0] + penalty(right_id, duty_right)[0]
                    if penalty(left_id, duty_right)[0] + penalty(right_id, duty_left)[0] > old_legacy:
                        continue
                    after_left, after_right = stats(left_id, left, duty_right), stats(right_id, right, duty_left)
                    changes = {key: after_left[key] + after_right[key] - current[left_id][key] - current[right_id][key] for key in order}
                    delta = preference_key(changes, options)
                    if delta < (0,) * len(delta) and (best is None or delta < best[0]):
                        best = (delta, left, right, after_left, after_right)
                if time.monotonic() >= deadline:
                    break
            if time.monotonic() >= deadline:
                break
        if best is None:
            break
        _, left, right, after_left, after_right = best
        rows[left]["session_id"], rows[right]["session_id"] = rows[right]["session_id"], rows[left]["session_id"]
        current[rows[left]["staff_id"]], current[rows[right]["staff_id"]] = after_left, after_right
        exchanges += 1
        if time.monotonic() >= deadline:
            break
    if exchanges:
        for row in rows:
            row["override_minutes"] = penalty(row["staff_id"], by_session[row["session_id"]])[0]
        annotate_engagement_overrides(rows, indices)
        result.update(build_result_payload(result["status"], sessions, staff, rows, result["uncovered_sessions"],
                      {row["staff_id"]: row["assigned_minutes"] for row in result["staff_loads"]}, summary,
                      explanation=result["explanation"], excluded_staff_skipped=result["excludedStaffSkipped"]))
    result["preferenceRepair"] = {"exchanges": exchanges, "before": before,
        "after": {key: sum(value[key] for value in current.values()) for key in order},
        "seconds": round(time.monotonic() - started, 3), "timeLimited": time.monotonic() >= deadline}


def solve(payload):
    sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options = validate_and_normalize(payload)
    validate_fixed_assignments(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role)
    fallback_result = greedy_fallback_schedule(sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options)
    refine_preference_exchanges(fallback_result, sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options)
    fallback_result["preferenceOrder"] = scheduling_preference_order(options)
    add_daily_workload_metrics(fallback_result, sessions, options)
    add_continuity_metrics(fallback_result, sessions, staff, options)
    add_workload_balance_metrics(fallback_result, sessions, staff, options)
    attach_preference_metadata(fallback_result, options)
    if cp_model is None:
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
        sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options, fallback_result
    )
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

    refine_preference_exchanges(cp_sat_result, sessions, staff, engagements, locked_assignments, staff_hour_policies, existing_duty_minutes_by_staff, additional_required_minutes_by_role, options)
    cp_sat_result["preferenceOrder"] = scheduling_preference_order(options)
    add_daily_workload_metrics(cp_sat_result, sessions, options)
    add_continuity_metrics(cp_sat_result, sessions, staff, options)
    add_workload_balance_metrics(cp_sat_result, sessions, staff, options)
    attach_preference_metadata(cp_sat_result, options)
    winner, reason = compare_result_metrics(
        build_result_metrics(cp_sat_result),
        build_result_metrics(fallback_result), scheduling_preference_order(options),
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
            "details": getattr(error, "details", []),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
