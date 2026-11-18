import json
import subprocess
import sys
from pathlib import Path


def emit(payload):
    print(json.dumps(payload))
    sys.exit(0)


def clean(value):
    return str(value or "").strip()


def normalize_payload(payload):
    options = payload.get("options") or {}
    return {
        "courses": payload.get("courses") or [],
        "availability": payload.get("sessions") or [],
        "capacities": payload.get("capacities") or [],
        "lockedAssignments": payload.get("lockedAssignments") or [],
        "settings": {
            "groupLinkedCourses": options.get("group_linked_courses", True),
            "useAutoAvailableBackup": options.get("use_auto_available_backup", True),
            "allowThFallback": options.get("allow_th_fallback", True),
            "capacityStrategy": clean(options.get("capacity_strategy") or "best").lower() or "best",
            # Keep the higher default used for dense sample_1 instances.
            "timeLimitSeconds": float(options.get("time_limit_seconds") or 60),
        },
    }


def convert_result(result):
    assignments = []
    for row in result.get("roomRows", []):
        assignments.append({
            "placementGroupId": row.get("placementGroupId"),
            "courseCodes": row.get("courseCodes"),
            "linkedGroup": row.get("linkedGroup", ""),
            "room": row.get("room"),
            "roomType": row.get("roomType"),
            "capacityMode": row.get("capacityMode"),
            "roomCapacity": row.get("roomCapacity", 0),
            "studentsAssignedToThisRoom": row.get("studentsAssignedToThisRoom", 0),
            "studentsAssignedToThisBlock": row.get("studentsAssignedToThisBlock", row.get("studentsAssignedToThisRoom", 0)),
            "blockTotalAssignedStudentsAtThisTime": row.get("blockTotalAssignedStudentsAtThisTime", row.get("roomTotalAssignedStudentsAtThisTime", 0)),
            "blockRemainingCapacityAtThisTime": row.get("blockRemainingCapacityAtThisTime", row.get("roomRemainingCapacityAtThisTime", 0)),
            "physicalRoomTotalAssignedStudentsAtThisTime": row.get("physicalRoomTotalAssignedStudentsAtThisTime", 0),
            "autoAvailable": row.get("autoAvailable", False),
            "date": row.get("date"),
            "start": row.get("start"),
            "end": row.get("end"),
            "status": row.get("status"),
        })

    return {
        "status": result.get("status", "FEASIBLE"),
        "error": result.get("error"),
        "objective": result.get("summary", {}).get("totalWasteCapacity", 0),
        "assignments": assignments,
        "unassigned": result.get("unassigned", []),
        "results": result.get("results", []),
        "roomRows": result.get("roomRows", []),
        "summary": result.get("summary", {}),
        "validationErrors": result.get("validationErrors", []),
    }


def solve(payload):
    normalized = normalize_payload(payload)
    target = Path(__file__).with_name("auto_room_assignment.py")
    completed = subprocess.run(
        [sys.executable, str(target)],
        input=json.dumps(normalized),
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        emit({
            "status": "ERROR",
            "error": completed.stderr.strip() or f"auto_room_assignment.py failed with code {completed.returncode}",
            "assignments": [],
            "unassigned": [],
        })
    try:
        result = json.loads(completed.stdout or "{}")
    except Exception as exc:
        emit({
            "status": "ERROR",
            "error": completed.stderr.strip() or str(exc),
            "assignments": [],
            "unassigned": [],
        })
    emit(convert_result(result))


if __name__ == "__main__":
    try:
        solve(json.loads(sys.stdin.read() or "{}"))
    except Exception as exc:
        emit({"status": "ERROR", "error": str(exc), "assignments": [], "unassigned": []})
