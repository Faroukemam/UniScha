import json
import math
import sys
from collections import defaultdict
from datetime import datetime

from ortools.sat.python import cp_model


DATETIME_FMT = "%Y-%m-%d %H:%M"


def emit(payload):
    print(json.dumps(payload))
    sys.exit(0)


def clean(value):
    return str(value or "").strip()


def upper(value):
    return clean(value).upper()


def parse_dt(date_value, time_value):
    return datetime.strptime(f"{clean(date_value)} {clean(time_value)}", DATETIME_FMT)


def normalize_type(value):
    value = upper(value)
    return value if value in {"TH", "DH", "LAB"} else ""


def normalize_bool(value):
    return clean(value).lower() in {"1", "true", "yes", "y"}


def split_values(value):
    return [upper(item) for item in str(value or "").replace("\n", ";").replace(",", ";").split(";") if upper(item)]


def room_type_penalty(required_type, room_type, allow_th_fallback):
    required_type = normalize_type(required_type)
    room_type = normalize_type(room_type)
    if not required_type or not room_type:
        return None
    if required_type == room_type:
        return 0
    if required_type == "TH" and allow_th_fallback and room_type in {"DH", "LAB"}:
        return 1
    return None


def overflow_extra(capacity):
    base = int(capacity or 0)
    if base <= 0:
        return 0
    return int(math.floor(base * 0.10 + 1e-9))


def intervals_overlap(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


def load_payload(payload):
    settings = payload.get("settings") or {}
    courses = payload.get("courses") or []
    availability = payload.get("availability") or payload.get("sessions") or []
    capacities = payload.get("capacities") or []
    locked_assignments = payload.get("lockedAssignments") or []
    if not isinstance(courses, list) or not isinstance(availability, list) or not isinstance(capacities, list):
        emit({"status": "ERROR", "error": "courses, availability, and capacities must be arrays."})
    return {
        "group_linked_courses": settings.get("groupLinkedCourses", True),
        "allow_auto_available": settings.get("useAutoAvailableBackup", True),
        "allow_th_fallback": settings.get("allowThFallback", True),
        "capacity_strategy": clean(settings.get("capacityStrategy") or "best").lower(),
        "time_limit_seconds": float(settings.get("timeLimitSeconds") or payload.get("time_limit_seconds") or 60),
        "courses": courses,
        "availability": availability,
        "capacities": capacities,
        "locked_assignments": locked_assignments if isinstance(locked_assignments, list) else [],
    }


def validate_inputs(config):
    validation_errors = []
    capacities = []
    capacity_by_room = {}

    for row in config["capacities"]:
        row_number = int(row.get("rowNumber") or row.get("row_number") or row.get("row") or 0)
        room = clean(row.get("room") or row.get("Room"))
        minor_cap = row.get("minorCap") if row.get("minorCap") is not None else row.get("MinorCap")
        major_cap = row.get("majorCap") if row.get("majorCap") is not None else row.get("MajorCap")
        room_type = normalize_type(row.get("roomType") or row.get("RoomType"))
        auto_available = normalize_bool(row.get("autoAvailable") if row.get("autoAvailable") is not None else row.get("AutoAvailable"))
        if not room:
            validation_errors.append({"source": "RoomCapacity", "row": row_number, "field": "Room", "errorMessage": "Room is required."})
            continue
        if room.lower() in capacity_by_room:
            validation_errors.append({"source": "RoomCapacity", "row": row_number, "field": "Room", "errorMessage": "Duplicate room capacity row."})
            continue
        try:
            minor_cap = int(float(minor_cap or 0))
            major_cap = int(float(major_cap or 0))
        except Exception:
            validation_errors.append({"source": "RoomCapacity", "row": row_number, "field": "MinorCap/MajorCap", "errorMessage": "Capacities must be numeric."})
            continue
        if minor_cap < 0 or major_cap < 0:
            validation_errors.append({"source": "RoomCapacity", "row": row_number, "field": "MinorCap/MajorCap", "errorMessage": "Capacities must be zero or positive."})
            continue
        if not room_type:
            validation_errors.append({"source": "RoomCapacity", "row": row_number, "field": "RoomType", "errorMessage": "RoomType must be TH, DH, or LAB."})
            continue
        item = {
            "room": room,
            "minorCap": minor_cap,
            "majorCap": major_cap,
            "roomType": room_type,
            "autoAvailable": auto_available,
        }
        capacities.append(item)
        capacity_by_room[room.lower()] = item

    availability_rows = []
    for row in config["availability"]:
        row_number = int(row.get("rowNumber") or row.get("row_number") or row.get("row") or 0)
        room = clean(row.get("room") or row.get("Room"))
        date = clean(row.get("date") or row.get("Date"))
        start = clean(row.get("start") or row.get("Start"))
        end = clean(row.get("end") or row.get("End"))
        if not room:
            validation_errors.append({"source": "RoomSessions", "row": row_number, "field": "Room", "errorMessage": "Room is required."})
            continue
        if not date or not start or not end:
            validation_errors.append({"source": "RoomSessions", "row": row_number, "field": "Date/Start/End", "errorMessage": "Date, Start, and End are required."})
            continue
        try:
            start_dt = parse_dt(date, start)
            end_dt = parse_dt(date, end)
        except Exception:
            validation_errors.append({"source": "RoomSessions", "row": row_number, "field": "Date/Start/End", "errorMessage": "Invalid date or time format."})
            continue
        if start_dt >= end_dt:
            validation_errors.append({"source": "RoomSessions", "row": row_number, "field": "Start/End", "errorMessage": "Start must be before End."})
            continue
        if room.lower() not in capacity_by_room:
            validation_errors.append({"source": "RoomSessions", "row": row_number, "field": "Room", "errorMessage": "Room exists in availability but not in capacity data."})
            continue
        availability_rows.append({
            "room": room,
            "date": date,
            "start": start,
            "end": end,
            "startDt": start_dt,
            "endDt": end_dt,
        })

    courses = []
    for row in config["courses"]:
        row_number = int(row.get("rowNumber") or row.get("row_number") or row.get("row") or 0)
        course_code = upper(row.get("courseCode") or row.get("CourseCode"))
        students_value = row.get("students") if row.get("students") is not None else row.get("Students")
        date = clean(row.get("date") or row.get("Date"))
        start = clean(row.get("start") or row.get("Start"))
        end = clean(row.get("end") or row.get("End"))
        room_type = normalize_type(row.get("roomPlacementType") or row.get("RoomPlacementType"))
        linked_group = upper(row.get("linkedGroup") or row.get("LinkedGroup"))
        linked_courses = split_values(row.get("linkedCourses") or row.get("LinkedCourses"))
        if not course_code:
            validation_errors.append({"source": "CourseSchedule", "row": row_number, "field": "CourseCode", "errorMessage": "CourseCode is required."})
            continue
        try:
            students = int(float(students_value or 0))
        except Exception:
            validation_errors.append({"source": "CourseSchedule", "row": row_number, "field": "Students", "errorMessage": "Students must be numeric."})
            continue
        if students <= 0:
            validation_errors.append({"source": "CourseSchedule", "row": row_number, "field": "Students", "errorMessage": "Students must be greater than zero."})
            continue
        if not date or not start or not end:
            validation_errors.append({"source": "CourseSchedule", "row": row_number, "field": "Date/Start/End", "errorMessage": "Date, Start, and End are required."})
            continue
        try:
            start_dt = parse_dt(date, start)
            end_dt = parse_dt(date, end)
        except Exception:
            validation_errors.append({"source": "CourseSchedule", "row": row_number, "field": "Date/Start/End", "errorMessage": "Invalid date or time format."})
            continue
        if start_dt >= end_dt:
            validation_errors.append({"source": "CourseSchedule", "row": row_number, "field": "Start/End", "errorMessage": "Start must be before End."})
            continue
        if not room_type:
            validation_errors.append({"source": "CourseSchedule", "row": row_number, "field": "RoomPlacementType", "errorMessage": "RoomPlacementType must be TH, DH, or LAB."})
            continue
        courses.append({
            "instanceId": f"course_{row_number}",
            "rowNumber": row_number,
            "courseCode": course_code,
            "students": students,
            "date": date,
            "start": start,
            "end": end,
            "startDt": start_dt,
            "endDt": end_dt,
            "roomPlacementType": room_type,
            "linkedGroup": linked_group,
            "linkedCourses": linked_courses,
        })

    return courses, availability_rows, capacities, validation_errors


def build_groups(courses, group_linked_courses, validation_errors):
    if not group_linked_courses:
        groups = []
        for index, course in enumerate(sorted(courses, key=lambda item: (-item["students"], item["date"], item["start"], item["courseCode"])), start=1):
            groups.append({
                "placementGroupId": f"PG-{index}",
                "courseCodes": [course["courseCode"]],
                "linkedGroup": course["linkedGroup"],
                "totalStudents": course["students"],
                "date": course["date"],
                "start": course["start"],
                "end": course["end"],
                "startDt": course["startDt"],
                "endDt": course["endDt"],
                "roomPlacementType": course["roomPlacementType"],
            })
        return groups

    parent = {course["instanceId"]: course["instanceId"] for course in courses}
    course_period_index = defaultdict(list)

    for course in courses:
        course_period_index[(
            course["courseCode"],
            course["date"],
            course["start"],
            course["end"],
            course["roomPlacementType"],
        )].append(course["instanceId"])

    def find(item):
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    def union(a, b):
        root_a = find(a)
        root_b = find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    linked_groups = defaultdict(list)
    for course in courses:
        if course["linkedGroup"]:
            linked_groups[(
                course["linkedGroup"],
                course["date"],
                course["start"],
                course["end"],
                course["roomPlacementType"],
            )].append(course["instanceId"])
        for linked in course["linkedCourses"]:
            matching_ids = course_period_index.get((
                linked,
                course["date"],
                course["start"],
                course["end"],
                course["roomPlacementType"],
            ), [])
            for matching_id in matching_ids:
                union(course["instanceId"], matching_id)

    for course_codes in linked_groups.values():
        if not course_codes:
            continue
        first = course_codes[0]
        for other in course_codes[1:]:
            union(first, other)

    grouped = defaultdict(list)
    for course in courses:
        grouped[find(course["instanceId"])].append(course)

    output = []
    for index, items in enumerate(grouped.values(), start=1):
        items = sorted(items, key=lambda item: item["courseCode"])
        anchor = items[0]
        mismatch = [
            item for item in items
            if item["date"] != anchor["date"]
            or item["start"] != anchor["start"]
            or item["end"] != anchor["end"]
            or item["roomPlacementType"] != anchor["roomPlacementType"]
        ]
        if mismatch:
            linked_name = anchor["linkedGroup"] or anchor["courseCode"]
            for item in items:
                validation_errors.append({
                    "source": "CourseSchedule",
                    "row": item["rowNumber"],
                    "field": "LinkedGroup",
                    "errorMessage": f"LinkedGroup {linked_name} has conflicting Date/Start/End/RoomPlacementType values.",
                })
            continue
        output.append({
            "placementGroupId": f"PG-{index}",
            "courseCodes": [item["courseCode"] for item in items],
            "linkedGroup": anchor["linkedGroup"],
            "totalStudents": sum(item["students"] for item in items),
            "date": anchor["date"],
            "start": anchor["start"],
            "end": anchor["end"],
            "startDt": anchor["startDt"],
            "endDt": anchor["endDt"],
            "roomPlacementType": anchor["roomPlacementType"],
        })

    output.sort(key=lambda item: (-item["totalStudents"], item["date"], item["start"], item["placementGroupId"]))
    return output


def build_rooms(capacities):
    return sorted(capacities, key=lambda item: (item["autoAvailable"], -item["majorCap"], -item["minorCap"], item["room"].lower()))


def availability_matches(room, group, availability_rows):
    for row in availability_rows:
        if row["room"].lower() != room["room"].lower():
            continue
        if row["date"] != group["date"]:
            continue
        if row["start"] != group["start"]:
            continue
        if group["roomPlacementType"] == "DH":
            return True
        if row["end"] == group["end"]:
            return True
    return False


def room_available_for_group(room, group, availability_rows, allow_auto_available):
    if room["autoAvailable"]:
        if not allow_auto_available:
            return False, False
        return False, True
    normal_available = availability_matches(room, group, availability_rows)
    backup_available = (not normal_available) and allow_auto_available and room["autoAvailable"]
    return normal_available, backup_available


def build_checkpoints(groups):
    checkpoints_by_date = defaultdict(list)
    for group in groups:
        checkpoints_by_date[group["date"]].append(group["startDt"])
    return {
        date: sorted(set(points))
        for date, points in checkpoints_by_date.items()
    }


def solve(payload):
    config = load_payload(payload)
    courses, availability_rows, capacities, validation_errors = validate_inputs(config)
    groups = build_groups(courses, bool(config["group_linked_courses"]), validation_errors)
    rooms = build_rooms(capacities)
    checkpoints_by_date = build_checkpoints(groups)
    locked_assignments = config.get("locked_assignments") or []

    if not groups:
        emit({
            "status": "OPTIMAL",
            "results": [],
            "roomRows": [],
            "unassigned": [],
            "summary": {
                "totalCourses": 0,
                "totalPlacementGroups": 0,
                "assignedGroups": 0,
                "assignedWithBackup": 0,
                "unassignedGroups": 0,
                "capacityShortage": 0,
                "totalWasteCapacity": 0,
                "backupRoomsUsed": 0,
            },
            "validationErrors": validation_errors,
            "groups": [],
        })

    mode_allow_major = config["capacity_strategy"] in {"best", "major", ""}
    mode_allow_minor = config["capacity_strategy"] in {"best", "minor", ""}

    model = cp_model.CpModel()
    group_mode_major = {}
    group_mode_minor = {}
    group_assigned = {}
    group_shortage = {}
    assign = {}
    assign_major = {}
    assign_minor = {}
    use_room = {}
    eligible_pairs = []
    pair_meta = {}
    pair_students_limit = {}
    fallback_terms = []
    backup_terms = []
    room_count_terms = []
    room_priority_terms = []
    large_room_use_terms = []
    physical_room_use_terms = []
    capacity_shortage_group_terms = []
    tiny_assignment_terms = []
    search_assignment_vars = []

    availability_errors = set()
    locked_by_key = defaultdict(lambda: {"Major": 0, "Minor": 0})
    for item in locked_assignments:
        gid = clean(item.get("placementGroupId"))
        room_name = clean(item.get("room")).lower()
        mode = clean(item.get("capacityMode"))
        students = int(float(item.get("students") or 0))
        if not gid or not room_name or mode not in {"Major", "Minor"} or students <= 0:
            continue
        locked_by_key[(gid, room_name)][mode] += students

    max_room_total_capacity = max(
        (
            int(room["majorCap"]) + overflow_extra(room["majorCap"])
            + int(room["minorCap"]) + overflow_extra(room["minorCap"])
            for room in rooms
        ),
        default=0,
    )

    for group_index, group in enumerate(groups):
        gid = group["placementGroupId"]
        max_students = int(group["totalStudents"])
        if mode_allow_major and mode_allow_minor:
            group_mode_major[gid] = model.NewConstant(1)
            group_mode_minor[gid] = model.NewConstant(1)
        elif mode_allow_major:
            group_mode_major[gid] = model.NewConstant(1)
            group_mode_minor[gid] = model.NewConstant(0)
        else:
            group_mode_major[gid] = model.NewConstant(0)
            group_mode_minor[gid] = model.NewConstant(1)

        group_assigned[gid] = model.NewBoolVar(f"group_{gid}_assigned")
        group_shortage[gid] = model.NewIntVar(0, max_students, f"group_{gid}_shortage")
        group_has_shortage = model.NewBoolVar(f"group_{gid}_has_shortage")
        model.Add(group_shortage[gid] <= max_students * group_has_shortage)
        model.Add(group_shortage[gid] >= group_has_shortage)
        capacity_shortage_group_terms.append(group_has_shortage)

        group_pair_vars = []
        group_pair_meta = []

        for room_index, room in enumerate(rooms):
            normal_available, backup_available = room_available_for_group(room, group, availability_rows, bool(config["allow_auto_available"]))
            if not normal_available and not backup_available:
                continue
            type_penalty = room_type_penalty(group["roomPlacementType"], room["roomType"], bool(config["allow_th_fallback"]))
            if type_penalty is None:
                continue

            key = (gid, room["room"].lower())
            x = model.NewIntVar(0, max_students, f"x_{gid}_{room_index}")
            x_major = model.NewIntVar(0, max_students, f"xmajor_{gid}_{room_index}")
            x_minor = model.NewIntVar(0, max_students, f"xminor_{gid}_{room_index}")
            y = model.NewBoolVar(f"use_{gid}_{room_index}")
            large_alloc = model.NewBoolVar(f"large_alloc_{gid}_{room_index}")
            tiny_alloc = model.NewBoolVar(f"tiny_alloc_{gid}_{room_index}")
            pair_major = model.NewBoolVar(f"pair_major_{gid}_{room_index}")
            pair_minor = model.NewBoolVar(f"pair_minor_{gid}_{room_index}")
            assign[key] = x
            assign_major[key] = x_major
            assign_minor[key] = x_minor
            use_room[key] = y
            search_assignment_vars.append((
                max_students,
                room["majorCap"] + overflow_extra(room["majorCap"]) + room["minorCap"] + overflow_extra(room["minorCap"]),
                x,
            ))

            major_limit = int(room["majorCap"]) + overflow_extra(int(room["majorCap"]))
            minor_limit = int(room["minorCap"]) + overflow_extra(int(room["minorCap"]))
            room_slice_limit = max(0, max(major_limit, minor_limit))
            model.Add(x == x_major + x_minor)
            model.Add(x <= max_students * y)
            model.Add(x >= y)
            model.Add(x <= room_slice_limit)
            model.Add(x >= 6 * large_alloc)
            model.Add(x <= 5 + max_students * large_alloc)
            model.Add(tiny_alloc + large_alloc == y)
            model.Add(pair_major + pair_minor >= y)
            model.Add(pair_major + pair_minor <= y)
            model.Add(x_major <= max_students * y)
            model.Add(x_minor <= max_students * y)
            model.Add(x_major <= max_students * group_mode_major[gid])
            model.Add(x_minor <= max_students * group_mode_minor[gid])
            model.Add(x_major <= major_limit * pair_major)
            model.Add(x_minor <= minor_limit * pair_minor)

            if room["majorCap"] <= 0:
                model.Add(x_major == 0)
                model.Add(pair_major == 0)
            if room["minorCap"] <= 0:
                model.Add(x_minor == 0)
                model.Add(pair_minor == 0)

            locked = locked_by_key.get(key)
            if locked:
                locked_major = int(locked.get("Major", 0))
                locked_minor = int(locked.get("Minor", 0))
                if locked_major > 0:
                    model.Add(x_major >= locked_major)
                if locked_minor > 0:
                    model.Add(x_minor >= locked_minor)
                if locked_major <= 0:
                    model.Add(x_major == 0)
                if locked_minor <= 0:
                    model.Add(x_minor == 0)

            group_pair_vars.append(x)
            group_pair_meta.append(key)
            eligible_pairs.append(key)
            pair_students_limit[key] = max_students
            pair_meta[key] = {
                "group": group,
                "room": room,
                "normal_available": normal_available,
                "backup_available": backup_available,
                "type_penalty": type_penalty,
            }
            if type_penalty > 0:
                fallback_terms.append(y)
            if backup_available and not normal_available:
                backup_terms.append(y)
            room_count_terms.append(y)
            tiny_assignment_terms.append(tiny_alloc)
            room_total_capacity = (
                int(room["majorCap"]) + overflow_extra(room["majorCap"])
                + int(room["minorCap"]) + overflow_extra(room["minorCap"])
            )
            room_size_penalty = max(0, max_room_total_capacity - room_total_capacity)
            # Strongly prefer opening larger rooms first because they can absorb
            # more groups and reduce fragmentation across the shared blocks.
            large_room_use_terms.append(y * room_size_penalty)
            room_priority_terms.append(y * room_index)

        if not group_pair_vars:
            validation_errors.append({
                "source": "Solver",
                "row": 0,
                "field": "Eligibility",
                "errorMessage": f"{gid} has no eligible rooms for its time, type, and availability rules.",
            })
            model.Add(group_shortage[gid] == max_students)
            model.Add(group_assigned[gid] == 0)
            continue

        model.Add(sum(group_pair_vars) + group_shortage[gid] == max_students)
        total_assigned = model.NewIntVar(0, max_students, f"assigned_total_{gid}")
        model.Add(total_assigned == sum(group_pair_vars))
        model.Add(total_assigned <= max_students * group_assigned[gid])
        model.Add(total_assigned >= group_assigned[gid])

    for room in rooms:
        room_key = room["room"].lower()
        for date, checkpoints in checkpoints_by_date.items():
            active_pairs = [
                key for key in eligible_pairs
                if key[1] == room_key and pair_meta[key]["group"]["date"] == date
            ]
            if not active_pairs:
                continue

            for pair_index, first_key in enumerate(active_pairs):
                first_group = pair_meta[first_key]["group"]
                for second_key in active_pairs[pair_index + 1:]:
                    second_group = pair_meta[second_key]["group"]
                    if not intervals_overlap(
                        first_group["startDt"],
                        first_group["endDt"],
                        second_group["startDt"],
                        second_group["endDt"],
                    ):
                        continue
                    same_exact_window = (
                        first_group["start"] == second_group["start"]
                        and first_group["end"] == second_group["end"]
                    )
                    if same_exact_window:
                        continue
                    model.Add(use_room[first_key] + use_room[second_key] <= 1)

            for checkpoint_index, checkpoint in enumerate(checkpoints):
                active_now = [
                    key for key in active_pairs
                    if pair_meta[key]["group"]["startDt"] <= checkpoint < pair_meta[key]["group"]["endDt"]
                ]
                if not active_now:
                    continue

                major_total = sum(assign_major[key] for key in active_now)
                minor_total = sum(assign_minor[key] for key in active_now)
                major_non_dh_total = sum(
                    assign_major[key] for key in active_now
                    if pair_meta[key]["group"]["roomPlacementType"] != "DH"
                )
                minor_non_dh_total = sum(
                    assign_minor[key] for key in active_now
                    if pair_meta[key]["group"]["roomPlacementType"] != "DH"
                )

                major_capacity = int(room["majorCap"])
                minor_capacity = int(room["minorCap"])
                major_extra = overflow_extra(major_capacity)
                minor_extra = overflow_extra(minor_capacity)

                if major_extra > 0:
                    major_overflow = model.NewIntVar(0, major_extra, f"major_overflow_{room_key}_{date}_{checkpoint_index}")
                    model.Add(major_overflow <= major_non_dh_total)
                    model.Add(major_total <= major_capacity + major_overflow)
                else:
                    model.Add(major_total <= major_capacity)

                if minor_extra > 0:
                    minor_overflow = model.NewIntVar(0, minor_extra, f"minor_overflow_{room_key}_{date}_{checkpoint_index}")
                    model.Add(minor_overflow <= minor_non_dh_total)
                    model.Add(minor_total <= minor_capacity + minor_overflow)
                else:
                    model.Add(minor_total <= minor_capacity)

    block_pairs = defaultdict(list)
    for key in eligible_pairs:
        group = pair_meta[key]["group"]
        room = pair_meta[key]["room"]
        block_pairs[(room["room"].lower(), group["date"], group["start"], group["end"], "Major")].append(key)
        block_pairs[(room["room"].lower(), group["date"], group["start"], group["end"], "Minor")].append(key)

    waste_terms = []
    block_use_terms = []
    physical_totals = {}
    block_info_map = {}
    block_waste_vars = {}
    block_total_vars = {}
    for room in rooms:
        for group in groups:
            if group["date"] is None:
                continue
            block_key = (room["room"].lower(), group["date"], group["start"], group["end"])
            physical_totals.setdefault(block_key, None)

    for (room_key, date, start, end, mode), keys in block_pairs.items():
        room = pair_meta[keys[0]]["room"]
        capacity = int(room["majorCap"] if mode == "Major" else room["minorCap"])
        extra_capacity = overflow_extra(capacity)
        max_capacity = capacity + extra_capacity
        if mode == "Major":
            total_expr = sum(assign_major[key] for key in keys)
            non_dh_expr = sum(
                assign_major[key] for key in keys
                if pair_meta[key]["group"]["roomPlacementType"] != "DH"
            )
        else:
            total_expr = sum(assign_minor[key] for key in keys)
            non_dh_expr = sum(
                assign_minor[key] for key in keys
                if pair_meta[key]["group"]["roomPlacementType"] != "DH"
            )
        total_var = model.NewIntVar(0, max_capacity, f"block_total_{room_key}_{date}_{start}_{end}_{mode}")
        model.Add(total_var == total_expr)
        used = model.NewBoolVar(f"block_used_{room_key}_{date}_{start}_{end}_{mode}")
        model.Add(total_var <= max_capacity * used)
        model.Add(total_var >= used)
        if extra_capacity > 0:
            overflow_used = model.NewIntVar(0, extra_capacity, f"block_overflow_{room_key}_{date}_{start}_{end}_{mode}")
            model.Add(overflow_used <= non_dh_expr)
            model.Add(total_var <= capacity + overflow_used)
        diff = model.NewIntVar(-max_capacity, capacity, f"waste_diff_{room_key}_{date}_{start}_{end}_{mode}")
        model.Add(diff == (capacity * used) - total_var)
        waste = model.NewIntVar(0, capacity, f"waste_{room_key}_{date}_{start}_{end}_{mode}")
        model.AddMaxEquality(waste, [diff, 0])
        block_total_vars[(room_key, date, start, end, mode)] = total_var
        block_waste_vars[(room_key, date, start, end, mode)] = waste
        block_info_map[(room_key, date, start, end, mode)] = {
            "capacity": max_capacity,
            "roomType": room["roomType"],
            "autoAvailable": room["autoAvailable"],
            "room": room["room"],
        }
        block_use_terms.append(used)
        waste_terms.append(waste)

    for room_key, date, start, end in list(physical_totals.keys()):
        major_var = block_total_vars.get((room_key, date, start, end, "Major"))
        minor_var = block_total_vars.get((room_key, date, start, end, "Minor"))
        max_capacity = 0
        for room in rooms:
            if room["room"].lower() == room_key:
                max_capacity = (
                    room["majorCap"] + overflow_extra(room["majorCap"])
                    + room["minorCap"] + overflow_extra(room["minorCap"])
                )
                break
        total_var = model.NewIntVar(0, max_capacity, f"physical_total_{room_key}_{date}_{start}_{end}")
        major_expr = major_var if major_var is not None else 0
        minor_expr = minor_var if minor_var is not None else 0
        model.Add(total_var == major_expr + minor_expr)
        physical_totals[(room_key, date, start, end)] = total_var

    physical_room_start_keys = defaultdict(list)
    for room_key, date, start, end in physical_totals.keys():
        physical_room_start_keys[(room_key, date, start)].append((room_key, date, start, end))

    for room_start_key, end_keys in physical_room_start_keys.items():
        room_key, date, start = room_start_key
        room = next((item for item in rooms if item["room"].lower() == room_key), None)
        max_capacity = 0
        if room:
            max_capacity = (
                int(room["majorCap"]) + overflow_extra(room["majorCap"])
                + int(room["minorCap"]) + overflow_extra(room["minorCap"])
            )
        total_expr = sum(physical_totals[key] for key in end_keys)
        room_used = model.NewBoolVar(f"physical_room_used_{room_key}_{date}_{start}")
        model.Add(total_expr <= max_capacity * len(end_keys) * room_used)
        model.Add(total_expr >= room_used)
        physical_room_use_terms.append(room_used)

    unassigned_group_terms = []
    shortage_terms = []
    for group in groups:
        gid = group["placementGroupId"]
        unassigned = model.NewBoolVar(f"unassigned_{gid}")
        total_students = int(group["totalStudents"])
        assigned_students = model.NewIntVar(0, total_students, f"assigned_students_{gid}")
        group_pairs = [assign[key] for key in eligible_pairs if key[0] == gid]
        if group_pairs:
            model.Add(assigned_students == sum(group_pairs))
        else:
            model.Add(assigned_students == 0)
        model.Add(assigned_students <= total_students * (1 - unassigned))
        model.Add(assigned_students >= 1 - unassigned)
        shortage_terms.append(group_shortage[gid])
        unassigned_group_terms.append(unassigned)

    objective = (
        (sum(shortage_terms) * 1000000000)
        + (sum(unassigned_group_terms) * 10000000)
        + (sum(capacity_shortage_group_terms) * 1000000)
        + (sum(backup_terms) * 10000)
        + (sum(tiny_assignment_terms) * 3000)
        + (sum(physical_room_use_terms) * 5000)
        + (sum(block_use_terms) * 500)
        + (sum(large_room_use_terms) * 500)
        + (sum(room_count_terms) * 25)
        + (sum(waste_terms) * 50)
        + (sum(fallback_terms) * 5)
        + sum(room_priority_terms)
    )
    model.Minimize(objective)

    if search_assignment_vars:
        ordered_assignments = [var for _students, _capacity, var in sorted(search_assignment_vars, key=lambda item: (-item[0], -item[1]))]
        model.AddDecisionStrategy(ordered_assignments, cp_model.CHOOSE_FIRST, cp_model.SELECT_MAX_VALUE)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(config["time_limit_seconds"])
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        emit({
            "status": "INFEASIBLE",
            "results": [],
            "roomRows": [],
            "unassigned": [],
            "summary": {
                "totalCourses": len(courses),
                "totalPlacementGroups": len(groups),
                "assignedGroups": 0,
                "assignedWithBackup": 0,
                "unassignedGroups": len(groups),
                "capacityShortage": 0,
                "totalWasteCapacity": 0,
                "backupRoomsUsed": 0,
            },
            "validationErrors": validation_errors,
            "groups": [],
        })

    room_block_info = {}
    for block_key, info in block_info_map.items():
        room_key, date, start, end, mode = block_key
        total = int(solver.Value(block_total_vars[block_key]))
        if total <= 0:
            continue
        remaining = int(solver.Value(block_waste_vars[block_key]))
        physical_total = int(solver.Value(physical_totals[(room_key, date, start, end)]))
        room_block_info[block_key] = {
            "mode": mode,
            "capacity": info["capacity"],
            "totalAssigned": total,
            "remaining": remaining,
            "physicalTotal": physical_total,
            "roomType": info["roomType"],
            "autoAvailable": info["autoAvailable"],
            "room": info["room"],
        }

    results = []
    room_rows = []
    unassigned_rows = []
    total_waste = 0
    counted_blocks = set()

    for group in groups:
        gid = group["placementGroupId"]
        assigned_rows = []
        uses_backup = False
        uses_fallback = False
        used_modes = set()
        assigned_room_names = []
        seen_rooms = set()
        assigned_students = 0
        assigned_capacity = 0
        waste_share = 0.0
        for key in [pair for pair in eligible_pairs if pair[0] == gid]:
            meta = pair_meta[key]
            group_info = meta["group"]
            room = meta["room"]
            block_amounts = {
                "Major": int(solver.Value(assign_major[key])),
                "Minor": int(solver.Value(assign_minor[key])),
            }
            for block_mode, amount in block_amounts.items():
                if amount <= 0:
                    continue
                block_key = (room["room"].lower(), group_info["date"], group_info["start"], group_info["end"], block_mode)
                block_info = room_block_info.get(block_key)
                if not block_info:
                    continue
                assigned_rows.append((room, amount, block_info, meta))
                assigned_students += amount
                assigned_capacity += block_info["capacity"]
                used_modes.add(block_mode)
                if room["room"] not in seen_rooms:
                    assigned_room_names.append(room["room"])
                    seen_rooms.add(room["room"])
                uses_backup = uses_backup or (meta["backup_available"] and not meta["normal_available"])
                uses_fallback = uses_fallback or meta["type_penalty"] > 0
                if block_info["totalAssigned"] > 0:
                    waste_share += block_info["remaining"] * (amount / block_info["totalAssigned"])
                if block_key not in counted_blocks:
                    total_waste += block_info["remaining"]
                    counted_blocks.add(block_key)

        shortage = int(solver.Value(group_shortage[gid]))
        status_text = "Assigned"
        notes = []
        if uses_backup:
            status_text = "AssignedWithBackup"
            notes.append("AutoAvailable backup room used.")
        if shortage > 0 and assigned_students > 0:
            status_text = "CapacityShortage"
            notes.append("Capacity shortage remains after assignment.")
        if assigned_students <= 0:
            status_text = "Unassigned"
            notes.append("No eligible room capacity remained for this group.")
        if uses_fallback:
            notes.append("TH fallback room type was used.")

        mode = ""
        if assigned_students > 0:
            if len(used_modes) == 1:
                mode = next(iter(used_modes))
            elif len(used_modes) > 1:
                mode = "Combined"

        results.append({
            "placementGroupId": gid,
            "courseCodes": "; ".join(group["courseCodes"]),
            "linkedGroup": group["linkedGroup"],
            "totalStudents": group["totalStudents"],
            "date": group["date"],
            "start": group["start"],
            "end": group["end"],
            "roomPlacementType": group["roomPlacementType"],
            "capacityMode": mode,
            "assignedRooms": ", ".join(assigned_room_names),
            "assignedCapacity": assigned_capacity,
            "wasteCapacity": int(round(waste_share)),
            "shortage": shortage,
            "autoAvailableUsed": uses_backup,
            "status": status_text,
            "notes": " ".join(notes).strip(),
        })

        for room, amount, block_info, _meta in assigned_rows:
            room_rows.append({
                "placementGroupId": gid,
                "courseCodes": "; ".join(group["courseCodes"]),
                "linkedGroup": group["linkedGroup"],
                "room": room["room"],
                "date": group["date"],
                "start": group["start"],
                "end": group["end"],
                "capacityMode": block_info["mode"],
                "roomCapacity": block_info["capacity"],
                "studentsAssignedToThisRoom": amount,
                "studentsAssignedToThisBlock": amount,
                "roomTotalAssignedStudentsAtThisTime": block_info["totalAssigned"],
                "blockTotalAssignedStudentsAtThisTime": block_info["totalAssigned"],
                "roomRemainingCapacityAtThisTime": block_info["remaining"],
                "blockRemainingCapacityAtThisTime": block_info["remaining"],
                "physicalRoomTotalAssignedStudentsAtThisTime": block_info["physicalTotal"],
                "roomType": block_info["roomType"],
                "autoAvailable": block_info["autoAvailable"],
                "status": status_text,
            })

        if shortage > 0:
            unassigned_rows.append({
                "placementGroupId": gid,
                "courseCodes": "; ".join(group["courseCodes"]),
                "linkedGroup": group["linkedGroup"],
                "totalStudents": group["totalStudents"],
                "date": group["date"],
                "start": group["start"],
                "end": group["end"],
                "roomPlacementType": group["roomPlacementType"],
                "reason": "Insufficient compatible room capacity remained for the full group.",
            })

    summary = {
        "totalCourses": len(courses),
        "totalPlacementGroups": len(groups),
        "assignedGroups": sum(1 for row in results if row["status"] == "Assigned"),
        "assignedWithBackup": sum(1 for row in results if row["status"] == "AssignedWithBackup"),
        "unassignedGroups": sum(1 for row in results if row["status"] == "Unassigned"),
        "capacityShortage": sum(1 for row in results if row["status"] == "CapacityShortage"),
        "totalWasteCapacity": total_waste,
        "backupRoomsUsed": sum(1 for row in results if row["autoAvailableUsed"]),
    }

    emit({
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "results": sorted(results, key=lambda item: (item["date"], item["start"], item["placementGroupId"])),
        "roomRows": sorted(room_rows, key=lambda item: (item["date"], item["start"], item["room"], item["placementGroupId"])),
        "unassigned": sorted(unassigned_rows, key=lambda item: (item["date"], item["start"], item["placementGroupId"])),
        "summary": summary,
        "validationErrors": validation_errors,
        "groups": [
            {
                "placementGroupId": group["placementGroupId"],
                "courseCodes": group["courseCodes"],
                "linkedGroup": group["linkedGroup"],
                "totalStudents": group["totalStudents"],
                "date": group["date"],
                "start": group["start"],
                "end": group["end"],
                "roomPlacementType": group["roomPlacementType"],
            }
            for group in groups
        ],
    })


if __name__ == "__main__":
    try:
        solve(json.loads(sys.stdin.read() or "{}"))
    except Exception as exc:
        emit({"status": "ERROR", "error": str(exc), "results": [], "roomRows": [], "unassigned": [], "validationErrors": []})
